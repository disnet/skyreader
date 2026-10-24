import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index';
import * as read from '../src/services/backing/read';
import * as write from '../src/services/backing/write';
import * as sync from '../src/services/backing/sync';
import * as roomSync from '../src/services/backing/room-sync';
import { PDSClient } from '../src/services/pds-client';
import { normalizeArticleUrl } from '../src/utils/url-normalize';
import { GRANULAR_SCOPES, MARGIN_SCOPES, SEMBLE_SCOPES } from '../src/config/scopes';

// Linked Shelf collections (services/shelf-link.ts, routes/shelf.ts): a Shelf
// collection kept in step with one of the reader's Semble/Margin collections.
// The foreign side is a fake `remote` list behind the snapshot and write spies,
// so each test reads as "change one side, sync, look at the other".

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const DID = 'did:plc:shelflink';
const SESSION = 'sess-shelf-link';
const C1 = '3kshelflink0001';
const C2 = '3kshelflink0002';
const MARGIN_COLLECTION = `at://${DID}/at.margin.collection/mcol1`;
const SEMBLE_COLLECTION = `at://${DID}/network.cosmik.collection/scol1`;
const ALL_SCOPES = `${GRANULAR_SCOPES} ${SEMBLE_SCOPES.join(' ')} ${MARGIN_SCOPES.join(' ')}`;

interface RemoteMember {
  linkUri: string;
  itemUri: string;
  url: string;
  title?: string;
}

let remote: RemoteMember[] = [];
let snapshotComplete = true;
let nextRemoteId = 0;

function remoteMember(url: string, title?: string): RemoteMember {
  nextRemoteId++;
  return {
    linkUri: `at://${DID}/at.margin.collectionItem/link${nextRemoteId}`,
    itemUri: `at://${DID}/at.margin.note/note${nextRemoteId}`,
    url,
    title,
  };
}

function fakeRemote() {
  const snapshot = vi
    .spyOn(read, 'snapshotBackedCollection')
    .mockImplementation(async (_provider, _did, _uri, opts = {}) => {
      const skip = opts.skipLinks ?? new Set<string>();
      const members = remote
        .filter((m) => !skip.has(m.linkUri))
        .map((m) => ({
          url: m.url,
          urlNormalized: normalizeArticleUrl(m.url)!,
          itemUri: m.itemUri,
          linkUri: m.linkUri,
          itemType: 'at.margin.note',
          title: m.title,
        }));
      return {
        complete: snapshotComplete,
        members,
        skipped: [],
        typeMix: {},
        listed: remote.map((m) => m.linkUri),
        listingComplete: true,
      };
    });
  const createMember = vi
    .spyOn(write, 'createMember')
    .mockImplementation(async (_pds, _did, _provider, _uri, input) => {
      const m = remoteMember(input.url, input.title);
      remote.push(m);
      return { itemUri: m.itemUri, linkUri: m.linkUri };
    });
  const removeMember = vi
    .spyOn(write, 'removeMember')
    .mockImplementation(async (_pds, _provider, handles) => {
      remote = remote.filter((m) => m.linkUri !== handles.linkUri);
    });
  vi.spyOn(sync, 'extractMissingBackedContent').mockResolvedValue(0);
  // The collection record itself: there unless a test deletes it.
  const lookup = vi.spyOn(roomSync, 'lookupCollection').mockResolvedValue({
    ok: true,
    collection: {
      ref: { did: DID, collection: 'at.margin.collection', rkey: 'mcol1' },
      provider: 'margin',
      record: {},
      cid: 'bafy',
    },
  });
  return { snapshot, createMember, removeMember, lookup };
}

async function reset(scopes = ALL_SCOPES) {
  for (const table of [
    'shelf_link_members',
    'shelf_collection_items',
    'shelf_collections',
    'saved_articles',
  ]) {
    await env.DB.prepare(`DELETE FROM ${table} WHERE user_did = ?`).bind(DID).run();
  }
  await env.DB.prepare('DELETE FROM user_settings WHERE user_did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM sessions WHERE did = ?').bind(DID).run();
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at)
     VALUES (?, 'link.bsky.social', 'https://pds.test', 'free', unixepoch())
     ON CONFLICT(did) DO NOTHING`
  )
    .bind(DID)
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
     VALUES (?, ?, 'link.bsky.social', 'https://pds.test', 'tok', 'rtok', ?, ?, ?)`
  )
    .bind(SESSION, DID, JSON.stringify({ kty: 'EC' }), Date.now() + 3_600_000, scopes)
    .run();
  remote = [];
  snapshotComplete = true;
}

async function call(method: string, path: string, body?: unknown) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new IncomingRequest(`http://localhost${path}`, {
      method,
      headers: {
        Cookie: `session_id=${SESSION}`,
        Origin: env.FRONTEND_URL,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function save(rkey: string, url: string, source = 'url') {
  await env.DB.prepare(
    `INSERT INTO saved_articles (user_did, rkey, record_uri, url, url_normalized, title, source, saved_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      DID,
      rkey,
      `at://${DID}/app.skyreader.feed.saved/${rkey}`,
      url,
      url ? normalizeArticleUrl(url) : null,
      `Title ${rkey}`,
      source,
      Date.now(),
      Date.now()
    )
    .run();
}

async function members(id = C1): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT saved_rkey FROM shelf_collection_items WHERE user_did = ? AND collection_id = ?
      ORDER BY position`
  )
    .bind(DID, id)
    .all<{ saved_rkey: string }>();
  return rows.results.map((r) => r.saved_rkey);
}

const remoteUrls = () => remote.map((m) => m.url).sort();

async function createCollection(id = C1, name = 'Papers') {
  const { status } = await call('POST', '/api/shelf/collections', { id, name });
  expect(status).toBe(200);
}

async function link(collectionUri = MARGIN_COLLECTION, provider = 'margin', id = C1) {
  return call('PUT', `/api/shelf/collections/${id}/link`, { provider, collectionUri });
}

/** Push the sync gate out of the way, as if a minute had passed. */
async function age(id = C1) {
  await env.DB.prepare(
    'UPDATE shelf_collections SET link_synced_at = 0 WHERE user_did = ? AND id = ?'
  )
    .bind(DID, id)
    .run();
}

describe('linking a Shelf collection', () => {
  beforeEach(() => reset());
  afterEach(() => vi.restoreAllMocks());

  it('brings the foreign members in as saves and writes the Shelf members out', async () => {
    const { createMember } = fakeRemote();
    await save('3ksavedlink001', 'https://a.example/one');
    await save('3ksavedlink002', 'https://b.example/two');
    await createCollection();
    await call('POST', `/api/shelf/collections/${C1}/items`, {
      rkeys: ['3ksavedlink001', '3ksavedlink002'],
    });
    // Already over there: one of ours, and one we don't have.
    remote.push(
      remoteMember('https://a.example/one'),
      remoteMember('https://c.example/three', 'Three')
    );

    const { status, body } = await link();
    expect(status).toBe(200);
    expect(body.link).toMatchObject({ provider: 'margin', uri: MARGIN_COLLECTION });
    expect(body.sync).toMatchObject({ synced: true, imported: 1, pushed: 1, pending: 0 });

    // b.example went over; a.example wasn't written twice.
    expect(createMember).toHaveBeenCalledTimes(1);
    expect(remoteUrls()).toEqual([
      'https://a.example/one',
      'https://b.example/two',
      'https://c.example/three',
    ]);
    // c.example became a save, at the end of the collection.
    const imported = await env.DB.prepare(
      'SELECT rkey, title FROM saved_articles WHERE user_did = ? AND url = ?'
    )
      .bind(DID, 'https://c.example/three')
      .first<{ rkey: string; title: string }>();
    expect(imported?.title).toBe('Three');
    expect(await members()).toEqual(['3ksavedlink001', '3ksavedlink002', imported!.rkey]);

    const list = await call('GET', '/api/shelf/collections');
    expect(list.body.collections[0].link).toMatchObject({
      provider: 'margin',
      uri: MARGIN_COLLECTION,
    });
  });

  it('leaves uploads native-only', async () => {
    const { createMember } = fakeRemote();
    await save('3ksavedupld001', '', 'upload');
    await createCollection();
    await call('POST', `/api/shelf/collections/${C1}/items`, { rkey: '3ksavedupld001' });
    const { body } = await link();
    expect(body.sync).toMatchObject({ pushed: 0, pending: 0 });
    expect(createMember).not.toHaveBeenCalled();
    expect(await members()).toEqual(['3ksavedupld001']);
  });

  it('creates a collection named after the Shelf collection when none is given', async () => {
    fakeRemote();
    vi.spyOn(write, 'listCollectionNames').mockResolvedValue(['Papers']);
    const created = vi
      .spyOn(write, 'createCollection')
      .mockResolvedValue({ uri: `at://${DID}/at.margin.collection/fresh` });
    await createCollection();
    const { status, body } = await call('PUT', `/api/shelf/collections/${C1}/link`, {
      provider: 'margin',
    });
    expect(status).toBe(200);
    expect(created.mock.calls[0][2]).toBe('Papers 2');
    expect(body.link.uri).toBe(`at://${DID}/at.margin.collection/fresh`);
  });

  it("refuses someone else's collection, a mismatched provider, and the Library's backing", async () => {
    fakeRemote();
    await createCollection();
    expect((await link('at://did:plc:someoneelse/at.margin.collection/x')).status).toBe(400);
    expect((await link(SEMBLE_COLLECTION, 'margin')).status).toBe(400);

    await env.DB.prepare(
      `INSERT INTO user_settings (user_did, backing) VALUES (?, ?)
       ON CONFLICT(user_did) DO UPDATE SET backing = excluded.backing`
    )
      .bind(DID, `margin:${MARGIN_COLLECTION}`)
      .run();
    expect((await link()).status).toBe(409);
  });

  it('refuses a second Shelf collection on the same foreign collection', async () => {
    fakeRemote();
    await createCollection(C1, 'One');
    await createCollection(C2, 'Two');
    expect((await link(MARGIN_COLLECTION, 'margin', C1)).status).toBe(200);
    expect((await link(MARGIN_COLLECTION, 'margin', C2)).status).toBe(409);
  });

  it('needs the provider permission', async () => {
    await reset(GRANULAR_SCOPES);
    await createCollection();
    const { status, body } = await link();
    expect(status).toBe(403);
    expect(body.error).toBe('scope_upgrade_required');
  });
});

describe('keeping a linked collection in step', () => {
  beforeEach(async () => {
    await reset();
    fakeRemote();
    await save('3ksavedlink001', 'https://a.example/one');
    await save('3ksavedlink002', 'https://b.example/two');
    await createCollection();
    await call('POST', `/api/shelf/collections/${C1}/items`, { rkey: '3ksavedlink001' });
    await link();
    expect(remoteUrls()).toEqual(['https://a.example/one']);
  });
  afterEach(() => vi.restoreAllMocks());

  it('writes an add here over there', async () => {
    await call('POST', `/api/shelf/collections/${C1}/items`, { rkey: '3ksavedlink002' });
    expect(remoteUrls()).toEqual(['https://a.example/one', 'https://b.example/two']);
  });

  it('deletes the membership record for a removal here, never the item', async () => {
    const removeMember = vi.mocked(write.removeMember);
    await call('DELETE', `/api/shelf/collections/${C1}/items/3ksavedlink001`);
    expect(remoteUrls()).toEqual([]);
    expect(removeMember).toHaveBeenCalledTimes(1);
    expect(removeMember.mock.calls[0][2].linkUri).toMatch(/collectionItem/);
  });

  it('deletes it over there when the save itself is deleted', async () => {
    await call('DELETE', '/api/saved/3ksavedlink001');
    expect(remoteUrls()).toEqual([]);
  });

  it('brings in an add made over there on the next sync', async () => {
    remote.push(remoteMember('https://d.example/four'));
    await age();
    const { body } = await call('POST', `/api/shelf/collections/${C1}/sync`, {});
    expect(body).toMatchObject({ synced: true, imported: 1 });
    expect((await members()).length).toBe(2);
  });

  it('takes out a removal made over there, keeping the save', async () => {
    remote = [];
    await age();
    const { body } = await call('POST', `/api/shelf/collections/${C1}/sync`, {});
    expect(body).toMatchObject({ synced: true, removed: 1 });
    expect(await members()).toEqual([]);
    const kept = await env.DB.prepare(
      'SELECT 1 FROM saved_articles WHERE user_did = ? AND rkey = ?'
    )
      .bind(DID, '3ksavedlink001')
      .first();
    expect(kept).not.toBeNull();
    // ...and doesn't write it back next time.
    await age();
    await call('POST', `/api/shelf/collections/${C1}/sync`, {});
    expect(remoteUrls()).toEqual([]);
  });

  it('a removal over there of an article also added here again is honored once', async () => {
    // The record we wrote goes, and a different one for the same article stays:
    // the article is still there, so it stays here.
    const first = remote[0];
    remote = [remoteMember(first.url)];
    await age();
    const { body } = await call('POST', `/api/shelf/collections/${C1}/sync`, {});
    expect(body).toMatchObject({ removed: 0, imported: 0, pushed: 0 });
    expect(await members()).toEqual(['3ksavedlink001']);
  });

  it("doesn't write anything on a short snapshot, where a record may be hidden", async () => {
    snapshotComplete = false;
    await env.DB.prepare(
      `INSERT INTO shelf_collection_items (user_did, collection_id, saved_rkey, position, added_at)
       VALUES (?, ?, ?, 5, 0)`
    )
      .bind(DID, C1, '3ksavedlink002')
      .run();
    await age();
    const { body } = await call('POST', `/api/shelf/collections/${C1}/sync`, {});
    expect(body).toMatchObject({ synced: true, pushed: 0, pending: 1, complete: false });
    expect(remoteUrls()).toEqual(['https://a.example/one']);
  });

  it('gates a settled link, and syncs past the gate when asked', async () => {
    const gated = await call('POST', `/api/shelf/collections/${C1}/sync`, {});
    expect(gated.body).toMatchObject({ synced: false, reason: 'gated' });
    const forced = await call('POST', `/api/shelf/collections/${C1}/sync`, { force: true });
    expect(forced.body).toMatchObject({ synced: true });
  });

  it('unlinking leaves both sides as they are', async () => {
    const removeMember = vi.mocked(write.removeMember);
    const { status } = await call('DELETE', `/api/shelf/collections/${C1}/link`);
    expect(status).toBe(200);
    expect(remoteUrls()).toEqual(['https://a.example/one']);
    expect(await members()).toEqual(['3ksavedlink001']);
    expect(removeMember).not.toHaveBeenCalled();
    // ...and nothing syncs after.
    await call('POST', `/api/shelf/collections/${C1}/items`, { rkey: '3ksavedlink002' });
    expect(remoteUrls()).toEqual(['https://a.example/one']);
    const list = await call('GET', '/api/shelf/collections');
    expect(list.body.collections[0].link).toBeNull();
  });

  it('deleting the Shelf collection leaves the foreign one alone', async () => {
    await call('DELETE', `/api/shelf/collections/${C1}`);
    expect(remoteUrls()).toEqual(['https://a.example/one']);
    const baseline = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM shelf_link_members WHERE user_did = ?'
    )
      .bind(DID)
      .first<{ n: number }>();
    expect(baseline?.n).toBe(0);
  });

  it('retries a failed write on the next sync', async () => {
    vi.mocked(write.createMember).mockRejectedValueOnce(new Error('PDS down'));
    await call('POST', `/api/shelf/collections/${C1}/items`, { rkey: '3ksavedlink002' });
    expect(remoteUrls()).toEqual(['https://a.example/one']);
    // A write that made no progress waits for the gate rather than retrying on
    // every request.
    const gated = await call('POST', `/api/shelf/collections/${C1}/sync`, {});
    expect(gated.body).toMatchObject({ synced: false, reason: 'gated' });
    await age();
    const { body } = await call('POST', `/api/shelf/collections/${C1}/sync`, {});
    expect(body).toMatchObject({ synced: true, pushed: 1, pending: 0 });
    expect(remoteUrls()).toEqual(['https://a.example/one', 'https://b.example/two']);
  });

  it('unlinks, rather than emptying the Shelf collection, when the other one is deleted', async () => {
    remote = [];
    vi.mocked(roomSync.lookupCollection).mockResolvedValue({ ok: false, reason: 'not-found' });
    await age();
    const { body } = await call('POST', `/api/shelf/collections/${C1}/sync`, {});
    expect(body).toMatchObject({ synced: true, removed: 0 });
    expect(await members()).toEqual(['3ksavedlink001']);
    const list = await call('GET', '/api/shelf/collections');
    expect(list.body.collections[0].link).toBeNull();
  });

  it("doesn't save an article twice when the save predates its join key", async () => {
    // A native save made after linking carries no url_normalized.
    await env.DB.prepare(
      `INSERT INTO saved_articles (user_did, rkey, record_uri, url, url_normalized, title, source, saved_at, created_at)
       VALUES (?, '3ksavedlink009', 'at://x/y/z', 'https://e.example/five', NULL, 'Five', 'url', 1, 1)`
    )
      .bind(DID)
      .run();
    remote.push(remoteMember('https://e.example/five'));
    await age();
    await call('POST', `/api/shelf/collections/${C1}/sync`, {});
    const rows = await env.DB.prepare(
      `SELECT rkey FROM saved_articles WHERE user_did = ? AND url = 'https://e.example/five'`
    )
      .bind(DID)
      .all<{ rkey: string }>();
    expect(rows.results.map((r) => r.rkey)).toEqual(['3ksavedlink009']);
    expect(await members()).toEqual(['3ksavedlink001', '3ksavedlink009']);
  });

  it('keeps the collection on a retried link with nothing named', async () => {
    const created = vi.spyOn(write, 'createCollection');
    const { status, body } = await call('PUT', `/api/shelf/collections/${C1}/link`, {
      provider: 'margin',
    });
    expect(status).toBe(200);
    expect(body.link.uri).toBe(MARGIN_COLLECTION);
    expect(created).not.toHaveBeenCalled();
  });

  it('a run that lost its lock to an unlink writes nothing more', async () => {
    // Unlink lands while the snapshot is being taken.
    vi.mocked(read.snapshotBackedCollection).mockImplementationOnce(async () => {
      await env.DB.prepare(
        'UPDATE shelf_collections SET link_uri = NULL, link_provider = NULL WHERE id = ?'
      )
        .bind(C1)
        .run();
      return {
        complete: true,
        members: [],
        skipped: [],
        typeMix: {},
        listed: remote.map((m) => m.linkUri),
        listingComplete: true,
      };
    });
    await env.DB.prepare(
      `INSERT INTO shelf_collection_items (user_did, collection_id, saved_rkey, position, added_at)
       VALUES (?, ?, '3ksavedlink002', 5, 0)`
    )
      .bind(DID, C1)
      .run();
    await call('POST', `/api/shelf/collections/${C1}/sync`, { force: true });
    expect(remoteUrls()).toEqual(['https://a.example/one']);
  });

  it('refuses to back the Library with a linked collection', async () => {
    const { status } = await call('POST', '/api/saved/backing', {
      action: 'enable',
      provider: 'margin',
      collectionUri: MARGIN_COLLECTION,
    });
    expect(status).toBe(409);
  });
});

describe('linking to Semble', () => {
  beforeEach(() => reset());
  afterEach(() => vi.restoreAllMocks());

  it("passes the collection's cid to each write", async () => {
    const { createMember } = fakeRemote();
    vi.spyOn(PDSClient.prototype, 'getRecord').mockResolvedValue({
      success: true,
      data: { uri: SEMBLE_COLLECTION, cid: 'bafycollectioncid', value: {} },
    });
    await save('3ksavedlink001', 'https://a.example/one');
    await createCollection();
    await call('POST', `/api/shelf/collections/${C1}/items`, { rkey: '3ksavedlink001' });
    const { status } = await link(SEMBLE_COLLECTION, 'semble');
    expect(status).toBe(200);
    expect(createMember).toHaveBeenCalledTimes(1);
    expect(createMember.mock.calls[0][5]).toEqual({ collectionCid: 'bafycollectioncid' });
  });
});
