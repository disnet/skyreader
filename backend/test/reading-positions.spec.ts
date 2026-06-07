import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index';
import { getReadKeys } from '../src/routes/reading';
import { handleV2BatchFeedFetch, handleV2BatchDocumentFetch } from '../src/routes/feeds-v2';
import type { Session } from '../src/types';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const TEST_DID = 'did:plc:readingpositions123';
const TEST_SESSION_ID = 'test-session-reading-positions';
const DAY_SECONDS = 24 * 60 * 60;

async function setupTestUser() {
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, ?, ?, 'free', unixepoch())`
  )
    .bind(TEST_DID, 'reading.bsky.social', 'https://test.pds.example')
    .run();

  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      TEST_SESSION_ID,
      TEST_DID,
      'reading.bsky.social',
      'https://test.pds.example',
      'test-access-token',
      'test-refresh-token',
      JSON.stringify({ kty: 'EC' }),
      Date.now() + 3600000
    )
    .run();
}

// Insert a read label with an explicit updated_at (seconds) and readAt (ms),
// so delta/tombstone boundaries are deterministic instead of clock-relative.
async function insertReadLabel(
  itemKey: string,
  opts: {
    updatedAt: number;
    readAtMs?: number;
    rkey?: string;
    label?: string;
    itemType?: string;
    deletedAt?: number;
  }
) {
  const props = JSON.stringify({
    readAt: opts.readAtMs ?? opts.updatedAt * 1000,
    itemUrl: `https://example.com/${itemKey}`,
    itemTitle: `Title for ${itemKey}`,
  });
  await env.DB.prepare(
    `INSERT INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      TEST_DID,
      itemKey,
      opts.itemType ?? 'article',
      opts.label ?? 'read',
      props,
      opts.rkey ?? `rk-${itemKey}`,
      opts.updatedAt,
      opts.updatedAt,
      opts.deletedAt ?? null
    )
    .run();
}

function makeAuthRequest(path: string) {
  return new IncomingRequest(`http://localhost${path}`, {
    method: 'GET',
    headers: {
      Cookie: `session_id=${TEST_SESSION_ID}`,
      Origin: env.FRONTEND_URL,
    },
  });
}

type PositionsResponse = {
  positions: Array<{
    item_guid: string;
    item_type: string;
    read_at: number;
    rkey: string;
    deleted: boolean;
  }>;
  cursor: number;
};

async function getPositions(path: string): Promise<{ status: number; body: PositionsResponse }> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(makeAuthRequest(path), env, ctx);
  await waitOnExecutionContext(ctx);
  const body = (await response.json()) as PositionsResponse;
  return { status: response.status, body };
}

describe('GET /api/reading/positions (forward read delta)', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM item_labels_cache').run();
    await env.DB.prepare('DELETE FROM sessions').run();
    await env.DB.prepare('DELETE FROM users').run();
    await setupTestUser();
  });

  it('returns 401 without auth', async () => {
    const ctx = createExecutionContext();
    const request = new IncomingRequest('http://localhost/api/reading/positions', {
      headers: { Origin: env.FRONTEND_URL },
    });
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(401);
  });

  it('returns a slim payload without item_url/item_title', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertReadLabel('article-a', {
      updatedAt: now - 10,
      readAtMs: 1700000000000,
    });

    const { status, body } = await getPositions('/api/reading/positions?since=0');
    expect(status).toBe(200);
    expect(body.positions).toHaveLength(1);

    const pos = body.positions[0];
    expect(pos.item_guid).toBe('article-a');
    expect(pos.item_type).toBe('article');
    expect(pos.read_at).toBe(1700000000000);
    expect(pos.rkey).toBe('rk-article-a');
    expect(pos.deleted).toBe(false);
    // url/title are stored but must not be sent over the wire
    expect(pos).not.toHaveProperty('item_url');
    expect(pos).not.toHaveProperty('item_title');
  });

  it('returns article AND document read labels, but not starred/archived/share', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertReadLabel('read-article', { updatedAt: now - 10 });
    await insertReadLabel('at://doc-uri', { updatedAt: now - 10, itemType: 'document' });
    await insertReadLabel('starred-article', { updatedAt: now - 10, label: 'starred' });
    await insertReadLabel('archived-article', { updatedAt: now - 10, label: 'archived' });
    // Legacy share read labels (the share system is gone) must be excluded.
    await insertReadLabel('at://share-uri', { updatedAt: now - 10, itemType: 'share' });

    const { body } = await getPositions('/api/reading/positions?since=0');
    expect(body.positions.map((p) => p.item_guid).sort()).toEqual(['at://doc-uri', 'read-article']);
    const doc = body.positions.find((p) => p.item_guid === 'at://doc-uri');
    expect(doc?.item_type).toBe('document');
  });

  it('returns the max updated_at as the cursor', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertReadLabel('older', { updatedAt: now - 100 });
    await insertReadLabel('newer', { updatedAt: now - 5 });

    const { body } = await getPositions('/api/reading/positions?since=0');
    expect(body.cursor).toBe(now - 5);
  });

  it('returns positions ordered newest-first', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertReadLabel('oldest', { updatedAt: now - 300 });
    await insertReadLabel('middle', { updatedAt: now - 200 });
    await insertReadLabel('newest', { updatedAt: now - 100 });

    const { body } = await getPositions('/api/reading/positions?since=0');
    expect(body.positions.map((p) => p.item_guid)).toEqual(['newest', 'middle', 'oldest']);
  });

  describe('delta (?since=)', () => {
    it('returns only rows changed strictly after the cursor', async () => {
      const now = Math.floor(Date.now() / 1000);
      await insertReadLabel('at-cursor', { updatedAt: now - 100 });
      await insertReadLabel('after-cursor', { updatedAt: now - 50 });

      const { body } = await getPositions(`/api/reading/positions?since=${now - 100}`);
      expect(body.positions.map((p) => p.item_guid)).toEqual(['after-cursor']);
      expect(body.cursor).toBe(now - 50);
    });

    it('has no retention window — even very old rows sync once changed past the cursor', async () => {
      const veryOld = Math.floor(Date.now() / 1000) - 5 * 365 * DAY_SECONDS;
      await insertReadLabel('old-but-changed', { updatedAt: veryOld });

      const { body } = await getPositions(`/api/reading/positions?since=${veryOld - 1}`);
      expect(body.positions.map((p) => p.item_guid)).toEqual(['old-but-changed']);
    });

    it('returns an empty delta with the cursor unchanged when nothing is newer', async () => {
      const now = Math.floor(Date.now() / 1000);
      await insertReadLabel('existing', { updatedAt: now - 100 });

      const { body } = await getPositions(`/api/reading/positions?since=${now}`);
      expect(body.positions).toHaveLength(0);
      expect(body.cursor).toBe(now);
    });
  });

  describe('tombstones (cross-device un-read)', () => {
    it('returns soft-deleted rows with deleted=true so the client can remove them', async () => {
      const now = Math.floor(Date.now() / 1000);
      await insertReadLabel('unread-elsewhere', {
        updatedAt: now - 5,
        deletedAt: now - 5,
      });

      const { body } = await getPositions(`/api/reading/positions?since=${now - 10}`);
      expect(body.positions).toHaveLength(1);
      expect(body.positions[0].item_guid).toBe('unread-elsewhere');
      expect(body.positions[0].deleted).toBe(true);
    });
  });
});

describe('POST /api/reading/mark-unread (soft-delete)', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM item_labels_cache').run();
    await env.DB.prepare('DELETE FROM sessions').run();
    await env.DB.prepare('DELETE FROM users').run();
    await setupTestUser();
  });

  async function postJson(path: string, body: unknown) {
    const ctx = createExecutionContext();
    const request = new IncomingRequest(`http://localhost${path}`, {
      method: 'POST',
      headers: {
        Cookie: `session_id=${TEST_SESSION_ID}`,
        Origin: env.FRONTEND_URL,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }

  it('tombstones the row instead of hard-deleting it', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertReadLabel('article-x', { updatedAt: now - 100 });

    const res = await postJson('/api/reading/mark-unread', { itemGuid: 'article-x' });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT deleted_at FROM item_labels_cache WHERE user_did = ? AND item_key = ? AND label = 'read'"
    )
      .bind(TEST_DID, 'article-x')
      .first<{ deleted_at: number | null }>();
    expect(row).not.toBeNull();
    expect(row?.deleted_at).not.toBeNull();
  });

  it('re-read resurrects a tombstoned row (deleted_at cleared)', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertReadLabel('article-y', { updatedAt: now - 100, deletedAt: now - 100 });

    const res = await postJson('/api/reading/mark-read', {
      itemGuid: 'article-y',
      itemUrl: 'https://example.com/y',
    });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT deleted_at FROM item_labels_cache WHERE user_did = ? AND item_key = ? AND label = 'read'"
    )
      .bind(TEST_DID, 'article-y')
      .first<{ deleted_at: number | null }>();
    expect(row?.deleted_at).toBeNull();
  });
});

describe('POST /api/reading write path (documents, resurrect, skip)', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM item_labels_cache').run();
    await env.DB.prepare('DELETE FROM sessions').run();
    await env.DB.prepare('DELETE FROM users').run();
    await setupTestUser();
  });

  async function postJson(path: string, body: unknown) {
    const ctx = createExecutionContext();
    const request = new IncomingRequest(`http://localhost${path}`, {
      method: 'POST',
      headers: {
        Cookie: `session_id=${TEST_SESSION_ID}`,
        Origin: env.FRONTEND_URL,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }

  function readRow(itemKey: string) {
    return env.DB.prepare(
      "SELECT item_type, rkey, props, deleted_at FROM item_labels_cache WHERE user_did = ? AND item_key = ? AND label = 'read'"
    )
      .bind(TEST_DID, itemKey)
      .first<{ item_type: string; rkey: string; props: string; deleted_at: number | null }>();
  }

  // mark-read with itemType:'document' must store the document shape — item_type
  // column and the rkey/authorDid the old social path carried in props — so the
  // unified writer is a true drop-in for the deleted social-reading writer.
  it('mark-read stores a document row with item_type, rkey and authorDid', async () => {
    const res = await postJson('/api/reading/mark-read', {
      itemGuid: 'at://did:plc:author/app/doc1',
      itemType: 'document',
      rkey: 'doc-rkey-1',
      authorDid: 'did:plc:author',
      itemUrl: 'https://example.com/doc1',
      itemTitle: 'Doc One',
    });
    expect(res.status).toBe(200);

    const row = await readRow('at://did:plc:author/app/doc1');
    expect(row?.item_type).toBe('document');
    expect(row?.rkey).toBe('doc-rkey-1');
    expect(row?.deleted_at).toBeNull();
    expect(JSON.parse(row!.props)).toMatchObject({
      authorDid: 'did:plc:author',
      itemUrl: 'https://example.com/doc1',
      itemTitle: 'Doc One',
    });
  });

  // The positive skip: a LIVE read short-circuits as alreadyRead and is left
  // untouched (the complement of the existing resurrect-a-tombstone test).
  it('mark-read on a live row returns alreadyRead and does not rewrite it', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertReadLabel('article-live', { updatedAt: now - 100, rkey: 'original-rkey' });

    const res = await postJson('/api/reading/mark-read', {
      itemGuid: 'article-live',
      itemUrl: 'https://example.com/changed',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ alreadyRead: true });

    // rkey/props untouched — the handler returned before any write.
    const row = await readRow('article-live');
    expect(row?.rkey).toBe('original-rkey');
  });

  it('bulk mark-read resurrects a tombstoned row but skips a live one', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertReadLabel('live-guid', { updatedAt: now - 100, rkey: 'live-rkey' });
    await insertReadLabel('tombstoned-guid', {
      updatedAt: now - 100,
      deletedAt: now - 100,
      rkey: 'old-rkey',
    });

    const res = await postJson('/api/reading/mark-read-bulk', {
      items: [
        { itemGuid: 'live-guid' },
        { itemGuid: 'tombstoned-guid', rkey: 'new-rkey' },
      ],
    });
    expect(res.status).toBe(200);
    // Only the tombstoned item is "new" (the live one is filtered out by the
    // deleted_at IS NULL existing-check), so exactly one row is marked and the
    // live one is skipped.
    const body = (await res.json()) as { marked: number; skipped: number };
    expect(body.marked).toBe(1);
    expect(body.skipped).toBe(1);

    // The tombstone resurrected (deleted_at cleared, rkey updated)...
    const resurrected = await readRow('tombstoned-guid');
    expect(resurrected?.deleted_at).toBeNull();
    expect(resurrected?.rkey).toBe('new-rkey');
    // ...and the live row is unchanged.
    const live = await readRow('live-guid');
    expect(live?.rkey).toBe('live-rkey');
    expect(live?.deleted_at).toBeNull();
  });

  it('bulk mark-read stores documents with item_type and authorDid', async () => {
    const res = await postJson('/api/reading/mark-read-bulk', {
      items: [
        {
          itemGuid: 'at://did:plc:a/app/d1',
          itemType: 'document',
          rkey: 'rk1',
          authorDid: 'did:plc:a',
        },
      ],
    });
    expect(res.status).toBe(200);

    const row = await readRow('at://did:plc:a/app/d1');
    expect(row?.item_type).toBe('document');
    expect(JSON.parse(row!.props).authorDid).toBe('did:plc:a');
  });
});

// The read join that rides the feed/document batch response (the core of the
// inline-annotation path). Exercised directly here, then end-to-end through the
// handlers below.
describe('getReadKeys (annotation join)', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM item_labels_cache').run();
    await env.DB.prepare('DELETE FROM sessions').run();
    await env.DB.prepare('DELETE FROM users').run();
    await setupTestUser();
  });

  it('returns only the keys with a live read label, scoped to item_type', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertReadLabel('read-1', { updatedAt: now });
    await insertReadLabel('read-2', { updatedAt: now });
    // Different type / label / a key not queried — none should come back.
    await insertReadLabel('at://doc', { updatedAt: now, itemType: 'document' });
    await insertReadLabel('starred-1', { updatedAt: now, label: 'starred' });

    const keys = await getReadKeys(env, TEST_DID, 'article', [
      'read-1',
      'read-2',
      'at://doc',
      'starred-1',
      'never-read',
    ]);
    expect([...keys].sort()).toEqual(['read-1', 'read-2']);
  });

  it('scopes documents separately from articles', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertReadLabel('at://doc-read', { updatedAt: now, itemType: 'document' });
    await insertReadLabel('article-read', { updatedAt: now, itemType: 'article' });

    const docKeys = await getReadKeys(env, TEST_DID, 'document', [
      'at://doc-read',
      'article-read',
    ]);
    expect([...docKeys]).toEqual(['at://doc-read']);
  });

  it('excludes tombstoned (un-read) rows so a re-fetched item is not re-annotated read', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertReadLabel('live', { updatedAt: now });
    await insertReadLabel('tombstoned', { updatedAt: now, deletedAt: now });

    const keys = await getReadKeys(env, TEST_DID, 'article', ['live', 'tombstoned']);
    expect([...keys]).toEqual(['live']);
  });

  it('does not leak other users’ reads', async () => {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES ('did:plc:other', 'other.bsky.social', 'https://test.pds.example', 'free', unixepoch())`
    ).run();
    await env.DB.prepare(
      `INSERT INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, created_at, updated_at)
       VALUES ('did:plc:other', 'shared-guid', 'article', 'read', '{}', 'rk', ?, ?)`
    )
      .bind(now, now)
      .run();

    const keys = await getReadKeys(env, TEST_DID, 'article', ['shared-guid']);
    expect(keys.size).toBe(0);
  });

  it('short-circuits on an empty key list without touching the DB', async () => {
    const keys = await getReadKeys(env, TEST_DID, 'article', []);
    expect(keys.size).toBe(0);
  });
});

describe('inline read annotation (batch fetch handlers)', () => {
  const SESSION = { did: TEST_DID } as Session;
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM item_labels_cache').run();
    await env.DB.prepare('DELETE FROM sessions').run();
    await env.DB.prepare('DELETE FROM users').run();
    await setupTestUser();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function proxyResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function batchRequest(path: string, body: unknown): Request {
    return new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('stamps read onto feed items the user has a live read label for', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertReadLabel('guid-read', { updatedAt: now });
    await insertReadLabel('guid-tombstoned', { updatedAt: now, deletedAt: now });

    const url = 'https://example.com/feed.xml';
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      proxyResponse({
        feeds: {
          [url]: {
            feed: {
              title: 'Feed',
              items: [
                { guid: 'guid-read', title: 'A', publishedAt: '2026-01-01' },
                { guid: 'guid-unread', title: 'B', publishedAt: '2026-01-02' },
                { guid: 'guid-tombstoned', title: 'C', publishedAt: '2026-01-03' },
              ],
            },
          },
        },
      })
    );

    const res = await handleV2BatchFeedFetch(batchRequest('/api/v2/feeds/batch', { feeds: [{ url }] }), env, SESSION);
    const json = (await res.json()) as {
      feeds: Record<string, { items: Array<{ guid: string; read?: boolean }> }>;
      readCursor?: number;
    };

    const byGuid = Object.fromEntries(json.feeds[url].items.map((i) => [i.guid, i.read]));
    expect(byGuid['guid-read']).toBe(true);
    expect(byGuid['guid-unread']).toBe(false);
    // Tombstoned (un-read elsewhere) must not be re-annotated read.
    expect(byGuid['guid-tombstoned']).toBe(false);
    // Cursor is seeded from server time so the client's forward delta starts here.
    expect(typeof json.readCursor).toBe('number');
  });

  it('stamps read onto documents keyed by recordUri', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertReadLabel('at://did:plc:a/doc/read', { updatedAt: now, itemType: 'document' });

    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      proxyResponse({
        authors: [
          {
            did: 'did:plc:a',
            status: 'ready',
            documents: [
              { recordUri: 'at://did:plc:a/doc/read', createdAt: '2026-01-01' },
              { recordUri: 'at://did:plc:a/doc/unread', createdAt: '2026-01-02' },
            ],
          },
        ],
      })
    );

    const res = await handleV2BatchDocumentFetch(
      batchRequest('/api/v2/documents/batch', { documents: [{ did: 'did:plc:a' }] }),
      env,
      SESSION
    );
    const json = (await res.json()) as {
      authors: Array<{ documents: Array<{ recordUri: string; read?: boolean }> }>;
      readCursor?: number;
    };

    const docs = json.authors[0].documents;
    expect(docs.find((d) => d.recordUri.endsWith('/read'))?.read).toBe(true);
    expect(docs.find((d) => d.recordUri.endsWith('/unread'))?.read).toBe(false);
    expect(typeof json.readCursor).toBe('number');
  });
});
