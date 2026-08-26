import { describe, expect, it, afterEach, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initDatabase } from './app';
import { getMentionLaneItems, MentionLaneUnavailableError } from './mention-lane';
import { resetConstellationBreaker } from './constellation-client';

const ARTICLE = 'https://example.com/the-article';
const PDS = 'https://pds.example';

function freshDb(): Database {
  const db = new Database(':memory:');
  initDatabase(db);
  return db;
}

// Seed the did_cache so resolveHandle/resolvePdsUrl don't hit the network.
function seedDid(db: Database, did: string, handle: string) {
  db.run(
    `INSERT INTO did_cache (did, pds_url, handle, cached_at) VALUES (?, ?, ?, ?)
		ON CONFLICT(did) DO UPDATE SET pds_url = excluded.pds_url, handle = excluded.handle, cached_at = excluded.cached_at`,
    [did, PDS, handle, Date.now()]
  );
}

// How the Bluesky appview answers `getPosts` for a case: which at-URIs it knows
// a like count for, and whether it answers at all. Omitted → it 404s, which is
// the "no counts, sort by date" path every other case exercises.
type AppviewMock = {
  likes?: Record<string, number>;
  /** The post record's own createdAt, per at-URI. Absent → the appview serves none. */
  dates?: Record<string, string>;
  /** Answer with this status instead of the counts (e.g. 500). */
  status?: number;
  /** Fail the connection outright. */
  throws?: boolean;
};

// Mock /links/all (source discovery), /links (per-source records), PDS
// getRecord (the per-record note), and the Bluesky appview's getPosts (the
// per-post like count). `records` maps rkey → record value.
function mockConstellation(
  linksAll: Record<string, Record<string, { distinct_dids: number }>>,
  recsBySource: Record<string, Array<{ did: string; rkey: string }>>,
  records: Record<string, Record<string, unknown>> = {},
  appview?: AppviewMock
) {
  return spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
    const url = new URL(String(input));
    if (url.hostname === 'public.api.bsky.app') {
      if (!appview) return new Response('{}', { status: 404 });
      if (appview.throws) throw new TypeError('connection refused');
      if (appview.status) return new Response('{}', { status: appview.status });
      // The appview returns only the posts it can serve — a deleted or blocked
      // one is simply missing from the list, not nulled out.
      const posts = url.searchParams
        .getAll('uris')
        .filter((uri) => (appview.likes ?? {})[uri] !== undefined)
        .map((uri) => ({
          uri,
          likeCount: appview.likes![uri],
          record: { createdAt: (appview.dates ?? {})[uri] },
        }));
      return new Response(JSON.stringify({ posts }));
    }
    if (url.pathname === '/links/all') {
      return new Response(JSON.stringify({ links: linksAll }));
    }
    if (url.pathname === '/links') {
      const key = `${url.searchParams.get('collection')}|${url.searchParams.get('path')}`;
      const recs = (recsBySource[key] ?? []).map((r) => ({
        did: r.did,
        collection: url.searchParams.get('collection')!,
        rkey: r.rkey,
      }));
      return new Response(JSON.stringify({ linking_records: recs }));
    }
    if (url.pathname === '/xrpc/com.atproto.repo.getRecord') {
      const rkey = url.searchParams.get('rkey')!;
      return new Response(JSON.stringify({ value: records[rkey] ?? {} }));
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch);
}

describe('getMentionLaneItems', () => {
  afterEach(() => {
    (globalThis.fetch as ReturnType<typeof spyOn>).mockRestore?.();
    // The breaker is module state shared across the whole file: the failure
    // tests below would otherwise open it and short-circuit whatever runs next.
    resetConstellationBreaker();
  });

  it('resolves Leaflet comments from a document URI and marks replies', async () => {
    const db = freshDb();
    const docUri = 'at://did:plc:publisher/site.standard.document/post1';
    seedDid(db, 'did:plc:alice', 'alice.test');

    mockConstellation(
      { 'pub.leaflet.comment': { '.subject': { distinct_dids: 1 } } },
      { 'pub.leaflet.comment|.subject': [{ did: 'did:plc:alice', rkey: 'comment1' }] },
      {
        comment1: {
          plaintext: 'A thoughtful comment',
          createdAt: '2026-08-25T12:00:00.000Z',
          reply: { parent: 'at://did:plc:bob/pub.leaflet.comment/parent' },
        },
      }
    );

    const { entries } = await getMentionLaneItems(db, ARTICLE, 'leaflet', docUri);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      note: 'A thoughtful comment',
      createdAt: '2026-08-25T12:00:00.000Z',
      verb: 'replied',
      url: null,
      quote: null,
    });
  });

  it('resolves a Bluesky lane: permalink + note, deduped across paths', async () => {
    const db = freshDb();
    seedDid(db, 'did:plc:alice', 'alice.test');

    mockConstellation(
      {
        'app.bsky.feed.post': {
          '.embed.external.uri': { distinct_dids: 1 },
          '.facets[].features[app.bsky.richtext.facet#link].uri': { distinct_dids: 1 },
          '.text': { distinct_dids: 1 }, // bare-text share source — no linkers seeded here
        },
        // Another lane's source for the same URL — must not leak into bluesky.
        'site.standard.document': { '.links[].uri': { distinct_dids: 1 } },
      },
      {
        'app.bsky.feed.post|.embed.external.uri': [{ did: 'did:plc:alice', rkey: 'post1' }],
        'app.bsky.feed.post|.facets[].features[app.bsky.richtext.facet#link].uri': [
          { did: 'did:plc:alice', rkey: 'post2' },
        ],
      },
      { post1: { text: 'great read' } }
    );

    const { entries } = await getMentionLaneItems(db, ARTICLE, 'bluesky');

    expect(entries.length).toBe(1); // alice once, despite two paths
    expect(entries[0]).toEqual({
      did: 'did:plc:alice',
      handle: 'alice.test',
      displayName: null,
      avatar: null,
      createdAt: null,
      note: 'great read',
      url: 'https://bsky.app/profile/did:plc:alice/post/post1',
      collections: [],
      verb: null,
      quote: null,
      // The appview isn't mocked in this case, so the count degrades to null
      // and the lane still resolves — the whole failure mode, in one line.
      likeCount: null,
    });
  });

  // The Bluesky lane is the only one with a per-entry engagement number, and the
  // discussion stream ranks on it — so the count has to arrive with the entries,
  // and its absence has to be survivable.
  describe('Bluesky like counts', () => {
    // Two authors on one source, so the batched appview call has to key its
    // counts by at-URI rather than by position.
    function mockTwoPosts(appview?: AppviewMock) {
      return mockConstellation(
        { 'app.bsky.feed.post': { '.embed.external.uri': { distinct_dids: 2 } } },
        {
          'app.bsky.feed.post|.embed.external.uri': [
            { did: 'did:plc:alice', rkey: 'post1' },
            { did: 'did:plc:bob', rkey: 'post2' },
          ],
        },
        { post1: { text: 'great read' }, post2: { text: 'also good' } },
        appview
      );
    }

    it('stamps each entry with its own post’s like count', async () => {
      const db = freshDb();
      seedDid(db, 'did:plc:alice', 'alice.test');
      seedDid(db, 'did:plc:bob', 'bob.test');
      mockTwoPosts({
        likes: {
          'at://did:plc:alice/app.bsky.feed.post/post1': 12,
          'at://did:plc:bob/app.bsky.feed.post/post2': 0,
        },
      });

      const { entries } = await getMentionLaneItems(db, ARTICLE, 'bluesky');
      expect(entries.map((e) => [e.did, e.likeCount])).toEqual([
        ['did:plc:alice', 12],
        ['did:plc:bob', 0],
      ]);
    });

    it('leaves a post the appview no longer serves at null', async () => {
      const db = freshDb();
      seedDid(db, 'did:plc:alice', 'alice.test');
      seedDid(db, 'did:plc:bob', 'bob.test');
      // Bob's post was deleted: the appview omits it from the response.
      mockTwoPosts({ likes: { 'at://did:plc:alice/app.bsky.feed.post/post1': 3 } });

      const { entries } = await getMentionLaneItems(db, ARTICLE, 'bluesky');
      expect(entries.map((e) => e.likeCount)).toEqual([3, null]);
    });

    it('still resolves the lane when the appview errors', async () => {
      const db = freshDb();
      seedDid(db, 'did:plc:alice', 'alice.test');
      seedDid(db, 'did:plc:bob', 'bob.test');
      mockTwoPosts({ status: 500 });

      const { entries } = await getMentionLaneItems(db, ARTICLE, 'bluesky');
      expect(entries.map((e) => e.note)).toEqual(['great read', 'also good']);
      expect(entries.every((e) => e.likeCount === null)).toBe(true);
    });

    it('still resolves the lane when the appview is unreachable', async () => {
      const db = freshDb();
      seedDid(db, 'did:plc:alice', 'alice.test');
      seedDid(db, 'did:plc:bob', 'bob.test');
      mockTwoPosts({ throws: true });

      const { entries } = await getMentionLaneItems(db, ARTICLE, 'bluesky');
      expect(entries.length).toBe(2);
      expect(entries.every((e) => e.likeCount === null)).toBe(true);
    });

    // Constellation returns linking records in its own index order, so the
    // eight a busy article shows have to be chosen after the counts arrive —
    // ranking a list that was already truncated would only reorder a sample.
    function mockCrowdedPost(appview?: AppviewMock, db?: Database) {
      const authors = Array.from({ length: 12 }, (_, i) => ({
        did: `did:plc:u${i}`,
        rkey: `post${i}`,
      }));
      if (db) for (const a of authors) seedDid(db, a.did, `${a.did.slice(8)}.test`);
      return mockConstellation(
        { 'app.bsky.feed.post': { '.embed.external.uri': { distinct_dids: authors.length } } },
        { 'app.bsky.feed.post|.embed.external.uri': authors },
        {},
        appview
      );
    }

    it('ranks the whole discovered pool, not just the first eight', async () => {
      const db = freshDb();
      // The one post everyone carried is the last one the index returns.
      const spy = mockCrowdedPost(
        {
          likes: {
            'at://did:plc:u11/app.bsky.feed.post/post11': 99,
            'at://did:plc:u2/app.bsky.feed.post/post2': 5,
          },
        },
        db
      );

      const { entries } = await getMentionLaneItems(db, ARTICLE, 'bluesky');

      expect(entries.length).toBe(8);
      expect(entries.map((e) => e.did).slice(0, 2)).toEqual(['did:plc:u11', 'did:plc:u2']);
      // Unscored candidates fall in behind, still in index order.
      expect(entries.map((e) => e.did).slice(2)).toEqual([
        'did:plc:u0',
        'did:plc:u1',
        'did:plc:u3',
        'did:plc:u4',
        'did:plc:u5',
        'did:plc:u6',
      ]);
      // One appview call, carrying every candidate — not one per post.
      const appviewCalls = spy.mock.calls.filter((call) =>
        String(call[0]).includes('public.api.bsky.app')
      );
      expect(appviewCalls.length).toBe(1);
      expect(new URL(String(appviewCalls[0][0])).searchParams.getAll('uris').length).toBe(12);
      // Only the survivors cost a PDS round trip for their post record.
      const fetchedPosts = spy.mock.calls
        .map((call) => new URL(String(call[0])))
        .filter(
          (url) =>
            url.pathname === '/xrpc/com.atproto.repo.getRecord' &&
            url.searchParams.get('collection') === 'app.bsky.feed.post'
        )
        .map((url) => url.searchParams.get('rkey'));
      expect(fetchedPosts.sort()).toEqual(
        ['post11', 'post2', 'post0', 'post1', 'post3', 'post4', 'post5', 'post6'].sort()
      );
    });

    it('breaks like-count ties on the post date the same call returns', async () => {
      const db = freshDb();
      // Nobody liked anything, so the pool is chosen purely on recency — and the
      // two newest posts are the last two the index returns.
      const uri = (i: number) => `at://did:plc:u${i}/app.bsky.feed.post/post${i}`;
      const likes: Record<string, number> = {};
      const dates: Record<string, string> = {};
      for (let i = 0; i < 12; i++) {
        likes[uri(i)] = 0;
        dates[uri(i)] = `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`;
      }
      mockCrowdedPost({ likes, dates }, db);

      const { entries } = await getMentionLaneItems(db, ARTICLE, 'bluesky');
      expect(entries.map((e) => e.did).slice(0, 2)).toEqual(['did:plc:u11', 'did:plc:u10']);
      expect(entries.length).toBe(8);
      expect(entries.some((e) => e.did === 'did:plc:u0')).toBeFalse();
    });

    it('falls back to the first eight in index order when the appview errors', async () => {
      const db = freshDb();
      mockCrowdedPost({ status: 500 }, db);

      const { entries } = await getMentionLaneItems(db, ARTICLE, 'bluesky');
      expect(entries.map((e) => e.did)).toEqual([
        'did:plc:u0',
        'did:plc:u1',
        'did:plc:u2',
        'did:plc:u3',
        'did:plc:u4',
        'did:plc:u5',
        'did:plc:u6',
        'did:plc:u7',
      ]);
      expect(entries.every((e) => e.likeCount === null)).toBe(true);
    });

    it('asks the appview nothing for a lane that has no like counts', async () => {
      const db = freshDb();
      seedDid(db, 'did:plc:frank', 'frank.test');
      const spy = mockConstellation(
        { 'at.margin.note': { '.target.source': { distinct_dids: 1 } } },
        { 'at.margin.note|.target.source': [{ did: 'did:plc:frank', rkey: 'note1' }] },
        { note1: { motivation: 'commenting', body: { value: 'a note' } } }
      );

      const { entries } = await getMentionLaneItems(db, ARTICLE, 'margin');
      expect(entries[0].likeCount).toBeNull();
      expect(
        spy.mock.calls.some((call) => String(call[0]).includes('public.api.bsky.app'))
      ).toBeFalse();
    });
  });

  it('links a Skyreader linkblog doc to its blogs permalink and pulls the leaflet note', async () => {
    const db = freshDb();
    seedDid(db, 'did:plc:bob', 'bob.test');

    mockConstellation(
      { 'site.standard.document': { '.links[].uri': { distinct_dids: 1 } } },
      { 'site.standard.document|.links[].uri': [{ did: 'did:plc:bob', rkey: 'doc1' }] },
      {
        doc1: {
          site: 'at://did:plc:bob/site.standard.publication/skyreader-links',
          path: '/doc1',
          content: {
            $type: 'pub.leaflet.content',
            pages: [
              { blocks: [{ block: { $type: 'pub.leaflet.blocks.text', plaintext: 'my take' } }] },
            ],
          },
        },
        // The skyreader-links publication resolves to the public blogs base URL.
        'skyreader-links': { url: 'https://skyreader.app/blogs/did:plc:bob/' },
      }
    );

    const { entries } = await getMentionLaneItems(db, ARTICLE, 'linkblog');
    expect(entries).toEqual([
      {
        did: 'did:plc:bob',
        handle: 'bob.test',
        displayName: null,
        avatar: null,
        createdAt: null,
        note: 'my take',
        url: 'https://skyreader.app/blogs/did:plc:bob/doc1',
        collections: [],
        verb: null,
        quote: null,
        likeCount: null,
      },
    ]);
  });

  it('links a foreign standard.site doc to its own publication URL, not a Skyreader permalink', async () => {
    const db = freshDb();
    seedDid(db, 'did:plc:carol', 'carol.test');

    mockConstellation(
      { 'site.standard.document': { '.links[].uri': { distinct_dids: 1 } } },
      { 'site.standard.document|.links[].uri': [{ did: 'did:plc:carol', rkey: 'essay' }] },
      {
        essay: {
          site: 'at://did:plc:carol/site.standard.publication/my-blog',
          path: '/essays/the-essay',
          description: 'a foreign note',
        },
        // Carol's own publication resolves to her real blog base URL.
        'my-blog': { url: 'https://carol.example/' },
      }
    );

    const { entries } = await getMentionLaneItems(db, ARTICLE, 'linkblog');
    expect(entries).toEqual([
      {
        did: 'did:plc:carol',
        handle: 'carol.test',
        displayName: null,
        avatar: null,
        createdAt: null,
        note: 'a foreign note',
        url: 'https://carol.example/essays/the-essay',
        collections: [],
        verb: null,
        quote: null,
        likeCount: null,
      },
    ]);
  });

  it('prefers the document description over the leaflet content snippet', async () => {
    const db = freshDb();
    seedDid(db, 'did:plc:dave', 'dave.test');

    mockConstellation(
      { 'site.standard.document': { '.links[].uri': { distinct_dids: 1 } } },
      { 'site.standard.document|.links[].uri': [{ did: 'did:plc:dave', rkey: 'doc2' }] },
      {
        doc2: {
          site: 'at://did:plc:dave/site.standard.publication/skyreader-links',
          path: '/doc2',
          description: 'the summary',
          content: {
            $type: 'pub.leaflet.content',
            pages: [
              {
                blocks: [
                  { block: { $type: 'pub.leaflet.blocks.text', plaintext: 'the leaflet note' } },
                ],
              },
            ],
          },
        },
        'skyreader-links': { url: 'https://skyreader.app/blogs/did:plc:dave/' },
      }
    );

    const { entries } = await getMentionLaneItems(db, ARTICLE, 'linkblog');
    expect(entries[0].note).toBe('the summary');
  });

  it('resolves a Semble lane: profile link-out + the collection(s) the card was filed into', async () => {
    const db = freshDb();
    seedDid(db, 'did:plc:eve', 'eve.test');

    mockConstellation(
      { 'network.cosmik.card': { '.content.url': { distinct_dids: 1 } } },
      {
        'network.cosmik.card|.content.url': [{ did: 'did:plc:eve', rkey: 'card1' }],
        // The card's collectionLink backlinks — eve filed it into one collection.
        'network.cosmik.collectionLink|.card.uri': [{ did: 'did:plc:eve', rkey: 'link1' }],
      },
      {
        card1: { content: { title: 'A saved card' } },
        link1: { collection: { uri: 'at://did:plc:eve/network.cosmik.collection/col1' } },
        col1: { name: 'Reading List' },
      }
    );

    const { entries } = await getMentionLaneItems(db, ARTICLE, 'semble');
    expect(entries).toEqual([
      {
        did: 'did:plc:eve',
        handle: 'eve.test',
        displayName: null,
        avatar: null,
        createdAt: null,
        note: 'A saved card',
        url: 'https://semble.so/profile/eve.test',
        collections: [
          { name: 'Reading List', url: 'https://semble.so/profile/eve.test/collections/col1' },
        ],
        verb: null,
        quote: null,
        likeCount: null,
      },
    ]);
  });

  it('resolves a margin lane: motivation verb + highlighted passage + comment', async () => {
    const db = freshDb();
    seedDid(db, 'did:plc:frank', 'frank.test');

    mockConstellation(
      { 'at.margin.note': { '.target.source': { distinct_dids: 1 } } },
      { 'at.margin.note|.target.source': [{ did: 'did:plc:frank', rkey: 'note1' }] },
      {
        note1: {
          motivation: 'highlighting',
          body: { value: 'this is the part that matters' },
          target: {
            source: ARTICLE,
            selector: { type: 'TextQuoteSelector', exact: 'the owned library' },
          },
        },
      }
    );

    const { entries } = await getMentionLaneItems(db, ARTICLE, 'margin');
    expect(entries).toEqual([
      {
        did: 'did:plc:frank',
        handle: 'frank.test',
        displayName: null,
        avatar: null,
        createdAt: null,
        note: 'this is the part that matters',
        url: null,
        collections: [],
        verb: 'highlighted',
        quote: 'the owned library',
        likeCount: null,
      },
    ]);
  });

  it('returns empty for a lane with no sources, and caches the result', async () => {
    const db = freshDb();
    const spy = mockConstellation(
      { 'app.bsky.feed.post': { '.embed.external.uri': { distinct_dids: 1 } } },
      {}
    );

    // Ask for the margin lane — no margin source exists for this URL.
    const { entries: empty } = await getMentionLaneItems(db, ARTICLE, 'margin');
    expect(empty).toEqual([]);

    // A second call for the same (lane, url) is served from cache (no new fetch).
    const callsAfterFirst = spy.mock.calls.length;
    await getMentionLaneItems(db, ARTICLE, 'margin');
    expect(spy.mock.calls.length).toBe(callsAfterFirst);
  });

  it('returns empty (no throw) for a non-http URL', async () => {
    const db = freshDb();
    const { entries } = await getMentionLaneItems(db, 'at://did:plc:x/app/rk', 'bluesky');
    expect(entries).toEqual([]);
  });

  // "Nobody wrote about this" and "we couldn't ask" look identical as an empty
  // list, and the reader acts on the first. These three pin the difference.
  it('throws rather than claiming nobody wrote about it when discovery is unreachable', async () => {
    const db = freshDb();
    const spy = spyOn(globalThis, 'fetch').mockImplementation(
      (async () => new Response('upstream is down', { status: 503 })) as unknown as typeof fetch
    );

    await expect(getMentionLaneItems(db, ARTICLE, 'bluesky')).rejects.toThrow(
      MentionLaneUnavailableError
    );

    // And nothing is cached, so the reader's retry actually re-asks.
    const callsAfterFirst = spy.mock.calls.length;
    await getMentionLaneItems(db, ARTICLE, 'bluesky').catch(() => {});
    expect(spy.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('throws when the index says a lane has people but the record lookup is unreachable', async () => {
    const db = freshDb();
    spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
      const url = new URL(String(input));
      if (url.pathname === '/links/all') {
        return new Response(
          JSON.stringify({
            links: { 'app.bsky.feed.post': { '.embed.external.uri': { distinct_dids: 1 } } },
          })
        );
      }
      // The lane exists; asking *who* is what fails.
      return new Response('upstream is down', { status: 503 });
    }) as unknown as typeof fetch);

    await expect(getMentionLaneItems(db, ARTICLE, 'bluesky')).rejects.toThrow(
      MentionLaneUnavailableError
    );
  });

  it('does not throw when one source is unreachable but people still resolved', async () => {
    const db = freshDb();
    seedDid(db, 'did:plc:judy', 'judy.test');
    let linksCalls = 0;
    spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
      const url = new URL(String(input));
      if (url.pathname === '/links/all') {
        return new Response(
          JSON.stringify({
            links: {
              'app.bsky.feed.post': {
                '.embed.external.uri': { distinct_dids: 1 },
                '.facets[].features[app.bsky.richtext.facet#link].uri': { distinct_dids: 1 },
              },
            },
          })
        );
      }
      if (url.pathname === '/links') {
        // First source answers, second is down — a partial outage that still has
        // somebody to show, so it degrades quietly instead of erroring.
        linksCalls++;
        if (linksCalls > 1) return new Response('upstream is down', { status: 503 });
        return new Response(
          JSON.stringify({
            linking_records: [
              { did: 'did:plc:judy', collection: 'app.bsky.feed.post', rkey: 'post12' },
            ],
          })
        );
      }
      return new Response(JSON.stringify({ value: { text: 'still here' } }));
    }) as unknown as typeof fetch);

    const { entries } = await getMentionLaneItems(db, ARTICLE, 'bluesky');
    expect(entries.length).toBe(1);
    expect(entries[0].note).toBe('still here');
  });

  it('carries the author profile and the record date so a merged view can show people in order', async () => {
    const db = freshDb();
    seedDid(db, 'did:plc:grace', 'grace.test');

    mockConstellation(
      { 'app.bsky.feed.post': { '.embed.external.uri': { distinct_dids: 1 } } },
      { 'app.bsky.feed.post|.embed.external.uri': [{ did: 'did:plc:grace', rkey: 'post9' }] },
      {
        post9: { text: 'worth your time', createdAt: '2026-08-22T01:26:11.000Z' },
        // The author's app.bsky.actor.profile record (rkey 'self').
        self: {
          displayName: 'Grace Hopper',
          avatar: { ref: { $link: 'bafyavatarcid' } },
        },
      }
    );

    const {
      entries: [entry],
    } = await getMentionLaneItems(db, ARTICLE, 'bluesky');
    expect(entry.displayName).toBe('Grace Hopper');
    expect(entry.avatar).toBe(
      'https://cdn.bsky.app/img/avatar/plain/did:plc:grace/bafyavatarcid@jpeg'
    );
    expect(entry.createdAt).toBe('2026-08-22T01:26:11.000Z');
  });

  it('degrades to a null profile and null date when the records carry neither', async () => {
    const db = freshDb();
    seedDid(db, 'did:plc:heidi', 'heidi.test');

    mockConstellation(
      { 'app.bsky.feed.post': { '.embed.external.uri': { distinct_dids: 1 } } },
      { 'app.bsky.feed.post|.embed.external.uri': [{ did: 'did:plc:heidi', rkey: 'post10' }] },
      { post10: { text: 'no date here' } }
    );

    const {
      entries: [entry],
    } = await getMentionLaneItems(db, ARTICLE, 'bluesky');
    expect(entry.displayName).toBeNull();
    expect(entry.avatar).toBeNull();
    expect(entry.createdAt).toBeNull();
  });

  it('ignores an unparseable record date rather than passing it through', async () => {
    const db = freshDb();
    seedDid(db, 'did:plc:ivan', 'ivan.test');

    mockConstellation(
      { 'app.bsky.feed.post': { '.embed.external.uri': { distinct_dids: 1 } } },
      { 'app.bsky.feed.post|.embed.external.uri': [{ did: 'did:plc:ivan', rkey: 'post11' }] },
      { post11: { text: 'bad date', createdAt: 'not a date' } }
    );

    const {
      entries: [entry],
    } = await getMentionLaneItems(db, ARTICLE, 'bluesky');
    expect(entry.createdAt).toBeNull();
  });
});
