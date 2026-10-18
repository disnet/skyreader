import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index';
import { GRANULAR_SCOPES } from '../src/config/scopes';
import { sha256Hex } from '../src/utils/sha256';
import { MAX_SNAPSHOTS_PER_SAVE } from '../src/services/archive/snapshots';
import {
  MAX_IMAGES_PER_SNAPSHOT,
  MAX_IMAGE_BYTES,
  snapshotImageUrls,
} from '../src/services/archive/snapshot-images';

// A snapshot keeps the pictures its body shows, so a save's images outlive the
// site that hosted them (services/archive/snapshot-images.ts).

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const DID = 'did:plc:snapshotimages';
const SESSION = 'sess-snapshot-images';
const PAGE = 'https://example.com/story/';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 4, 5, 6]);

let originalFetch: typeof globalThis.fetch;
let fetched: string[];

/** The site: a few pictures that load, and some that don't count as pictures. */
function site(input: RequestInfo | URL): Response {
  const url = String(input instanceof Request ? input.url : input);
  fetched.push(url);
  switch (url) {
    case 'https://example.com/story/a.png':
      return new Response(PNG, { headers: { 'Content-Type': 'image/png' } });
    case 'https://cdn.example.com/b.jpg?w=800&h=600':
      return new Response(JPEG, { headers: { 'Content-Type': 'image/jpeg; charset=binary' } });
    case 'https://example.com/c.png':
      return new Response(new Uint8Array([9, 9, 9]), { headers: { 'Content-Type': 'image/png' } });
    case 'https://example.com/logo.svg':
      return new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } });
    case 'https://example.com/page.png':
      return new Response('<html>', { headers: { 'Content-Type': 'text/html' } });
    case 'https://example.com/huge.png':
      return new Response(new Uint8Array(8), {
        headers: { 'Content-Type': 'image/png', 'Content-Length': String(MAX_IMAGE_BYTES + 1) },
      });
    default:
      return new Response('Not found', { status: 404 });
  }
}

async function reset() {
  for (const prefix of [`snapshots/${DID}/`, `images/${DID}/`]) {
    const listing = await env.SAVED_FILES.list({ prefix });
    if (listing.objects.length) await env.SAVED_FILES.delete(listing.objects.map((o) => o.key));
  }
  for (const table of ['saved_snapshot_images', 'saved_snapshots', 'saved_articles']) {
    await env.DB.prepare(`DELETE FROM ${table} WHERE user_did = ?`).bind(DID).run();
  }
  await env.DB.prepare('DELETE FROM sessions WHERE did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM user_settings WHERE user_did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM users WHERE did = ?').bind(DID).run();
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, 'img.bsky.social', 'https://pds.test', 'free', unixepoch())`
  )
    .bind(DID)
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
     VALUES (?, ?, 'img.bsky.social', 'https://pds.test', 'tok', 'rtok', ?, ?, ?)`
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

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function save(rkey: string, content: string, updateContent = false) {
  return call(request('/api/saved', 'POST', { url: PAGE, rkey, content, updateContent }));
}

function imageRequest(rkey: string, url: string) {
  return call(request(`/api/saved/${rkey}/snapshot-image?url=${encodeURIComponent(url)}`, 'GET'));
}

async function imageRows() {
  const rows = await env.DB.prepare(
    'SELECT snapshot_rkey, url, content_type, sha256, size, r2_key FROM saved_snapshot_images WHERE user_did = ? ORDER BY snapshot_rkey, url'
  )
    .bind(DID)
    .all<{
      snapshot_rkey: string;
      url: string;
      content_type: string;
      sha256: string;
      size: number;
      r2_key: string;
    }>();
  return rows.results;
}

async function imageObjects() {
  return (await env.SAVED_FILES.list({ prefix: `images/${DID}/` })).objects.map((o) => o.key);
}

describe('snapshotImageUrls', () => {
  it("reads each picture's address once, made absolute against the page", () => {
    const body = `
      <p><img src="a.png" alt="A"></p>
      <img alt="B" src='https://cdn.example.com/b.jpg?w=800&amp;h=600'>
      <img srcset="/c.png 1x, /c@2x.png 2x">
      <img src="data:image/gif;base64,R0lGOD" srcset="/d.png 400w">
      <img src="a.png">
      <img src="javascript:alert(1)">
      <IMG SRC=/e.png>`;
    expect(snapshotImageUrls(body, PAGE)).toEqual([
      'https://example.com/story/a.png',
      'https://cdn.example.com/b.jpg?w=800&h=600',
      'https://example.com/c.png',
      'https://example.com/d.png',
      'https://example.com/e.png',
    ]);
  });

  it('keeps at most MAX_IMAGES_PER_SNAPSHOT', () => {
    const body = Array.from({ length: 50 }, (_, i) => `<img src="/${i}.png">`).join('');
    expect(snapshotImageUrls(body, PAGE)).toHaveLength(MAX_IMAGES_PER_SNAPSHOT);
  });

  it('leaves relative addresses alone when there is no page (an upload)', () => {
    expect(snapshotImageUrls('<img src="a.png"><img src="https://x.test/b.png">', '')).toEqual([
      'https://x.test/b.png',
    ]);
  });
});

describe('snapshot pictures', () => {
  beforeEach(async () => {
    await reset();
    fetched = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => site(input)) as any;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("keeps the pictures a save's body shows, and only real raster pictures", async () => {
    await save(
      'aaaaaaaaaaaaa',
      `<p>Story</p><img src="a.png"><img src="https://cdn.example.com/b.jpg?w=800&amp;h=600">
       <img src="/logo.svg"><img src="/page.png"><img src="/huge.png"><img src="/gone.png">`
    );

    const rows = await imageRows();
    expect(rows.map((r) => [r.url, r.content_type, r.size])).toEqual([
      ['https://cdn.example.com/b.jpg?w=800&h=600', 'image/jpeg', JPEG.byteLength],
      ['https://example.com/story/a.png', 'image/png', PNG.byteLength],
    ]);
    expect(rows[1].sha256).toBe(await sha256Hex(PNG));

    const res = await imageRequest('aaaaaaaaaaaaa', 'https://example.com/story/a.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it("answers 404 for a picture it didn't keep, or another reader's save", async () => {
    await save('aaaaaaaaaaaaa', '<img src="a.png"><img src="/gone.png">');
    expect((await imageRequest('aaaaaaaaaaaaa', 'https://example.com/gone.png')).status).toBe(404);
    expect((await imageRequest('aaaaaaaaaaaaa', 'not a url')).status).toBe(404);
    expect((await imageRequest('zzzzzzzzzzzzz', 'https://example.com/story/a.png')).status).toBe(
      404
    );
    // Someone else's copy of the same save key isn't this reader's.
    await env.DB.prepare(
      `UPDATE saved_snapshot_images SET user_did = 'did:plc:other' WHERE user_did = ?`
    )
      .bind(DID)
      .run();
    expect((await imageRequest('aaaaaaaaaaaaa', 'https://example.com/story/a.png')).status).toBe(
      404
    );
    await env.DB.prepare(
      `DELETE FROM saved_snapshot_images WHERE user_did = 'did:plc:other'`
    ).run();
  });

  it('reuses a picture a later capture shares instead of downloading it again', async () => {
    await save('aaaaaaaaaaaaa', '<p>Stub</p><img src="a.png">');
    await save('bbbbbbbbbbbbb', '<p>Full text</p><img src="a.png"><img src="/c.png">', true);

    expect(fetched.filter((u) => u.endsWith('/a.png'))).toHaveLength(1);
    const rows = await imageRows();
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.snapshot_rkey)).size).toBe(2);
    expect(await imageObjects()).toHaveLength(2);
  });

  it("deletes a save's pictures with it", async () => {
    await save('aaaaaaaaaaaaa', '<img src="a.png"><img src="/c.png">');
    expect(await imageObjects()).toHaveLength(2);

    expect((await call(request('/api/saved/aaaaaaaaaaaaa', 'DELETE'))).status).toBe(200);
    expect(await imageRows()).toEqual([]);
    expect(await imageObjects()).toEqual([]);
  });

  it('at the cap, drops the pictures only the replaced capture showed', async () => {
    await save('aaaaaaaaaaaaa', '<p>0</p><img src="a.png">');
    for (let i = 1; i < MAX_SNAPSHOTS_PER_SAVE; i++) {
      await save('bbbbbbbbbbbbb', `<p>${i}</p><img src="a.png">`, true);
    }
    // The newest capture so far shows a picture no other does.
    await save('bbbbbbbbbbbbb', '<p>replaced</p><img src="a.png"><img src="/c.png">', true);
    expect(await imageObjects()).toHaveLength(2);

    await save('bbbbbbbbbbbbb', '<p>last</p><img src="a.png">', true);
    const rows = await imageRows();
    expect(rows.every((r) => r.url === 'https://example.com/story/a.png')).toBe(true);
    expect(rows).toHaveLength(MAX_SNAPSHOTS_PER_SAVE);
    expect(await imageObjects()).toEqual([`images/${DID}/aaaaaaaaaaaaa/${await sha256Hex(PNG)}`]);
    expect(fetched.filter((u) => u.endsWith('/a.png'))).toHaveLength(1);
  });
});
