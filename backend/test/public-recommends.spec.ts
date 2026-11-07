import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, afterEach } from 'vitest';
import worker from '../src/index';
import { handlePublicRecommends } from '../src/routes/public-recommends';

/**
 * GET /api/public/recommends — recent recommends across readers, for the front
 * of the public link pages. Articles and counts, never people.
 */

// The answer is one edge-cache entry, so each test asks on its own origin.
let seq = 0;
function request(method = 'GET'): Request {
  seq += 1;
  return new Request(`https://api${Date.now()}-${seq}.example/api/public/recommends`, { method });
}

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await handlePublicRecommends(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function recommend(did: string, url: string, title: string, secondsAgo: number) {
  await env.DB.prepare(
    `INSERT INTO recommendations (did, url_normalized, url, title, rkey, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(did, url, url, title, `rk${did}${url.length}`, Math.floor(Date.now() / 1000) - secondsAgo)
    .run();
}

type Body = { items: Array<{ url: string; title: string; people: number; recommendedAt: string }> };

describe('public recommends', () => {
  afterEach(async () => {
    await env.DB.prepare('DELETE FROM recommendations').run();
    await env.DB.prepare('DELETE FROM rate_limits').run();
  });

  it('lists articles by how many readers recommended them, then by recency, without people', async () => {
    await recommend('did:plc:a', 'https://example.com/one', 'One', 3600);
    await recommend('did:plc:a', 'https://example.com/two', 'Two', 60);
    await recommend('did:plc:b', 'https://example.com/one', 'One', 120);
    await recommend('did:plc:c', 'https://example.com/old', 'Old', 40 * 86400);

    const res = await call(request());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    const body = (await res.json()) as Body;
    expect(body.items.map((i) => [i.title, i.people])).toEqual([
      ['One', 2],
      ['Two', 1],
    ]);
    expect(JSON.stringify(body)).not.toContain('did:plc');
  });

  it('rejects a non-GET', async () => {
    expect((await call(request('POST'))).status).toBe(405);
  });

  it('is reachable through the worker without a session', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(request(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
  });
});
