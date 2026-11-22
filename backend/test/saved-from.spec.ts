import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';
import { savedFrom } from '../src/routes/saved';
import { GRANULAR_SCOPES } from '../src/config/scopes';

// Where a save came from: a link saved out of an article keeps that article
// (saved_from_url / saved_from_title), and every list read hands it back.

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const DID = 'did:plc:savedfrom';
const SESSION = 'sess-saved-from';

async function reset() {
  await env.DB.prepare('DELETE FROM saved_articles WHERE user_did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM sessions WHERE did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM user_settings WHERE user_did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM users WHERE did = ?').bind(DID).run();
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, 'sfrom.bsky.social', 'https://pds.test', 'free', unixepoch())`
  )
    .bind(DID)
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
     VALUES (?, ?, 'sfrom.bsky.social', 'https://pds.test', 'tok', 'rtok', ?, ?, ?)`
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

function get(path: string) {
  return new IncomingRequest(`http://localhost${path}`, {
    headers: { Cookie: `session_id=${SESSION}`, Origin: env.FRONTEND_URL },
  });
}

const SOURCE = 'https://essays.example.com/how-cities-remember';

describe('POST /api/saved — saved from an article', () => {
  beforeEach(() => reset());

  it('keeps the article a link was saved out of, and lists it back', async () => {
    const { status, body } = await call(
      post({
        url: 'https://other.example.com/cited',
        rkey: 'aaaaaaaaaaaaa',
        title: 'Cited',
        content: '<p>Text.</p>',
        savedFromUrl: SOURCE,
        savedFromTitle: '  How   Cities\nRemember ',
      })
    );
    expect(status).toBe(200);
    expect(body.savedFromUrl).toBe(SOURCE);
    expect(body.savedFromTitle).toBe('How Cities Remember');

    const list = await call(get('/api/saved'));
    expect(list.body.articles[0]).toMatchObject({
      url: 'https://other.example.com/cited',
      savedFromUrl: SOURCE,
      savedFromTitle: 'How Cities Remember',
    });
  });

  it('a save made any other way has no source', async () => {
    await call(post({ url: 'https://other.example.com/plain', rkey: 'bbbbbbbbbbbbb' }));
    const list = await call(get('/api/saved'));
    expect(list.body.articles[0]).toMatchObject({ savedFromUrl: null, savedFromTitle: null });
  });

  it('drops a source that is not a web page, without failing the save', async () => {
    const { status, body } = await call(
      post({
        url: 'https://other.example.com/x',
        rkey: 'ccccccccccccc',
        savedFromUrl: 'javascript:alert(1)',
        savedFromTitle: 'Nope',
      })
    );
    expect(status).toBe(200);
    expect(body.savedFromUrl).toBeNull();
    const row = await env.DB.prepare(
      'SELECT saved_from_url, saved_from_title FROM saved_articles WHERE user_did = ?'
    )
      .bind(DID)
      .first<any>();
    expect(row).toEqual({ saved_from_url: null, saved_from_title: null });
  });
});

describe('savedFrom', () => {
  it('takes an http(s) link with its title', () => {
    expect(
      savedFrom({ url: 'https://a.example/x', savedFromUrl: SOURCE, savedFromTitle: 'T' })
    ).toEqual({
      url: SOURCE,
      title: 'T',
    });
    expect(savedFrom({ url: 'https://a.example/x', savedFromUrl: SOURCE })).toEqual({
      url: SOURCE,
      title: null,
    });
  });

  it('refuses anything else', () => {
    for (const savedFromUrl of [
      undefined,
      '',
      42,
      'not a url',
      'ftp://x.example/a',
      'data:text/html,x',
      `https://x.example/${'a'.repeat(2100)}`,
    ]) {
      expect(savedFrom({ url: 'https://a.example/x', savedFromUrl })).toBeNull();
    }
  });

  it("refuses the save's own page, in any spelling", () => {
    expect(savedFrom({ url: SOURCE, savedFromUrl: SOURCE })).toBeNull();
    expect(savedFrom({ url: SOURCE, savedFromUrl: `${SOURCE}/?utm_source=x` })).toBeNull();
  });

  it('caps the title', () => {
    const title = savedFrom({
      url: 'https://a.example/x',
      savedFromUrl: SOURCE,
      savedFromTitle: 'x'.repeat(500),
    })?.title;
    expect(title).toHaveLength(300);
  });
});
