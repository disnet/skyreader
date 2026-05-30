import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const TEST_DID = 'did:plc:readingpositions123';
const TEST_SESSION_ID = 'test-session-reading-positions';
const DAY_SECONDS = 24 * 60 * 60;
const WINDOW_SECONDS = 90 * DAY_SECONDS; // must match READ_POSITIONS_WINDOW_SECONDS

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
// so window/delta boundaries are deterministic instead of clock-relative.
async function insertReadLabel(
  itemKey: string,
  opts: {
    updatedAt: number;
    readAtMs?: number;
    rkey?: string;
    label?: string;
    itemType?: string;
  }
) {
  const props = JSON.stringify({
    readAt: opts.readAtMs ?? opts.updatedAt * 1000,
    itemUrl: `https://example.com/${itemKey}`,
    itemTitle: `Title for ${itemKey}`,
  });
  await env.DB.prepare(
    `INSERT INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      TEST_DID,
      itemKey,
      opts.itemType ?? 'article',
      opts.label ?? 'read',
      props,
      opts.rkey ?? `rk-${itemKey}`,
      opts.updatedAt,
      opts.updatedAt
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
  positions: Array<{ item_guid: string; read_at: number; rkey: string }>;
  cursor: number;
};

async function getPositions(path: string): Promise<{ status: number; body: PositionsResponse }> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(makeAuthRequest(path), env, ctx);
  await waitOnExecutionContext(ctx);
  const body = (await response.json()) as PositionsResponse;
  return { status: response.status, body };
}

describe('GET /api/reading/positions', () => {
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
    await insertReadLabel('article-a', { updatedAt: now - 10, readAtMs: 1700000000000 });

    const { status, body } = await getPositions('/api/reading/positions');
    expect(status).toBe(200);
    expect(body.positions).toHaveLength(1);

    const pos = body.positions[0];
    expect(pos.item_guid).toBe('article-a');
    expect(pos.read_at).toBe(1700000000000);
    expect(pos.rkey).toBe('rk-article-a');
    // url/title are stored but must not be sent over the wire
    expect(pos).not.toHaveProperty('item_url');
    expect(pos).not.toHaveProperty('item_title');
  });

  it('only returns article read labels (not starred/archived/social)', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertReadLabel('read-article', { updatedAt: now - 10 });
    await insertReadLabel('starred-article', { updatedAt: now - 10, label: 'starred' });
    await insertReadLabel('archived-article', { updatedAt: now - 10, label: 'archived' });
    await insertReadLabel('read-share', { updatedAt: now - 10, itemType: 'share' });

    const { body } = await getPositions('/api/reading/positions');
    expect(body.positions.map((p) => p.item_guid)).toEqual(['read-article']);
  });

  describe('full sync windowing', () => {
    it('excludes reads older than the retention window', async () => {
      const now = Math.floor(Date.now() / 1000);
      await insertReadLabel('recent', { updatedAt: now - DAY_SECONDS });
      await insertReadLabel('stale', { updatedAt: now - (WINDOW_SECONDS + DAY_SECONDS) });

      const { body } = await getPositions('/api/reading/positions');
      expect(body.positions.map((p) => p.item_guid)).toEqual(['recent']);
    });

    it('returns the max updated_at as the cursor', async () => {
      const now = Math.floor(Date.now() / 1000);
      await insertReadLabel('older', { updatedAt: now - 100 });
      await insertReadLabel('newer', { updatedAt: now - 5 });

      const { body } = await getPositions('/api/reading/positions');
      expect(body.cursor).toBe(now - 5);
    });

    it('returns positions ordered newest-first', async () => {
      const now = Math.floor(Date.now() / 1000);
      await insertReadLabel('oldest', { updatedAt: now - 300 });
      await insertReadLabel('middle', { updatedAt: now - 200 });
      await insertReadLabel('newest', { updatedAt: now - 100 });

      const { body } = await getPositions('/api/reading/positions');
      expect(body.positions.map((p) => p.item_guid)).toEqual(['newest', 'middle', 'oldest']);
    });
  });

  describe('delta sync (?since=)', () => {
    it('returns only rows changed strictly after the cursor', async () => {
      const now = Math.floor(Date.now() / 1000);
      await insertReadLabel('at-cursor', { updatedAt: now - 100 });
      await insertReadLabel('after-cursor', { updatedAt: now - 50 });

      const { body } = await getPositions(`/api/reading/positions?since=${now - 100}`);
      expect(body.positions.map((p) => p.item_guid)).toEqual(['after-cursor']);
      expect(body.cursor).toBe(now - 50);
    });

    it('ignores the retention window so old-but-changed rows still sync', async () => {
      // A row whose updated_at predates the window but is newer than the client's
      // cursor must still come back on a delta fetch.
      const oldButChanged = Math.floor(Date.now() / 1000) - (WINDOW_SECONDS + 10 * DAY_SECONDS);
      await insertReadLabel('old-but-changed', { updatedAt: oldButChanged });

      const { body } = await getPositions(`/api/reading/positions?since=${oldButChanged - 1}`);
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
});
