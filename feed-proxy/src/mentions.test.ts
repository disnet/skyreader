import { describe, expect, it, afterEach, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initDatabase } from './app';
import { computeMentions, enrichMentions, readCachedMentions } from './mentions';
import { normalizeArticleUrl, constellationTargets } from './url-normalize';
import { laneForSource } from './lanes';

const ARTICLE = 'https://example.com/the-article';

function freshDb(): Database {
  const db = new Database(':memory:');
  initDatabase(db);
  return db;
}

// Mock /links/all (source discovery) and /links/distinct-dids (per-source deduped
// DID lists). `linksAll` is the raw `links` object; `didsBySource` maps
// 'collection|path' → DID list.
function mockConstellation(
  linksAll: Record<string, Record<string, { distinct_dids: number }>>,
  didsBySource: Record<string, string[]>
) {
  return spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
    const url = new URL(String(input));
    if (url.pathname === '/links/all') {
      return new Response(JSON.stringify({ links: linksAll }));
    }
    if (url.pathname === '/links/distinct-dids') {
      const key = `${url.searchParams.get('collection')}|${url.searchParams.get('path')}`;
      const dids = didsBySource[key] ?? [];
      return new Response(JSON.stringify({ total: dids.length, linking_dids: dids }));
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch);
}

describe('normalizeArticleUrl', () => {
  it('strips tracking params, trailing slash, and fragment; lowercases host; keeps www', () => {
    expect(normalizeArticleUrl('https://www.Example.com/post/?utm_source=x&id=7#section')).toBe(
      'https://www.example.com/post?id=7'
    );
  });

  it('keeps non-tracking query params, sorted', () => {
    expect(normalizeArticleUrl('https://example.com/a?b=2&a=1')).toBe(
      'https://example.com/a?a=1&b=2'
    );
  });

  it('strips Substack referral tokens without treating every r param as tracking', () => {
    expect(
      normalizeArticleUrl(
        'https://chinaunread.substack.com/p/a-post?r=clku7&utm_medium=post%20viewer'
      )
    ).toBe('https://chinaunread.substack.com/p/a-post');
    expect(normalizeArticleUrl('https://example.com/article?r=chapter-2')).toBe(
      'https://example.com/article?r=chapter-2'
    );
  });

  it('leaves the bare root slash intact', () => {
    expect(normalizeArticleUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('returns null for non-http(s) and garbage', () => {
    expect(normalizeArticleUrl('at://did:plc:x/app/rk')).toBeNull();
    expect(normalizeArticleUrl('not a url')).toBeNull();
  });
});

describe('constellationTargets', () => {
  it('probes both trailing-slash forms of a non-root URL', () => {
    expect(constellationTargets('https://www.example.com/post')).toEqual([
      'https://www.example.com/post',
      'https://www.example.com/post/',
    ]);
  });

  it('keeps the query string after the slash', () => {
    expect(constellationTargets('https://example.com/a?id=7')).toEqual([
      'https://example.com/a?id=7',
      'https://example.com/a/?id=7',
    ]);
  });

  it('does not vary the bare root', () => {
    expect(constellationTargets('https://example.com/')).toEqual(['https://example.com/']);
  });

  it('also probes an exact legacy tracked spelling when supplied', () => {
    const normalized = 'https://chinaunread.substack.com/p/a-post';
    const raw =
      'https://chinaunread.substack.com/p/a-post?r=clku7&utm_campaign=post-expanded-share&utm_medium=post%20viewer';
    expect(constellationTargets(normalized, raw)).toEqual([
      normalized,
      `${normalized}/`,
      raw,
      'https://chinaunread.substack.com/p/a-post/?r=clku7&utm_campaign=post-expanded-share&utm_medium=post%20viewer',
    ]);
  });
});

describe('laneForSource', () => {
  it('buckets known collections and ignores excluded paths', () => {
    expect(laneForSource('site.standard.document', '.links[].uri')?.id).toBe('linkblog');
    expect(laneForSource('pub.leaflet.comment', '.subject')?.id).toBe('leaflet');
    expect(laneForSource('pub.leaflet.comment', '.attachment.document')).toBeNull();
    expect(laneForSource('app.bsky.feed.post', '.embed.external.uri')?.id).toBe('bluesky');
    expect(laneForSource('at.margin.note', '.target.source')?.id).toBe('margin');
    expect(laneForSource('network.cosmik.card', '.content.url')?.id).toBe('semble');
    expect(laneForSource('network.cosmik.connection', '.source')?.id).toBe('semble');
    expect(laneForSource('network.cosmik.connection', '.target')?.id).toBe('semble');
    expect(laneForSource('network.cosmik.dev.connection', '.source')).toBeNull();
    expect(laneForSource('network.cosmik.local.connection', '.target')).toBeNull();
    expect(laneForSource('network.cosmik.test.connection', '.source')).toBeNull();
    // A bare-text URL share counts toward Bluesky.
    expect(laneForSource('app.bsky.feed.post', '.text')?.id).toBe('bluesky');
    // Genuine incidentals stay excluded even though the collection is laned.
    expect(laneForSource('app.bsky.feed.post', '.embed.images[].alt')).toBeNull();
  });

  it('ignores un-laned collections (referrer/analytics noise)', () => {
    expect(laneForSource('net.anisota.beta.game.session', '.sessionContext.referrer')).toBeNull();
    expect(laneForSource('community.lexicon.bookmarks.bookmark', '.subject')).toBeNull();
  });
});

describe('computeMentions', () => {
  afterEach(() => {
    (globalThis.fetch as ReturnType<typeof spyOn>).mockRestore?.();
  });

  it('unions DIDs per lane (no double-count) and across lanes for the total', async () => {
    // Alice links via Bluesky embed AND facet (same person, two paths) → 1, not 2.
    // Carol shares it as bare text (`.text` is now a counted source). Bob notes it
    // on his linkblog; Alice also notes it → lane overlap.
    mockConstellation(
      {
        'app.bsky.feed.post': {
          '.embed.external.uri': { distinct_dids: 1 },
          '.facets[].features[app.bsky.richtext.facet#link].uri': {
            distinct_dids: 1,
          },
          '.text': { distinct_dids: 1 }, // bare-text share — counted
        },
        'site.standard.document': { '.links[].uri': { distinct_dids: 2 } },
      },
      {
        'app.bsky.feed.post|.embed.external.uri': ['did:plc:alice'],
        'app.bsky.feed.post|.facets[].features[app.bsky.richtext.facet#link].uri': [
          'did:plc:alice',
        ],
        'app.bsky.feed.post|.text': ['did:plc:carol'],
        'site.standard.document|.links[].uri': ['did:plc:alice', 'did:plc:bob'],
      }
    );

    const result = await computeMentions(ARTICLE);

    // Lead lane is Linkblogs (priority order), then Bluesky.
    expect(result.lanes.map((l) => l.lane)).toEqual(['linkblog', 'bluesky']);
    expect(result.lanes[0].count).toBe(2); // alice + bob
    expect(result.lanes[1].count).toBe(2); // alice (once, despite two paths) + carol
    // Total distinct people across lanes: alice, bob, carol → 3 (alice not double-counted).
    expect(result.total).toBe(3);
  });

  it('counts distinct DIDs, not raw records — one chatty account never inflates a lane', async () => {
    // Constellation's /links/distinct-dids dedups server-side: even if one account
    // posted the URL many times, it reports that account once with an honest total.
    const spy = spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
      const url = new URL(String(input));
      if (url.pathname === '/links/all') {
        return new Response(
          JSON.stringify({
            links: { 'app.bsky.feed.post': { '.embed.external.uri': { distinct_dids: 2 } } },
          })
        );
      }
      if (url.pathname === '/links/distinct-dids') {
        // total === page length → not capped; the chatty account is already deduped.
        return new Response(
          JSON.stringify({ total: 2, linking_dids: ['did:plc:loud', 'did:plc:quiet'] })
        );
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch);

    const result = await computeMentions(ARTICLE);
    expect(result.lanes[0].count).toBe(2);
    expect(result.lanes[0].capped).toBe(false);
    spy.mockRestore();
  });

  it('flags a lane as capped only when the true total outruns the fetched page', async () => {
    const spy = spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
      const url = new URL(String(input));
      if (url.pathname === '/links/all') {
        return new Response(
          JSON.stringify({
            links: { 'site.standard.document': { '.links[].uri': { distinct_dids: 250 } } },
          })
        );
      }
      if (url.pathname === '/links/distinct-dids') {
        // 250 distinct DIDs exist but we only hold one page of identities.
        const dids = Array.from({ length: 200 }, (_, i) => `did:plc:d${i}`);
        return new Response(JSON.stringify({ total: 250, linking_dids: dids }));
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch);

    const result = await computeMentions(ARTICLE);
    expect(result.lanes[0].count).toBe(200);
    expect(result.lanes[0].capped).toBe(true);
    spy.mockRestore();
  });

  it('finds a slash-canonical URL whose links only exist on the trailing-slash form', async () => {
    // The feed/cache key is slash-trimmed, but the real Semble/Bluesky links all
    // target `.../the-article/`. Querying only the no-slash form is a false zero;
    // probing both forms must surface them. (Regression: inkandswitch notebook.)
    const spy = spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
      const url = new URL(String(input));
      const target = url.searchParams.get('target');
      const hasSlash = target?.endsWith('/the-article/');
      if (url.pathname === '/links/all') {
        return new Response(
          JSON.stringify({
            links: hasSlash
              ? { 'network.cosmik.card': { '.content.url': { distinct_dids: 1 } } }
              : {},
          })
        );
      }
      if (url.pathname === '/links/distinct-dids') {
        return new Response(JSON.stringify({ total: 1, linking_dids: ['did:plc:saver'] }));
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch);

    const result = await computeMentions(ARTICLE);
    expect(result.total).toBe(1);
    expect(result.lanes.map((l) => l.lane)).toEqual(['semble']);
    spy.mockRestore();
  });

  it('ignores un-laned referrer collections entirely', async () => {
    mockConstellation(
      {
        'net.anisota.beta.game.session': {
          '.sessionContext.referrer': { distinct_dids: 330 },
        },
      },
      {}
    );
    const result = await computeMentions(ARTICLE);
    expect(result.total).toBe(0);
    expect(result.lanes).toEqual([]);
  });
});

describe('enrichMentions + readCachedMentions', () => {
  it('marks a fresh URL-only row due when a document URI arrives', () => {
    const db = freshDb();
    const now = Date.now();
    db.run(
      `INSERT INTO mention_cache
        (url_hash, url, total_dids, lanes_json, first_seen_at, checked_at, doc_uri)
       VALUES (?, ?, 0, '[]', ?, ?, NULL)`,
      ['11ddf42a96099890', ARTICLE, now, now]
    );

    const cached = readCachedMentions(
      db,
      ARTICLE,
      now,
      'at://did:plc:publisher/site.standard.document/post1'
    );
    expect(cached.shouldEnrich).toBe(true);
  });

  afterEach(() => {
    (globalThis.fetch as ReturnType<typeof spyOn>).mockRestore?.();
  });

  it('caches a breakdown and serves it above threshold; flags cold URLs to enrich', async () => {
    const db = freshDb();
    const now = Date.now();

    // Cold: no row yet → empty, but flagged for enrichment.
    const cold = readCachedMentions(db, ARTICLE, now);
    expect(cold.mentions.total).toBe(0);
    expect(cold.shouldEnrich).toBe(true);

    mockConstellation(
      { 'site.standard.document': { '.links[].uri': { distinct_dids: 2 } } },
      { 'site.standard.document|.links[].uri': ['did:plc:a', 'did:plc:b'] }
    );
    await enrichMentions(db, normalizeArticleUrl(ARTICLE)!);

    const warm = readCachedMentions(db, ARTICLE, now);
    expect(warm.mentions.total).toBe(2);
    expect(warm.mentions.lanes[0].lane).toBe('linkblog');
    // Just checked → not due for a re-poll.
    expect(warm.shouldEnrich).toBe(false);
  });

  it('surfaces a single linker (no minimum-DID threshold)', async () => {
    const db = freshDb();
    mockConstellation(
      { 'site.standard.document': { '.links[].uri': { distinct_dids: 1 } } },
      { 'site.standard.document|.links[].uri': ['did:plc:only'] }
    );
    await enrichMentions(db, normalizeArticleUrl(ARTICLE)!);

    const read = readCachedMentions(db, ARTICLE, Date.now());
    // One linker is real signal — surfaced, not suppressed.
    expect(read.mentions.total).toBe(1);
    expect(read.mentions.lanes[0].lane).toBe('linkblog');
    expect(read.mentions.lanes[0].count).toBe(1);
    // A row exists, so it isn't treated as a cold miss needing enrichment.
    expect(read.shouldEnrich).toBe(false);
  });
});
