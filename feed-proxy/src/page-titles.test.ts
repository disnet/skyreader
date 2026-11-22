import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createApp, initDatabase, type AppConfig } from './app';
import { createPageTitles } from './page-titles';
import { hashUrl } from './mentions';
import { normalizeArticleUrl } from './url-normalize';
import type { ArticlePageMeta } from './standard-site';

function freshDb(): Database {
  const db = new Database(':memory:');
  initDatabase(db);
  return db;
}

function stubPages(pages: Record<string, ArticlePageMeta | null>) {
  const calls: string[] = [];
  const fetchPage = async (url: string) => {
    calls.push(url);
    return { meta: url in pages ? pages[url] : null };
  };
  return { calls, fetchPage };
}

describe('page titles', () => {
  it('reads each page once, then answers from the cache', async () => {
    const db = freshDb();
    const { calls, fetchPage } = stubPages({
      'https://a.example/one': { title: 'The First Page' },
      'https://b.example/two': {},
    });
    const lookup = createPageTitles(db, { fetchPage });

    const urls = ['https://a.example/one?utm_source=x', 'https://b.example/two', 'not a url'];
    expect(await lookup(urls)).toEqual({
      titles: { 'https://a.example/one?utm_source=x': 'The First Page' },
      pending: false,
    });
    expect(await lookup(urls)).toEqual({
      titles: { 'https://a.example/one?utm_source=x': 'The First Page' },
      pending: false,
    });
    // A page with no title is remembered too.
    expect(calls).toEqual(['https://a.example/one', 'https://b.example/two']);
  });

  it("uses a title the link page already read, and doesn't fetch", async () => {
    const db = freshDb();
    const norm = normalizeArticleUrl('https://c.example/three')!;
    db.run(
      `INSERT INTO mention_cache (url_hash, url, total_dids, lanes_json, first_seen_at, checked_at, page_meta)
       VALUES (?, ?, 0, '[]', 0, 0, ?)`,
      [hashUrl(norm), norm, JSON.stringify({ title: 'Already Known' })]
    );
    const { calls, fetchPage } = stubPages({});
    const lookup = createPageTitles(db, { fetchPage });
    expect((await lookup(['https://c.example/three'])).titles).toEqual({
      'https://c.example/three': 'Already Known',
    });
    expect(calls).toEqual([]);
  });

  it('answers with what it has when a page is slow, and the page lands later', async () => {
    const db = freshDb();
    let finish!: () => void;
    const slow = new Promise<void>((resolve) => (finish = resolve));
    const lookup = createPageTitles(db, {
      budgetMs: 20,
      fetchPage: async () => {
        await slow;
        return { meta: { title: 'Slow But Sure' } };
      },
    });
    expect(await lookup(['https://slow.example/p'])).toEqual({ titles: {}, pending: true });
    finish();
    await new Promise((r) => setTimeout(r, 0));
    expect(await lookup(['https://slow.example/p'])).toEqual({
      titles: { 'https://slow.example/p': 'Slow But Sure' },
      pending: false,
    });
  });

  it('a failed read is not cached as an answer', async () => {
    const db = freshDb();
    let fail = true;
    const lookup = createPageTitles(db, {
      fetchPage: async () => {
        if (fail) throw new Error('boom');
        return { meta: { title: 'Back Again' } };
      },
    });
    expect((await lookup(['https://f.example/x'])).titles).toEqual({});
    fail = false;
    expect((await lookup(['https://f.example/x'])).titles).toEqual({
      'https://f.example/x': 'Back Again',
    });
  });
});

describe('POST /page-titles', () => {
  const config: AppConfig = {
    proxySecret: 'test-secret',
    cacheTtlMs: 60_000,
    staleTtlMs: 60_000,
    defaultLimit: 100,
    fetchArticlePage: async (url) => ({ meta: { title: `Title of ${new URL(url).pathname}` } }),
  };

  function post(body: unknown, secret = 'test-secret') {
    const { app } = createApp(freshDb(), config);
    return app.request('/page-titles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Proxy-Secret': secret },
      body: JSON.stringify(body),
    });
  }

  it('needs the proxy secret', async () => {
    expect((await post({ urls: [] }, 'wrong')).status).toBe(401);
  });

  it('needs a list', async () => {
    expect((await post({ url: 'https://x.example' })).status).toBe(400);
  });

  it('answers titles for the urls, capped at 50', async () => {
    const urls = Array.from({ length: 60 }, (_, i) => `https://x.example/p${i}`);
    const res = await post({ urls: [...urls, 42] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { titles: Record<string, string>; pending: boolean };
    expect(Object.keys(body.titles)).toHaveLength(50);
    expect(body.titles['https://x.example/p0']).toBe('Title of /p0');
    expect(body.pending).toBe(false);
  });
});
