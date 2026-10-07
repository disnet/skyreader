import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';
import { GRANULAR_SCOPES } from '../src/config/scopes';

// POST /api/saved for a feed item with no web URL: an emailed newsletter is its
// own article, so its save is keyed by the item guid and carries the email body.

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const DID = 'did:plc:savednourl';
const SESSION = 'sess-saved-no-url';

async function reset() {
  await env.DB.prepare('DELETE FROM saved_articles WHERE user_did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM sessions WHERE did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM user_settings WHERE user_did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM users WHERE did = ?').bind(DID).run();
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, 'snu.bsky.social', 'https://pds.test', 'free', unixepoch())`
  )
    .bind(DID)
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
     VALUES (?, ?, 'snu.bsky.social', 'https://pds.test', 'tok', 'rtok', ?, ?, ?)`
  )
    .bind(SESSION, DID, JSON.stringify({ kty: 'EC' }), Date.now() + 3_600_000, GRANULAR_SCOPES)
    .run();
}

function post(body: unknown) {
  return new IncomingRequest('http://localhost/api/saved', {
    method: 'POST',
    headers: {
      Cookie: `session_id=${SESSION}`,
      Origin: env.FRONTEND_URL,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function call(req: Request): Promise<{ status: number; body: any }> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('POST /api/saved — feed item without a URL', () => {
  beforeEach(() => reset());

  it('saves a newsletter by its guid with the email body', async () => {
    const { status, body } = await call(
      post({
        url: '',
        rkey: 'aaaaaaaaaaaaa',
        fromFeed: true,
        itemGuid: 'issue-1@news.example.com',
        title: 'The big one',
        content: '<p>The whole issue.</p>',
      })
    );
    expect(status).toBe(200);
    expect(body.url).toBe('');
    const row = await env.DB.prepare(
      'SELECT url, content, item_guid FROM saved_articles WHERE user_did = ?'
    )
      .bind(DID)
      .first<any>();
    expect(row).toEqual({
      url: '',
      content: '<p>The whole issue.</p>',
      item_guid: 'issue-1@news.example.com',
    });
  });

  it('dedupes a second save of the same guid', async () => {
    const save = (rkey: string) =>
      call(post({ url: '', rkey, fromFeed: true, itemGuid: 'issue-2@news.example.com' }));
    expect((await save('aaaaaaaaaaaaa')).status).toBe(200);
    expect((await save('bbbbbbbbbbbbb')).status).toBe(409);
  });

  it('still requires a URL for a feed save without a guid', async () => {
    const { status } = await call(post({ url: '', rkey: 'aaaaaaaaaaaaa', fromFeed: true }));
    expect(status).toBe(400);
  });

  it('still rejects a malformed URL on a feed save', async () => {
    const { status } = await call(
      post({ url: 'not a url', rkey: 'aaaaaaaaaaaaa', fromFeed: true, itemGuid: 'g-3' })
    );
    expect(status).toBe(400);
  });

  it("dedupes source:'feed' by guid even without fromFeed", async () => {
    // An earlier URL-less save of a different item must not collide on url = ''.
    const first = await call(
      post({ url: '', rkey: 'aaaaaaaaaaaaa', source: 'feed', itemGuid: 'issue-a@x' })
    );
    expect(first.status).toBe(200);
    const second = await call(
      post({ url: '', rkey: 'bbbbbbbbbbbbb', source: 'feed', itemGuid: 'issue-b@x' })
    );
    expect(second.status).toBe(200);
  });

  it('stores a non-string url on a guid-keyed save as empty', async () => {
    const { status, body } = await call(
      post({ url: false, rkey: 'aaaaaaaaaaaaa', fromFeed: true, itemGuid: 'g-4' })
    );
    expect(status).toBe(200);
    expect(body.url).toBe('');
  });

  it("still requires a URL for source:'url', even with fromFeed and a guid", async () => {
    const { status, body } = await call(
      post({ url: '', rkey: 'aaaaaaaaaaaaa', source: 'url', fromFeed: true, itemGuid: 'g-5' })
    );
    expect(status).toBe(400);
    expect(body.error).toBe('Missing url field');
  });

  it('does not dedupe a URL-less save against another one by url', async () => {
    // A newsletter save (url '') must not swallow a later link-less share.
    const newsletter = await call(
      post({ url: '', rkey: 'aaaaaaaaaaaaa', fromFeed: true, itemGuid: 'issue-c@x' })
    );
    expect(newsletter.status).toBe(200);
    const share = await call(
      post({
        url: '',
        rkey: 'bbbbbbbbbbbbb',
        source: 'share',
        content: '<p>a note</p>',
        updateContent: true,
      })
    );
    expect(share.status).toBe(200);
    const row = await env.DB.prepare(
      'SELECT content FROM saved_articles WHERE user_did = ? AND item_guid = ?'
    )
      .bind(DID, 'issue-c@x')
      .first<{ content: string | null }>();
    expect(row?.content ?? null).toBeNull();
  });
});
