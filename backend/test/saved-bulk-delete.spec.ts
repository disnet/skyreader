import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import worker from '../src/index';
import * as write from '../src/services/backing/write';
import { runJob, runJobs, MAX_ATTEMPTS, JOB_DELAY_SECONDS, type Job } from '../src/services/jobs';
import { searchNudgeFor } from '../src/services/search-index';

// POST /api/saved/delete: the Library's bulk delete removes every listed save
// from D1 in the request (with its collection places and a backed Library's
// membership), and queues the slow cleanup as jobs.

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const DID = 'did:plc:bulkdelete';
const OTHER_DID = 'did:plc:bulkother';
const SESSION = 'sess-bulk-delete';
const COLLECTION = `at://${DID}/network.cosmik.collection/col1`;
const R1 = '3kbulkdelete01';
const R2 = '3kbulkdelete02';
const R3 = '3kbulkdelete03';
const C1 = '3kbulkcollect1';

async function insertSave(did: string, rkey: string) {
  const url = `https://example.com/${rkey}`;
  await env.DB.prepare(
    `INSERT INTO saved_articles (user_did, rkey, url, url_normalized, url_key, content_type, saved_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'webpage', ?, ?)`
  )
    .bind(did, rkey, url, url, url, Date.now(), Date.now())
    .run();
}

async function remaining(did = DID): Promise<string[]> {
  const rows = await env.DB.prepare(
    'SELECT rkey FROM saved_articles WHERE user_did = ? ORDER BY rkey'
  )
    .bind(did)
    .all<{ rkey: string }>();
  return rows.results.map((r) => r.rkey);
}

async function call(body: unknown, opts: { auth?: boolean } = {}) {
  const headers: Record<string, string> = {
    Origin: env.FRONTEND_URL,
    'Content-Type': 'application/json',
  };
  if (opts.auth !== false) headers.Cookie = `session_id=${SESSION}`;
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new IncomingRequest('http://localhost/api/saved/delete', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let sent: Job[] = [];

describe('POST /api/saved/delete', () => {
  beforeEach(async () => {
    for (const table of [
      'saved_articles',
      'saved_files',
      'shelf_collection_items',
      'shelf_collections',
      'backed_collection_members',
      'backed_unsave_tombstones',
      'user_settings',
      'sessions',
      'users',
    ]) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
    await env.DB.prepare(
      `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, 'bulk.test', 'https://pds.test', 'free', unixepoch())`
    )
      .bind(DID)
      .run();
    await env.DB.prepare(
      `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at)
       VALUES (?, ?, 'bulk.test', 'https://pds.test', 'tok', 'rtok', ?, ?)`
    )
      .bind(SESSION, DID, JSON.stringify({ kty: 'EC' }), Date.now() + 3_600_000)
      .run();
    sent = [];
    vi.spyOn(env.JOBS, 'sendBatch').mockImplementation(async (messages) => {
      for (const m of messages) sent.push(m.body as Job);
      return undefined as never;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('deletes the listed saves and their collection places, and queues their cleanup', async () => {
    for (const r of [R1, R2, R3]) await insertSave(DID, r);
    await insertSave(OTHER_DID, R1);
    await env.DB.prepare(
      `INSERT INTO shelf_collections (user_did, id, name, position, created_at, updated_at)
       VALUES (?, ?, 'Mine', 0, 1, 1)`
    )
      .bind(DID, C1)
      .run();
    await env.DB.prepare(
      `INSERT INTO shelf_collection_items (user_did, collection_id, saved_rkey, position, added_at)
       SELECT ?, ?, value, key, 0 FROM json_each(?)`
    )
      .bind(DID, C1, JSON.stringify([R1, R3]))
      .run();

    await env.DB.prepare(
      `INSERT INTO saved_files (user_did, rkey, r2_key, mime_type, size, sha256, created_at)
       VALUES (?, ?, 'files/r1', 'application/pdf', 1, 'sha', 0)`
    )
      .bind(DID, R1)
      .run();

    const { status, body } = await call({ rkeys: [R1, R2, R1, '3kbulknotthere'] });

    expect(status).toBe(200);
    expect(body).toEqual({ deleted: 2 });
    expect(await remaining()).toEqual([R3]);
    // Another reader's save under the same rkey is untouched.
    expect(await remaining(OTHER_DID)).toEqual([R1]);
    const items = await env.DB.prepare(
      'SELECT saved_rkey FROM shelf_collection_items WHERE user_did = ?'
    )
      .bind(DID)
      .all<{ saved_rkey: string }>();
    expect(items.results.map((i) => i.saved_rkey)).toEqual([R3]);
    // The file's row goes now, so its space is free; its bytes go in the job.
    const files = await env.DB.prepare('SELECT rkey FROM saved_files WHERE user_did = ?')
      .bind(DID)
      .all();
    expect(files.results).toEqual([]);
    expect(sent).toEqual([
      {
        type: 'saved.cleanup',
        did: DID,
        rkeys: [R1, R2],
        files: [
          {
            rkey: R1,
            ref: { storage: 'r2', r2Key: 'files/r1', blobCid: null, recordUri: null },
          },
        ],
      },
    ]);
    expect(env.JOBS.sendBatch).toHaveBeenCalledWith(expect.any(Array), {
      delaySeconds: JOB_DELAY_SECONDS,
    });
  });

  it('deletes nothing when the jobs queue is unavailable, so the caller retries', async () => {
    await insertSave(DID, R1);
    vi.mocked(env.JOBS.sendBatch).mockRejectedValueOnce(new Error('queue down'));

    expect((await call({ rkeys: [R1] })).status).toBe(503);
    expect(await remaining()).toEqual([R1]);
  });

  it('is safe to repeat: saves already gone are skipped', async () => {
    await insertSave(DID, R1);
    expect((await call({ rkeys: [R1] })).body).toEqual({ deleted: 1 });
    sent = [];

    expect((await call({ rkeys: [R1] })).body).toEqual({ deleted: 0 });
    expect(sent).toEqual([]);
  });

  it('removes a backed Library’s membership, tombstoned, and queues the foreign deletes', async () => {
    await env.DB.prepare(`INSERT INTO user_settings (user_did, backing) VALUES (?, ?)`)
      .bind(DID, `semble:${COLLECTION}`)
      .run();
    for (const r of [R1, R2]) {
      await insertSave(DID, r);
      await env.DB.prepare(
        `INSERT INTO backed_collection_members
           (user_did, external_collection, url_normalized, url, external_provider, external_item_uri, external_link_uri)
         VALUES (?, ?, ?, ?, 'semble', ?, ?)`
      )
        .bind(
          DID,
          COLLECTION,
          `https://example.com/${r}`,
          `https://example.com/${r}`,
          `at://${DID}/network.cosmik.card/${r}`,
          `at://${DID}/network.cosmik.collectionLink/${r}`
        )
        .run();
    }

    const { body } = await call({ rkeys: [R1] });

    expect(body).toEqual({ deleted: 1 });
    const members = await env.DB.prepare(
      'SELECT url_normalized FROM backed_collection_members WHERE user_did = ?'
    )
      .bind(DID)
      .all<{ url_normalized: string }>();
    expect(members.results.map((m) => m.url_normalized)).toEqual([`https://example.com/${R2}`]);
    const tombs = await env.DB.prepare(
      'SELECT url_normalized, created_at FROM backed_unsave_tombstones WHERE user_did = ?'
    )
      .bind(DID)
      .all<{ url_normalized: string; created_at: number }>();
    expect(tombs.results.map((t) => t.url_normalized)).toEqual([`https://example.com/${R1}`]);
    // Held past the poll's 10-minute purge, for as long as the job may retry.
    expect(tombs.results[0].created_at).toBeGreaterThan(Date.now() + 30 * 60_000);
    expect(sent).toContainEqual({
      type: 'backing.removeMembers',
      did: DID,
      provider: 'semble',
      collectionUri: COLLECTION,
      members: [
        {
          linkUri: `at://${DID}/network.cosmik.collectionLink/${R1}`,
          urlNormalized: `https://example.com/${R1}`,
        },
      ],
    });
  });

  it('asks the search index to drop the deleted saves', () => {
    expect(searchNudgeFor('POST', '/api/saved/delete')).toEqual({ reconcileSaved: true });
  });

  it('rejects a bad list, and a caller who is not signed in', async () => {
    expect((await call({ rkeys: [] })).status).toBe(400);
    expect((await call({ rkeys: ['not a key'] })).status).toBe(400);
    expect((await call({ rkeys: Array.from({ length: 501 }, () => R1) })).status).toBe(400);
    expect((await call({ rkeys: [R1] }, { auth: false })).status).toBe(401);
  });
});

describe('jobs', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM saved_articles').run();
    await env.DB.prepare('DELETE FROM saved_files').run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('saved.cleanup takes the stored bytes of a deleted save, never of a live one', async () => {
    await insertSave(DID, R2);
    for (const r of [R1, R2]) await env.SAVED_FILES.put(`files/${r}`, 'bytes');
    const ref = (r: string) => ({
      rkey: r,
      ref: { storage: 'r2' as const, r2Key: `files/${r}`, blobCid: null, recordUri: null },
    });

    await runJob(env, {
      type: 'saved.cleanup',
      did: DID,
      rkeys: [R1, R2],
      files: [ref(R1), ref(R2)],
    });

    expect(await env.SAVED_FILES.head(`files/${R1}`)).toBeNull();
    expect(await env.SAVED_FILES.head(`files/${R2}`)).not.toBeNull();
  });

  it('backing.removeMembers retries while there is no session, keeping its tombstones fresh', async () => {
    await env.DB.prepare('DELETE FROM sessions').run();
    await env.DB.prepare('DELETE FROM backed_unsave_tombstones').run();
    await env.DB.prepare(
      `INSERT INTO backed_unsave_tombstones (user_did, external_collection, url_normalized, created_at)
       VALUES (?, ?, ?, 1)`
    )
      .bind(DID, COLLECTION, `https://example.com/${R1}`)
      .run();
    const remove = vi.spyOn(write, 'removeMember');

    await expect(
      runJob(env, {
        type: 'backing.removeMembers',
        did: DID,
        provider: 'semble',
        collectionUri: COLLECTION,
        members: [
          {
            linkUri: `at://${DID}/network.cosmik.collectionLink/${R1}`,
            urlNormalized: `https://example.com/${R1}`,
          },
        ],
      })
    ).rejects.toThrow();

    expect(remove).not.toHaveBeenCalled();
    const tomb = await env.DB.prepare(
      'SELECT created_at FROM backed_unsave_tombstones WHERE user_did = ?'
    )
      .bind(DID)
      .first<{ created_at: number }>();
    expect(tomb!.created_at).toBeGreaterThan(Date.now() - 60_000);
  });

  it('backing.removeMembers deletes each membership record with a session that may', async () => {
    await env.DB.prepare('DELETE FROM sessions').run();
    await env.DB.prepare(
      `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, client_id, granted_scopes)
       VALUES ('bg', ?, 'bulk.test', 'https://pds.test', 'tok', 'rtok', ?, ?, 'client', 'atproto repo:network.cosmik.collectionLink')`
    )
      .bind(DID, JSON.stringify({ kty: 'EC' }), Date.now() + 3_600_000)
      .run();
    const remove = vi.spyOn(write, 'removeMember').mockResolvedValue();
    const linkUri = (r: string) => `at://${DID}/network.cosmik.collectionLink/${r}`;

    await runJob(env, {
      type: 'backing.removeMembers',
      did: DID,
      provider: 'semble',
      collectionUri: COLLECTION,
      members: [R1, R2].map((r) => ({ linkUri: linkUri(r), urlNormalized: r })),
    });

    expect(remove.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['semble', { linkUri: linkUri(R1) }],
      ['semble', { linkUri: linkUri(R2) }],
    ]);
  });

  it('backing.removeMembers tries every record before failing on one', async () => {
    await env.DB.prepare('DELETE FROM sessions').run();
    await env.DB.prepare(
      `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, client_id, granted_scopes)
       VALUES ('bg', ?, 'bulk.test', 'https://pds.test', 'tok', 'rtok', ?, ?, 'client', 'atproto repo:network.cosmik.collectionLink')`
    )
      .bind(DID, JSON.stringify({ kty: 'EC' }), Date.now() + 3_600_000)
      .run();
    const linkUri = (r: string) => `at://${DID}/network.cosmik.collectionLink/${r}`;
    const remove = vi
      .spyOn(write, 'removeMember')
      .mockRejectedValueOnce(new Error('PDS said no'))
      .mockResolvedValue();

    await expect(
      runJob(env, {
        type: 'backing.removeMembers',
        did: DID,
        provider: 'semble',
        collectionUri: COLLECTION,
        members: [
          { linkUri: 'not a uri', urlNormalized: 'x' },
          ...[R1, R2].map((r) => ({ linkUri: linkUri(r), urlNormalized: r })),
        ],
      })
    ).rejects.toThrow('PDS said no');
    // The bad uri is skipped; the failure on R1 doesn't stop R2.
    expect(remove.mock.calls.map((c) => c[2])).toEqual([
      { linkUri: linkUri(R1) },
      { linkUri: linkUri(R2) },
    ]);
  });

  it('a failing job is retried with backoff, then dropped on its last try', async () => {
    const message = (attempts: number) => ({
      body: { type: 'nope' } as unknown as Job,
      attempts,
      ack: vi.fn(),
      retry: vi.fn(),
    });
    const early = message(1);
    const last = message(MAX_ATTEMPTS);

    await runJobs({ messages: [early, last] } as unknown as MessageBatch<Job>, env);

    expect(early.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(early.ack).not.toHaveBeenCalled();
    expect(last.ack).toHaveBeenCalled();
    expect(last.retry).not.toHaveBeenCalled();
  });
});
