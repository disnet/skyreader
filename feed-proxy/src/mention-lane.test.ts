import { describe, expect, it, afterEach, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initDatabase } from './app';
import { getMentionLaneItems } from './mention-lane';

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

// Mock /links/all (source discovery), /links (per-source records), and PDS
// getRecord (the per-record note). `records` maps rkey → record value.
function mockConstellation(
  linksAll: Record<string, Record<string, { distinct_dids: number }>>,
  recsBySource: Record<string, Array<{ did: string; rkey: string }>>,
  records: Record<string, Record<string, unknown>> = {}
) {
  return spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
    const url = new URL(String(input));
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
  });

  it('resolves a Bluesky lane: permalink + note, deduped across paths', async () => {
    const db = freshDb();
    seedDid(db, 'did:plc:alice', 'alice.test');

    mockConstellation(
      {
        'app.bsky.feed.post': {
          '.embed.external.uri': { distinct_dids: 1 },
          '.facets[].features[app.bsky.richtext.facet#link].uri': { distinct_dids: 1 },
          '.text': { distinct_dids: 1 }, // noise lane-excluded; must be ignored
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

    const entries = await getMentionLaneItems(db, ARTICLE, 'bluesky');

    expect(entries.length).toBe(1); // alice once, despite two paths
    expect(entries[0]).toEqual({
      did: 'did:plc:alice',
      handle: 'alice.test',
      note: 'great read',
      url: 'https://bsky.app/profile/did:plc:alice/post/post1',
    });
  });

  it('builds a linkblog permalink and pulls the leaflet note', async () => {
    const db = freshDb();
    seedDid(db, 'did:plc:bob', 'bob.test');

    mockConstellation(
      { 'site.standard.document': { '.links[].uri': { distinct_dids: 1 } } },
      { 'site.standard.document|.links[].uri': [{ did: 'did:plc:bob', rkey: 'doc1' }] },
      {
        doc1: {
          content: {
            pages: [
              { blocks: [{ block: { $type: 'pub.leaflet.blocks.text', plaintext: 'my take' } }] },
            ],
          },
        },
      }
    );

    const entries = await getMentionLaneItems(db, ARTICLE, 'linkblog');
    expect(entries).toEqual([
      {
        did: 'did:plc:bob',
        handle: 'bob.test',
        note: 'my take',
        url: 'https://skyreader.app/blogs/did:plc:bob/doc1',
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
    const empty = await getMentionLaneItems(db, ARTICLE, 'margin');
    expect(empty).toEqual([]);

    // A second call for the same (lane, url) is served from cache (no new fetch).
    const callsAfterFirst = spy.mock.calls.length;
    await getMentionLaneItems(db, ARTICLE, 'margin');
    expect(spy.mock.calls.length).toBe(callsAfterFirst);
  });

  it('returns empty (no throw) for a non-http URL', async () => {
    const db = freshDb();
    const entries = await getMentionLaneItems(db, 'at://did:plc:x/app/rk', 'bluesky');
    expect(entries).toEqual([]);
  });
});
