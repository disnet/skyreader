import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';
import { GRANULAR_SCOPES } from '../src/config/scopes';

// Route-level coverage for keyset pagination of GET /api/saved: ordering
// (saved_at DESC, id DESC), the cursor handoff between pages, and the
// short-page → cursor:null terminator. The client relies on this to refresh
// incrementally instead of re-downloading the whole list.

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const DID = 'did:plc:savedpage';
const SESSION = 'sess-saved-page';

async function setupUser() {
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, 'sp.bsky.social', 'https://pds.test', 'free', unixepoch())
     ON CONFLICT(did) DO NOTHING`
  )
    .bind(DID)
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
     VALUES (?, ?, 'sp.bsky.social', 'https://pds.test', 'tok', 'rtok', ?, ?, ?)`
  )
    .bind(SESSION, DID, JSON.stringify({ kty: 'EC' }), Date.now() + 3_600_000, GRANULAR_SCOPES)
    .run();
}

// Insert a saved row with an explicit saved_at so ordering is deterministic.
async function insert(rkey: string, savedAt: number) {
  await env.DB.prepare(
    `INSERT INTO saved_articles (user_did, rkey, url, title, content_type, saved_at, created_at)
     VALUES (?, ?, ?, ?, 'webpage', ?, ?)`
  )
    .bind(DID, rkey, `https://example.com/${rkey}`, rkey, savedAt, savedAt)
    .run();
}

function get(path: string) {
  return new IncomingRequest(`http://localhost${path}`, {
    method: 'GET',
    headers: { Cookie: `session_id=${SESSION}`, Origin: env.FRONTEND_URL },
  });
}

async function call(req: Request): Promise<{ status: number; body: any }> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('GET /api/saved — keyset pagination', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM saved_articles WHERE user_did = ?').bind(DID).run();
    await env.DB.prepare('DELETE FROM sessions WHERE did = ?').bind(DID).run();
    await env.DB.prepare('DELETE FROM user_settings WHERE user_did = ?').bind(DID).run();
    await setupUser();
  });

  it('returns newest-first and pages through the cursor', async () => {
    // saved_at ascending by index → expected order is e..a (newest first).
    await insert('a', 1000);
    await insert('b', 2000);
    await insert('c', 3000);
    await insert('d', 4000);
    await insert('e', 5000);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const qs = `limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const { status, body } = await call(get(`/api/saved?${qs}`));
      expect(status).toBe(200);
      expect(body.full).toBe(false);
      seen.push(...body.articles.map((a: { rkey: string }) => a.rkey));
      cursor = body.cursor;
      pages++;
    } while (cursor);

    // 5 items, limit 2 → pages of 2, 2, 1. The final (short) page ends the list.
    expect(seen).toEqual(['e', 'd', 'c', 'b', 'a']);
    expect(pages).toBe(3);
  });

  it('null cursor when the first page already covers everything', async () => {
    await insert('a', 1000);
    await insert('b', 2000);

    const { body } = await call(get('/api/saved?limit=10'));
    expect(body.articles.map((a: { rkey: string }) => a.rkey)).toEqual(['b', 'a']);
    expect(body.cursor).toBeNull();
  });

  it('breaks saved_at ties by id (insertion order) descending', async () => {
    // Same saved_at → newer row (higher id) sorts first; the cursor must not skip
    // or repeat the tied row across the page boundary.
    await insert('first', 1000);
    await insert('second', 1000);
    await insert('third', 1000);

    const page1 = await call(get('/api/saved?limit=2'));
    expect(page1.body.articles.map((a: { rkey: string }) => a.rkey)).toEqual(['third', 'second']);

    const page2 = await call(
      get(`/api/saved?limit=2&cursor=${encodeURIComponent(page1.body.cursor)}`)
    );
    expect(page2.body.articles.map((a: { rkey: string }) => a.rkey)).toEqual(['first']);
    expect(page2.body.cursor).toBeNull();
  });

  it('rejects a malformed cursor', async () => {
    const { status } = await call(get('/api/saved?cursor=not-a-cursor'));
    expect(status).toBe(400);
  });

  it('omits content from the list payload', async () => {
    await env.DB.prepare(
      `INSERT INTO saved_articles (user_did, rkey, url, title, content, content_type, saved_at, created_at)
       VALUES (?, 'withbody12345', ?, 'T', 'the full body', 'webpage', 1000, 1000)`
    )
      .bind(DID, 'https://example.com/x')
      .run();

    const { body } = await call(get('/api/saved'));
    expect(body.articles).toHaveLength(1);
    expect('content' in body.articles[0]).toBe(false);
  });
});

describe('POST /api/saved/bodies — body hydration', () => {
  // Valid TID-shaped rkeys (^[a-z0-9]{13,}$) so they survive isValidRkey filtering.
  const RK1 = 'aaaaaaaaaaaaa';
  const RK2 = 'bbbbbbbbbbbbb';

  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM saved_articles WHERE user_did = ?').bind(DID).run();
    await env.DB.prepare('DELETE FROM sessions WHERE did = ?').bind(DID).run();
    await env.DB.prepare('DELETE FROM user_settings WHERE user_did = ?').bind(DID).run();
    await setupUser();
  });

  function postBodies(rkeys: unknown) {
    return new IncomingRequest('http://localhost/api/saved/bodies', {
      method: 'POST',
      headers: {
        Cookie: `session_id=${SESSION}`,
        Origin: env.FRONTEND_URL,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ rkeys }),
    });
  }

  async function insertWithBody(rkey: string, content: string | null) {
    await env.DB.prepare(
      `INSERT INTO saved_articles (user_did, rkey, url, title, content, content_type, saved_at, created_at)
       VALUES (?, ?, ?, 'T', ?, 'webpage', 1000, 1000)`
    )
      .bind(DID, rkey, `https://example.com/${rkey}`, content)
      .run();
  }

  it('returns bodies for the requested rkeys', async () => {
    await insertWithBody(RK1, 'body one');
    await insertWithBody(RK2, 'body two');

    const { status, body } = await call(postBodies([RK1, RK2]));
    expect(status).toBe(200);
    expect(body.bodies).toEqual({ [RK1]: 'body one', [RK2]: 'body two' });
  });

  it('returns null for a row whose body is not yet extracted', async () => {
    await insertWithBody(RK1, null);
    const { body } = await call(postBodies([RK1]));
    expect(body.bodies[RK1]).toBeNull();
  });

  it('never leaks another user’s body', async () => {
    const otherDid = 'did:plc:otherbodyuser';
    await env.DB.prepare(
      `INSERT INTO saved_articles (user_did, rkey, url, title, content, content_type, saved_at, created_at)
       VALUES (?, ?, 'https://example.com/secret', 'T', 'secret body', 'webpage', 1000, 1000)`
    )
      .bind(otherDid, RK1)
      .run();

    const { body } = await call(postBodies([RK1]));
    expect(body.bodies).toEqual({});
    await env.DB.prepare('DELETE FROM saved_articles WHERE user_did = ?').bind(otherDid).run();
  });

  it('rejects a non-array rkeys field', async () => {
    const { status } = await call(postBodies('nope'));
    expect(status).toBe(400);
  });

  it('drops malformed rkeys but still answers for valid ones', async () => {
    await insertWithBody(RK1, 'body one');
    const { status, body } = await call(postBodies([RK1, 'too-short', 123]));
    expect(status).toBe(200);
    expect(body.bodies).toEqual({ [RK1]: 'body one' });
  });
});
