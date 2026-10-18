import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';
import { GRANULAR_SCOPES } from '../src/config/scopes';
import { sha256Hex } from '../src/utils/sha256';
import { fillExtractedContent } from '../src/services/saved-content';
import { MAX_SNAPSHOTS_PER_SAVE } from '../src/services/archive/snapshots';

// A save keeps what it captured: each new body becomes an immutable snapshot in
// R2 with its hash, page, time and method (services/archive/snapshots.ts).

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const DID = 'did:plc:snapshots';
const SESSION = 'sess-snapshots';
const URL = 'https://example.com/story';

async function reset() {
  const old = await env.DB.prepare('SELECT r2_key FROM saved_snapshots WHERE user_did = ?')
    .bind(DID)
    .all<{ r2_key: string }>();
  for (const r of old.results) await env.SAVED_FILES.delete(r.r2_key);
  await env.DB.prepare('DELETE FROM saved_snapshots WHERE user_did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM saved_articles WHERE user_did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM sessions WHERE did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM user_settings WHERE user_did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM users WHERE did = ?').bind(DID).run();
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, 'snap.bsky.social', 'https://pds.test', 'free', unixepoch())`
  )
    .bind(DID)
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
     VALUES (?, ?, 'snap.bsky.social', 'https://pds.test', 'tok', 'rtok', ?, ?, ?)`
  )
    .bind(SESSION, DID, JSON.stringify({ kty: 'EC' }), Date.now() + 3_600_000, GRANULAR_SCOPES)
    .run();
}

function request(path: string, method: string, body?: unknown) {
  return new IncomingRequest(`http://localhost${path}`, {
    method,
    headers: {
      Cookie: `session_id=${SESSION}`,
      Origin: env.FRONTEND_URL,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function call(req: Request): Promise<{ status: number; body: any }> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function snapshots(rkey: string) {
  return (await call(request(`/api/saved/${rkey}/snapshots`, 'GET'))).body.snapshots as any[];
}

describe('save snapshots', () => {
  beforeEach(() => reset());

  it('keeps the body a URL save captured, with its hash, page and method', async () => {
    const content = '<p>The story as it was.</p>';
    await call(
      request('/api/saved', 'POST', {
        url: URL,
        rkey: 'aaaaaaaaaaaaa',
        content,
        captureMethod: 'live-dom',
      })
    );

    const list = await snapshots('aaaaaaaaaaaaa');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      url: URL,
      contentType: 'text/html',
      method: 'live-dom',
      sha256: await sha256Hex(new TextEncoder().encode(content)),
      size: new TextEncoder().encode(content).byteLength,
    });
    expect(Date.parse(list[0].capturedAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(list[0]).not.toHaveProperty('r2Key');

    const row = await env.DB.prepare('SELECT r2_key FROM saved_snapshots WHERE user_did = ?')
      .bind(DID)
      .first<{ r2_key: string }>();
    expect(await (await env.SAVED_FILES.get(row!.r2_key))!.text()).toBe(content);
  });

  it('survives a later capture replacing the body, and skips an identical one', async () => {
    await call(
      request('/api/saved', 'POST', { url: URL, rkey: 'aaaaaaaaaaaaa', content: '<p>Stub</p>' })
    );
    await call(
      request('/api/saved', 'POST', {
        url: URL,
        rkey: 'bbbbbbbbbbbbb',
        content: '<p>Full text</p>',
        updateContent: true,
        captureMethod: 'live-dom',
      })
    );
    await call(
      request('/api/saved', 'POST', {
        url: URL,
        rkey: 'ccccccccccccc',
        content: '<p>Full text</p>',
        updateContent: true,
        captureMethod: 'live-dom',
      })
    );

    const list = await snapshots('aaaaaaaaaaaaa');
    expect(list.map((s) => s.method)).toEqual([null, 'live-dom']);
    const first = await env.DB.prepare(
      'SELECT r2_key FROM saved_snapshots WHERE user_did = ? ORDER BY captured_at, rkey LIMIT 1'
    )
      .bind(DID)
      .first<{ r2_key: string }>();
    expect(await (await env.SAVED_FILES.get(first!.r2_key))!.text()).toBe('<p>Stub</p>');
  });

  it('keeps no snapshot of a failed-fetch note or an empty save', async () => {
    await call(
      request('/api/saved', 'POST', {
        url: URL,
        rkey: 'aaaaaaaaaaaaa',
        content:
          '<p data-skyreader-note="fetch-failed">Skyreader couldn\'t fetch this article.</p>',
      })
    );
    await call(request('/api/saved', 'POST', { url: `${URL}/2`, rkey: 'bbbbbbbbbbbbb' }));
    expect(await snapshots('aaaaaaaaaaaaa')).toEqual([]);
    expect(await snapshots('bbbbbbbbbbbbb')).toEqual([]);
  });

  it('records a feed save as captured from the feed, and ignores a method it does not know', async () => {
    await call(
      request('/api/saved', 'POST', {
        url: URL,
        rkey: 'aaaaaaaaaaaaa',
        source: 'feed',
        itemGuid: 'guid-1',
        content: '<p>From the feed</p>',
      })
    );
    await call(
      request('/api/saved', 'POST', {
        url: `${URL}/2`,
        rkey: 'bbbbbbbbbbbbb',
        content: '<p>Body</p>',
        captureMethod: 'upload',
      })
    );
    expect((await snapshots('aaaaaaaaaaaaa'))[0].method).toBe('feed');
    expect((await snapshots('bbbbbbbbbbbbb'))[0].method).toBeNull();
  });

  it('keeps the body a background extraction fills in', async () => {
    await env.DB.prepare(
      `INSERT INTO saved_articles (user_did, rkey, url, saved_at, created_at, source)
       VALUES (?, 'aaaaaaaaaaaaa', ?, 1, 1, 'url')`
    )
      .bind(DID, URL)
      .run();
    const article = {
      title: 'T',
      author: null,
      description: null,
      content: '<p>Extracted later</p>',
      domain: 'example.com',
      image: null,
      published: null,
      wordCount: 2,
    };
    await fillExtractedContent(env, article as any, { userDid: DID, rkey: 'aaaaaaaaaaaaa' });
    // A second fill finds the body already there and writes nothing.
    await fillExtractedContent(env, { ...article, content: '<p>Other</p>' } as any, {
      userDid: DID,
      rkey: 'aaaaaaaaaaaaa',
    });
    const list = await snapshots('aaaaaaaaaaaaa');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ method: 'server', url: URL });
  });

  it('deletes the snapshots and their bodies with the save', async () => {
    await call(
      request('/api/saved', 'POST', { url: URL, rkey: 'aaaaaaaaaaaaa', content: '<p>x</p>' })
    );
    const row = await env.DB.prepare('SELECT r2_key FROM saved_snapshots WHERE user_did = ?')
      .bind(DID)
      .first<{ r2_key: string }>();
    expect(await env.SAVED_FILES.head(row!.r2_key)).not.toBeNull();

    expect((await call(request('/api/saved/aaaaaaaaaaaaa', 'DELETE'))).status).toBe(200);
    const left = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM saved_snapshots WHERE user_did = ?'
    )
      .bind(DID)
      .first<{ n: number }>();
    expect(left!.n).toBe(0);
    expect(await env.SAVED_FILES.head(row!.r2_key)).toBeNull();
  });

  it('stops keeping captures of one save past the cap, keeping the first ones', async () => {
    await call(
      request('/api/saved', 'POST', { url: URL, rkey: 'aaaaaaaaaaaaa', content: '<p>0</p>' })
    );
    for (let i = 1; i <= MAX_SNAPSHOTS_PER_SAVE; i++) {
      await call(
        request('/api/saved', 'POST', {
          url: URL,
          rkey: 'bbbbbbbbbbbbb',
          content: `<p>${i}</p>`,
          updateContent: true,
        })
      );
    }
    const list = await snapshots('aaaaaaaaaaaaa');
    expect(list).toHaveLength(MAX_SNAPSHOTS_PER_SAVE);
    expect(list[0].sha256).toBe(await sha256Hex(new TextEncoder().encode('<p>0</p>')));
  });

  it('deletes the snapshots of every save under a guid', async () => {
    for (const rkey of ['aaaaaaaaaaaaa', 'bbbbbbbbbbbbb']) {
      await env.DB.prepare(
        `INSERT INTO saved_articles (user_did, rkey, url, saved_at, created_at, source, item_guid)
         VALUES (?, ?, '', 1, 1, 'feed', 'g-dup')`
      )
        .bind(DID, rkey)
        .run();
      await fillExtractedContent(env, { content: `<p>${rkey}</p>`, wordCount: 1 } as any, {
        userDid: DID,
        rkey,
      });
    }
    const before = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM saved_snapshots WHERE user_did = ?'
    )
      .bind(DID)
      .first<{ n: number }>();
    expect(before!.n).toBe(2);
    expect((await call(request('/api/saved/by-guid/g-dup', 'DELETE'))).status).toBe(200);
    const after = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM saved_snapshots WHERE user_did = ?'
    )
      .bind(DID)
      .first<{ n: number }>();
    expect(after!.n).toBe(0);
  });

  it("answers 404 for a save that isn't the reader's", async () => {
    const { status } = await call(request('/api/saved/zzzzzzzzzzzzz/snapshots', 'GET'));
    expect(status).toBe(404);
  });
});
