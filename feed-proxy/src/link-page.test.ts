import { describe, expect, it, afterEach, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createApp, initDatabase, type AppConfig } from './app';
import { enrichMentions, hashUrl, readCachedMentions } from './mentions';
import { hasNoUnauthenticatedLabel } from './mention-lane';
import { parseArticlePageMeta } from './standard-site';
import { normalizeArticleUrl } from './url-normalize';

const ARTICLE = 'https://example.com/the-article';
const NORM = normalizeArticleUrl(ARTICLE)!;

const CONFIG: AppConfig = {
  proxySecret: 'test-secret',
  cacheTtlMs: 15 * 60 * 1000,
  staleTtlMs: 60 * 60 * 1000,
  defaultLimit: 100,
};

function freshDb(): Database {
  const db = new Database(':memory:');
  initDatabase(db);
  return db;
}

function seedMentions(db: Database, opts: { pageMeta?: string | null; checkedAt?: number } = {}) {
  const now = opts.checkedAt ?? Date.now();
  db.run(
    `INSERT INTO mention_cache (url_hash, url, total_dids, lanes_json, first_seen_at, checked_at, doc_uri, doc_checked_at, page_meta)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    [
      hashUrl(NORM),
      NORM,
      2,
      JSON.stringify([
        {
          lane: 'bluesky',
          label: 'Bluesky',
          verb: 'posted',
          noun: 'Bluesky post',
          icon: 'bluesky',
          count: 2,
          capped: false,
        },
      ]),
      now,
      now,
      now,
      opts.pageMeta === undefined ? JSON.stringify({ title: 'The Article' }) : opts.pageMeta,
    ]
  );
}

function entry(did: string, extra: Record<string, unknown> = {}) {
  return {
    did,
    handle: `${did.slice(8)}.example`,
    displayName: null,
    avatar: null,
    createdAt: null,
    note: 'worth reading',
    url: null,
    collections: [],
    verb: null,
    quote: null,
    likeCount: null,
    ...extra,
  };
}

function seedLane(db: Database, entries: unknown[]) {
  db.run(`INSERT INTO constellation_cache (cache_key, context_json, cached_at) VALUES (?, ?, ?)`, [
    `lane-items3:bluesky|${NORM}`,
    JSON.stringify({ entries }),
    Date.now(),
  ]);
}

function post(app: ReturnType<typeof createApp>['app'], body: unknown, secret = 'test-secret') {
  return app.request('/link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Proxy-Secret': secret },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
});

describe('parseArticlePageMeta', () => {
  it('prefers Open Graph tags and decodes entities', () => {
    const meta = parseArticlePageMeta(`<html><head>
      <title>Fallback title</title>
      <meta property="og:title" content="Cities &amp; their rivers">
      <meta property="og:site_name" content='The Example'>
      <meta name="description" content="Plain description">
      <meta content="An &#8220;OG&#8221; description" property="og:description">
    </head></html>`);
    expect(meta).toEqual({
      title: 'Cities & their rivers',
      siteName: 'The Example',
      description: 'An “OG” description',
    });
  });

  it('falls back to the <title> and the plain description', () => {
    expect(
      parseArticlePageMeta(
        '<title>\n  A   title\n</title><meta name="description" content="Words here">'
      )
    ).toEqual({ title: 'A title', description: 'Words here' });
  });

  it('caps long fields and returns {} for a page that names nothing', () => {
    const long = 'x'.repeat(2000);
    const meta = parseArticlePageMeta(`<meta property="og:description" content="${long}">`);
    expect(meta.description!.length).toBe(500);
    expect(parseArticlePageMeta('<html><body>hi</body></html>')).toEqual({});
  });
});

describe('page metadata in the mention cache', () => {
  it('captures the page metadata during the document lookup', async () => {
    const db = freshDb();
    spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
      const url = new URL(String(input));
      if (url.href === ARTICLE) {
        return new Response('<head><meta property="og:title" content="Hello"></head>');
      }
      return new Response(JSON.stringify({ links: {} }));
    }) as unknown as typeof fetch);

    await enrichMentions(db, NORM, { resolveDocument: true, wantMeta: true });

    expect(readCachedMentions(db, ARTICLE, Date.now()).meta).toEqual({ title: 'Hello' });
  });

  it('keeps metadata it already had when the origin cannot be read', async () => {
    const db = freshDb();
    // Never checked for a document, so a resolving read looks again.
    seedMentions(db);
    db.run('UPDATE mention_cache SET doc_checked_at = NULL');
    spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
      const url = new URL(String(input));
      if (url.href === ARTICLE) return new Response('gone', { status: 503 });
      return new Response(JSON.stringify({ links: {} }));
    }) as unknown as typeof fetch);

    await enrichMentions(db, NORM, { resolveDocument: true, wantMeta: true });

    expect(readCachedMentions(db, ARTICLE, Date.now()).meta).toEqual({ title: 'The Article' });
  });

  it('records {} for an unreadable page so it is not fetched on every visit', async () => {
    const db = freshDb();
    seedMentions(db, { pageMeta: null });
    spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
      const url = new URL(String(input));
      if (url.href === ARTICLE) return new Response('gone', { status: 404 });
      return new Response(JSON.stringify({ links: {} }));
    }) as unknown as typeof fetch);

    expect(
      readCachedMentions(db, ARTICLE, Date.now(), { resolveDocument: true, wantMeta: true })
        .shouldEnrich
    ).toBe(true);
    await enrichMentions(db, NORM, { resolveDocument: true, wantMeta: true });

    const after = readCachedMentions(db, ARTICLE, Date.now(), {
      resolveDocument: true,
      wantMeta: true,
    });
    expect(after.meta).toEqual({});
    expect(after.shouldEnrich).toBe(false);
  });

  it('only a link page asks again for a row cached before metadata existed', () => {
    const db = freshDb();
    seedMentions(db, { pageMeta: null });
    // The reader's discussion panel doesn't pay for metadata it never shows.
    expect(
      readCachedMentions(db, ARTICLE, Date.now(), { resolveDocument: true }).shouldEnrich
    ).toBe(false);
    expect(
      readCachedMentions(db, ARTICLE, Date.now(), { resolveDocument: true, wantMeta: true })
        .shouldEnrich
    ).toBe(true);
  });
});

describe('POST /link', () => {
  it('returns metadata, counts and the people in each lane', async () => {
    const db = freshDb();
    seedMentions(db);
    seedLane(db, [entry('did:plc:alice'), entry('did:plc:bob')]);
    const { app } = createApp(db, CONFIG);

    const res = await post(app, { url: `${ARTICLE}?utm_source=x` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      url: string;
      meta: unknown;
      total: number;
      entries: Record<string, Array<{ did: string }>>;
      pending: boolean;
      unavailable: boolean;
    };
    expect(body.url).toBe(NORM);
    expect(body.meta).toEqual({ title: 'The Article' });
    expect(body.total).toBe(2);
    expect(body.entries.bluesky.map((e) => e.did)).toEqual(['did:plc:alice', 'did:plc:bob']);
    expect(body.pending).toBe(false);
    expect(body.unavailable).toBe(false);
  });

  it('leaves out people who asked not to be shown to logged-out viewers', async () => {
    const db = freshDb();
    seedMentions(db);
    seedLane(db, [entry('did:plc:alice'), entry('did:plc:quiet', { noUnauthenticated: true })]);
    const { app } = createApp(db, CONFIG);

    const body = (await (await post(app, { url: ARTICLE })).json()) as {
      entries: Record<string, Array<{ did: string }>>;
    };
    expect(body.entries.bluesky.map((e) => e.did)).toEqual(['did:plc:alice']);
  });

  it('says a never-seen URL is still being looked up', async () => {
    const db = freshDb();
    spyOn(globalThis, 'fetch').mockImplementation(
      (async () => new Response(JSON.stringify({ links: {} }))) as unknown as typeof fetch
    );
    const { app } = createApp(db, CONFIG);

    const body = (await (await post(app, { url: ARTICLE })).json()) as {
      pending: boolean;
      lanes: unknown[];
      meta: unknown;
    };
    expect(body.pending).toBe(true);
    expect(body.lanes).toEqual([]);
    expect(body.meta).toBeNull();
  });

  it('rejects a missing secret, a missing url and a non-http url', async () => {
    const { app } = createApp(freshDb(), CONFIG);
    expect((await post(app, { url: ARTICLE }, 'wrong')).status).toBe(401);
    expect((await post(app, {})).status).toBe(400);
    expect((await post(app, { url: 'javascript:alert(1)' })).status).toBe(400);
    expect((await post(app, { url: `https://example.com/${'a'.repeat(2100)}` })).status).toBe(400);
  });
});

describe('hasNoUnauthenticatedLabel', () => {
  it('reads the self-label off a profile record', () => {
    expect(
      hasNoUnauthenticatedLabel({
        labels: {
          $type: 'com.atproto.label.defs#selfLabels',
          values: [{ val: '!no-unauthenticated' }],
        },
      })
    ).toBe(true);
    expect(hasNoUnauthenticatedLabel({ labels: { values: [{ val: 'porn' }] } })).toBe(false);
    expect(hasNoUnauthenticatedLabel(null)).toBe(false);
  });
});
