import { describe, expect, it, afterEach, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initDatabase } from './app';
import { computeMentions, enrichMentions, readCachedMentions } from './mentions';
import { normalizeArticleUrl } from './url-normalize';
import { laneForSource } from './lanes';

const ARTICLE = 'https://example.com/the-article';

function freshDb(): Database {
  const db = new Database(':memory:');
  initDatabase(db);
  return db;
}

// Mock /links/all (source discovery) and /links (per-source DID lists). `linksAll`
// is the raw `links` object; `didsBySource` maps 'collection|path' → DID list.
function mockConstellation(
  linksAll: Record<string, Record<string, { distinct_dids: number }>>,
  didsBySource: Record<string, string[]>
) {
  return spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
    const url = new URL(String(input));
    if (url.pathname === '/links/all') {
      return new Response(JSON.stringify({ links: linksAll }));
    }
    if (url.pathname === '/links') {
      const key = `${url.searchParams.get('collection')}|${url.searchParams.get('path')}`;
      const dids = didsBySource[key] ?? [];
      const linking_records = dids.map((did, i) => ({
        did,
        collection: url.searchParams.get('collection')!,
        rkey: `rk${i}`,
      }));
      return new Response(JSON.stringify({ total: linking_records.length, linking_records }));
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

  it('leaves the bare root slash intact', () => {
    expect(normalizeArticleUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('returns null for non-http(s) and garbage', () => {
    expect(normalizeArticleUrl('at://did:plc:x/app/rk')).toBeNull();
    expect(normalizeArticleUrl('not a url')).toBeNull();
  });
});

describe('laneForSource', () => {
  it('buckets known collections and ignores excluded paths', () => {
    expect(laneForSource('site.standard.document', '.links[].uri')?.id).toBe('linkblog');
    expect(laneForSource('app.bsky.feed.post', '.embed.external.uri')?.id).toBe('bluesky');
    expect(laneForSource('at.margin.note', '.target.source')?.id).toBe('margin');
    expect(laneForSource('network.cosmik.card', '.content.url')?.id).toBe('semble');
    // Bluesky noise paths are excluded even though the collection is laned.
    expect(laneForSource('app.bsky.feed.post', '.text')).toBeNull();
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
    // Bob notes it on his linkblog. Alice also notes it → lane overlap.
    mockConstellation(
      {
        'app.bsky.feed.post': {
          '.embed.external.uri': { distinct_dids: 1 },
          '.facets[].features[app.bsky.richtext.facet#link].uri': {
            distinct_dids: 1,
          },
          '.text': { distinct_dids: 1 }, // noise — excluded
        },
        'site.standard.document': { '.links[].uri': { distinct_dids: 2 } },
      },
      {
        'app.bsky.feed.post|.embed.external.uri': ['did:plc:alice'],
        'app.bsky.feed.post|.facets[].features[app.bsky.richtext.facet#link].uri': [
          'did:plc:alice',
        ],
        'app.bsky.feed.post|.text': ['did:plc:troll'], // must never be fetched/counted
        'site.standard.document|.links[].uri': ['did:plc:alice', 'did:plc:bob'],
      }
    );

    const result = await computeMentions(ARTICLE);

    // Lead lane is Linkblogs (priority order), then Bluesky.
    expect(result.lanes.map((l) => l.lane)).toEqual(['linkblog', 'bluesky']);
    expect(result.lanes[0].count).toBe(2); // alice + bob
    expect(result.lanes[1].count).toBe(1); // alice once, despite two paths
    // Total distinct people across lanes: alice, bob → 2 (alice not double-counted).
    expect(result.total).toBe(2);
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

  it('hides a below-threshold count but still caches the row', async () => {
    const db = freshDb();
    mockConstellation(
      { 'site.standard.document': { '.links[].uri': { distinct_dids: 1 } } },
      { 'site.standard.document|.links[].uri': ['did:plc:only'] }
    );
    await enrichMentions(db, normalizeArticleUrl(ARTICLE)!);

    const read = readCachedMentions(db, ARTICLE, Date.now());
    // One linker is below MENTION_MIN_DIDS → served as empty...
    expect(read.mentions.total).toBe(0);
    // ...but a row exists, so it isn't treated as a cold miss needing enrichment.
    expect(read.shouldEnrich).toBe(false);
  });
});
