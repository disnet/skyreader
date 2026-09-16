import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  extractUrlFromRecord,
  snapshotBackedCollection,
  SNAPSHOT_SUBREQUESTS,
  TRANSIENT_SKIP,
} from '../src/services/backing/read';
import { normalizeArticleUrl } from '../src/utils/url-normalize';
import { parseBacking, serializeBacking } from '../src/routes/settings';
import * as didResolver from '../src/utils/did-resolver';

// These cover the pure, provider-agnostic logic that Phase 0 proved against live
// records. The network-bound snapshot path is not covered here — it was validated
// in Phase 0 via a since-removed read-path spike against real provider collections.

describe('extractUrlFromRecord — multi-type (heterogeneous collections)', () => {
  it('community.lexicon.bookmarks.bookmark -> subject (the live Margin save shape)', () => {
    expect(
      extractUrlFromRecord({
        $type: 'community.lexicon.bookmarks.bookmark',
        subject: 'https://lettera.md',
        createdAt: '2026-06-18T00:00:00Z',
      })
    ).toBe('https://lettera.md');
  });

  it('network.cosmik.card (URL) -> content.url', () => {
    expect(
      extractUrlFromRecord({
        $type: 'network.cosmik.card',
        type: 'URL',
        content: { url: 'https://arxiv.org/abs/2606.04308' },
      })
    ).toBe('https://arxiv.org/abs/2606.04308');
  });

  it('network.cosmik.card type:NOTE -> null (free text, no URL — skip)', () => {
    expect(
      extractUrlFromRecord({ $type: 'network.cosmik.card', type: 'NOTE', content: {} })
    ).toBeNull();
  });

  it('at.margin.note motivation:bookmarking -> target.source', () => {
    expect(
      extractUrlFromRecord({
        $type: 'at.margin.note',
        motivation: 'bookmarking',
        target: { source: 'https://example.com/post' },
      })
    ).toBe('https://example.com/post');
  });

  it('at.margin.note motivation:highlighting -> null (annotation, not a save)', () => {
    expect(
      extractUrlFromRecord({
        $type: 'at.margin.note',
        motivation: 'highlighting',
        target: { source: 'https://example.com/post' },
      })
    ).toBeNull();
  });

  it('at.margin.bookmark -> source (the record Margin still defines and older exports wrote)', () => {
    expect(
      extractUrlFromRecord({
        $type: 'at.margin.bookmark',
        source: 'https://example.com/post',
        title: 'A post',
      })
    ).toBe('https://example.com/post');
    expect(extractUrlFromRecord({ $type: 'at.margin.bookmark', title: 'no source' })).toBeNull();
  });

  it('unknown type with a subject/url field -> generic fallback', () => {
    expect(extractUrlFromRecord({ $type: 'some.future.bookmark', url: 'https://x.test' })).toBe(
      'https://x.test'
    );
  });

  it('null / non-object -> null', () => {
    expect(extractUrlFromRecord(null)).toBeNull();
  });
});

describe('normalizeArticleUrl — the cross-app join key', () => {
  it('collapses tracking params, trailing slash, and fragment to one key', () => {
    const a = normalizeArticleUrl('https://example.com/post/?utm_source=x&id=7#section');
    const b = normalizeArticleUrl('https://example.com/post?id=7');
    expect(a).toBe(b);
  });

  it('preserves www and scheme (matches feed-proxy)', () => {
    expect(normalizeArticleUrl('https://www.theverge.com/')).toBe('https://www.theverge.com/');
    expect(normalizeArticleUrl('http://example.com/x')).toBe('http://example.com/x');
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

  it('returns null for non-http(s)', () => {
    expect(normalizeArticleUrl('at://did:plc:x/y/z')).toBeNull();
    expect(normalizeArticleUrl('not a url')).toBeNull();
  });
});

describe('parseBacking / serializeBacking', () => {
  it('round-trips skyreader (default)', () => {
    expect(parseBacking('skyreader')).toEqual({ provider: 'skyreader' });
    expect(parseBacking(null)).toEqual({ provider: 'skyreader' });
    expect(serializeBacking({ provider: 'skyreader' })).toBe('skyreader');
  });

  it('round-trips a semble/margin collection backing', () => {
    const uri = 'at://did:plc:abc/network.cosmik.collection/xyz';
    expect(parseBacking(`semble:${uri}`)).toEqual({ provider: 'semble', collectionUri: uri });
    expect(serializeBacking({ provider: 'semble', collectionUri: uri })).toBe(`semble:${uri}`);
    const muri = 'at://did:plc:abc/at.margin.collection/xyz';
    expect(parseBacking(`margin:${muri}`)).toEqual({ provider: 'margin', collectionUri: muri });
  });

  it('falls back to skyreader on malformed / unknown / non-at:// values', () => {
    expect(parseBacking('semble:not-an-at-uri')).toEqual({ provider: 'skyreader' });
    expect(parseBacking('bogus:at://x/y/z')).toEqual({ provider: 'skyreader' });
    expect(parseBacking('semble')).toEqual({ provider: 'skyreader' });
  });
});

// ---------------------------------------------------------------------------
// snapshotBackedCollection — the network-bound read path (mocked fetch + DID
// resolution). This is the load-bearing safety logic: a truncated listing or a
// transient getRecord failure MUST yield complete:false so the caller refuses to
// replace the membership table. Phase 0 proved it against live records; these
// pin the branches so they can't silently regress.
// ---------------------------------------------------------------------------

const OWNER = 'did:plc:owner';
const OTHER = 'did:plc:other';
const OWNER_PDS = 'https://owner.pds';
const OTHER_PDS = 'https://other.pds';
const SEMBLE_COL = `at://${OWNER}/network.cosmik.collection/col1`;
const MARGIN_COL = `at://${OWNER}/at.margin.collection/col1`;

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Route fetch by xrpc method; sub-handlers branch on query params. `links` is
 *  Constellation's backlink index, used only by the includeForeign path. */
function installFetch(handlers: {
  listRecords?: (p: URLSearchParams) => Response;
  getRecord?: (p: URLSearchParams) => Response;
  links?: (p: URLSearchParams) => Response;
}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    if (url.pathname.endsWith('com.atproto.repo.listRecords') && handlers.listRecords) {
      return handlers.listRecords(url.searchParams);
    }
    if (url.pathname.endsWith('com.atproto.repo.getRecord') && handlers.getRecord) {
      return handlers.getRecord(url.searchParams);
    }
    if (url.pathname === '/links' && handlers.links) {
      return handlers.links(url.searchParams);
    }
    throw new Error(`unexpected fetch: ${href}`);
  });
}

/** Map each DID to its PDS so cross-repo resolution can be asserted. */
function mockPds(map: Record<string, string | null> = { [OWNER]: OWNER_PDS, [OTHER]: OTHER_PDS }) {
  return vi
    .spyOn(didResolver, 'resolvePdsUrl')
    .mockImplementation(async (did: string) => map[did] ?? null);
}

describe('snapshotBackedCollection — Semble (collectionLink → card)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('filters links to the target collection, resolves cards, extracts url + metadata', async () => {
    mockPds();
    installFetch({
      // two links: one in col1 (kept), one in a different collection (filtered out)
      listRecords: () =>
        jsonRes({
          records: [
            {
              uri: `at://${OWNER}/network.cosmik.collectionLink/l1`,
              cid: 'x',
              value: {
                collection: { uri: SEMBLE_COL },
                card: { uri: `at://${OWNER}/network.cosmik.card/card1` },
              },
            },
            {
              uri: `at://${OWNER}/network.cosmik.collectionLink/l2`,
              cid: 'x',
              value: {
                collection: { uri: `at://${OWNER}/network.cosmik.collection/OTHER` },
                card: { uri: `at://${OWNER}/network.cosmik.card/card2` },
              },
            },
          ],
        }),
      getRecord: (p) => {
        expect(p.get('rkey')).toBe('card1'); // card2 must never be resolved (filtered)
        return jsonRes({
          value: {
            $type: 'network.cosmik.card',
            type: 'URL',
            content: {
              url: 'https://a.test/post',
              metadata: {
                title: 'Card Title',
                author: 'Auth',
                skyreaderRecord: 'at://did:plc:peer/site.standard.document/rk',
              },
            },
          },
        });
      },
    });

    const snap = await snapshotBackedCollection('semble', OWNER, SEMBLE_COL);
    expect(snap.complete).toBe(true);
    expect(snap.members).toHaveLength(1);
    expect(snap.members[0]).toMatchObject({
      url: 'https://a.test/post',
      urlNormalized: 'https://a.test/post',
      itemType: 'network.cosmik.card',
      title: 'Card Title',
      author: 'Auth',
      canonicalAtUri: 'at://did:plc:peer/site.standard.document/rk',
    });
    expect(snap.typeMix).toEqual({ 'network.cosmik.card': 1 });
  });

  it('resolves a CROSS-REPO card from the DID in its own at-uri', async () => {
    const pdsSpy = mockPds();
    installFetch({
      listRecords: () =>
        jsonRes({
          records: [
            {
              uri: `at://${OWNER}/network.cosmik.collectionLink/l1`,
              cid: 'x',
              value: {
                collection: { uri: SEMBLE_COL },
                card: { uri: `at://${OTHER}/network.cosmik.card/cardX` }, // foreign repo
              },
            },
          ],
        }),
      getRecord: (p) => {
        // the card must be fetched from the OTHER repo's PDS, not the owner's
        expect(p.get('repo')).toBe(OTHER);
        return jsonRes({
          value: { $type: 'network.cosmik.card', type: 'URL', content: { url: 'https://x.test' } },
        });
      },
    });

    const snap = await snapshotBackedCollection('semble', OWNER, SEMBLE_COL);
    expect(snap.complete).toBe(true);
    expect(snap.members).toHaveLength(1);
    expect(pdsSpy).toHaveBeenCalledWith(OTHER); // cross-repo PDS was resolved
  });

  it('skips (does not error on) a card that resolves but carries no url — e.g. a NOTE', async () => {
    mockPds();
    installFetch({
      listRecords: () =>
        jsonRes({
          records: [
            {
              uri: `at://${OWNER}/network.cosmik.collectionLink/l1`,
              cid: 'x',
              value: {
                collection: { uri: SEMBLE_COL },
                card: { uri: `at://${OWNER}/network.cosmik.card/note1` },
              },
            },
          ],
        }),
      getRecord: () =>
        jsonRes({ value: { $type: 'network.cosmik.card', type: 'NOTE', content: {} } }),
    });

    const snap = await snapshotBackedCollection('semble', OWNER, SEMBLE_COL);
    expect(snap.complete).toBe(true);
    expect(snap.members).toHaveLength(0);
    expect(snap.skipped).toHaveLength(1);
    expect(snap.skipped[0].reason).toContain('no-url');
  });
});

describe('snapshotBackedCollection — Margin (collectionItem → annotation)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads the flat annotation at-uri and resolves a community bookmark', async () => {
    mockPds();
    installFetch({
      listRecords: () =>
        jsonRes({
          records: [
            {
              uri: `at://${OWNER}/at.margin.collectionItem/i1`,
              cid: 'x',
              value: { collection: MARGIN_COL, annotation: `at://${OWNER}/at.margin.note/n1` },
            },
          ],
        }),
      getRecord: () =>
        jsonRes({
          value: {
            $type: 'community.lexicon.bookmarks.bookmark',
            subject: 'https://lettera.md/post',
          },
        }),
    });

    const snap = await snapshotBackedCollection('margin', OWNER, MARGIN_COL);
    expect(snap.complete).toBe(true);
    expect(snap.members).toHaveLength(1);
    expect(snap.members[0].url).toBe('https://lettera.md/post');
    expect(snap.typeMix).toEqual({ 'community.lexicon.bookmarks.bookmark': 1 });
  });
});

describe('snapshotBackedCollection — Margin (collectionItem → at.margin.bookmark)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('resolves a Margin bookmark with its title and description, not as no-url', async () => {
    // The live shape behind an empty room: a collection Skyreader's own Margin
    // export filled before it moved to notes.
    mockPds();
    installFetch({
      listRecords: () =>
        jsonRes({
          records: [
            {
              uri: `at://${OWNER}/at.margin.collectionItem/i1`,
              cid: 'x',
              value: {
                collection: MARGIN_COL,
                annotation: `at://${OWNER}/at.margin.bookmark/b1`,
                createdAt: '2026-03-21T14:03:30.116Z',
              },
            },
          ],
        }),
      getRecord: () =>
        jsonRes({
          value: {
            $type: 'at.margin.bookmark',
            source: 'https://www.techdirt.com/2026/03/20/some-post/',
            title: 'Some post',
            description: 'What the post is about.',
            tags: [],
          },
        }),
    });

    const snap = await snapshotBackedCollection('margin', OWNER, MARGIN_COL);
    expect(snap.complete).toBe(true);
    expect(snap.skipped).toHaveLength(0);
    expect(snap.members).toHaveLength(1);
    expect(snap.members[0].url).toBe('https://www.techdirt.com/2026/03/20/some-post/');
    expect(snap.members[0].itemType).toBe('at.margin.bookmark');
    expect(snap.members[0]).toMatchObject({
      title: 'Some post',
      description: 'What the post is about.',
      addedAt: '2026-03-21T14:03:30.116Z',
    });
  });
});

describe('snapshotBackedCollection — completeness invariant (the safety property)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('complete:false (members empty) when the listing is TRUNCATED at the page cap', async () => {
    mockPds();
    // Every page returns a record (in a DIFFERENT collection, so it filters out and no
    // getRecord runs) plus a cursor — so the listing never naturally ends and trips the
    // MAX_PAGES safety cap → truncated → complete:false.
    let page = 0;
    installFetch({
      listRecords: () => {
        page++;
        return jsonRes({
          records: [
            {
              uri: `at://${OWNER}/network.cosmik.collectionLink/p${page}`,
              cid: 'x',
              value: {
                collection: { uri: `at://${OWNER}/network.cosmik.collection/NOT_OURS` },
                card: { uri: `at://${OWNER}/network.cosmik.card/c${page}` },
              },
            },
          ],
          cursor: `cur${page}`, // always another page
        });
      },
    });

    const snap = await snapshotBackedCollection('semble', OWNER, SEMBLE_COL);
    expect(snap.complete).toBe(false);
    expect(snap.members).toHaveLength(0);
    expect(page).toBe(50); // stopped exactly at MAX_PAGES
  });

  it('a 404 getRecord DROPS that member (gone), staying complete', async () => {
    mockPds();
    installFetch({
      listRecords: () =>
        jsonRes({
          records: [
            {
              uri: `at://${OWNER}/network.cosmik.collectionLink/l1`,
              cid: 'x',
              value: {
                collection: { uri: SEMBLE_COL },
                card: { uri: `at://${OWNER}/network.cosmik.card/gone` },
              },
            },
          ],
        }),
      getRecord: () => jsonRes({ error: 'RecordNotFound' }, 404),
    });

    const snap = await snapshotBackedCollection('semble', OWNER, SEMBLE_COL);
    expect(snap.complete).toBe(true); // a genuine delete is not a failure
    expect(snap.members).toHaveLength(0);
    expect(snap.skipped[0].reason).toBe('item-not-resolvable');
  });

  it('a 5xx getRecord throws → complete:false (never silently drop a live member)', async () => {
    mockPds();
    installFetch({
      listRecords: () =>
        jsonRes({
          records: [
            {
              uri: `at://${OWNER}/network.cosmik.collectionLink/l1`,
              cid: 'x',
              value: {
                collection: { uri: SEMBLE_COL },
                card: { uri: `at://${OWNER}/network.cosmik.card/flaky` },
              },
            },
          ],
        }),
      getRecord: () => jsonRes({ error: 'InternalServerError' }, 500),
    });

    const snap = await snapshotBackedCollection('semble', OWNER, SEMBLE_COL);
    expect(snap.complete).toBe(false);
    expect(snap.members).toHaveLength(0);
  });

  it('complete:false when the owner PDS cannot be resolved', async () => {
    mockPds({ [OWNER]: null });
    installFetch({}); // never reached
    const snap = await snapshotBackedCollection('semble', OWNER, SEMBLE_COL);
    expect(snap.complete).toBe(false);
    expect(snap.members).toHaveLength(0);
  });

  it('complete:false when the membership listRecords itself errors', async () => {
    mockPds();
    installFetch({ listRecords: () => jsonRes({ error: 'boom' }, 502) });
    const snap = await snapshotBackedCollection('semble', OWNER, SEMBLE_COL);
    expect(snap.complete).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// includeForeign — membership written by someone OTHER than the collection owner
// (an open reading room being co-curated). Off by default: a stranger's link must
// never inject a row into a backed SAVES list. See routes/rooms.ts.
// ---------------------------------------------------------------------------

describe('snapshotBackedCollection — includeForeign (co-curated collections)', () => {
  afterEach(() => vi.restoreAllMocks());

  /** One owner-written link, plus whatever Constellation reports. */
  function installCoCurated(handlers: {
    links?: (p: URLSearchParams) => Response;
    getRecord?: (p: URLSearchParams) => Response;
  }) {
    installFetch({
      listRecords: () =>
        jsonRes({
          records: [
            {
              uri: `at://${OWNER}/network.cosmik.collectionLink/l1`,
              cid: 'x',
              value: {
                collection: { uri: SEMBLE_COL },
                card: { uri: `at://${OWNER}/network.cosmik.card/ownerCard` },
              },
            },
          ],
        }),
      ...handlers,
    });
  }

  const cardFor = (url: string) =>
    jsonRes({ value: { $type: 'network.cosmik.card', type: 'URL', content: { url } } });

  it('is off by default: another repo’s link is not in the snapshot', async () => {
    mockPds();
    installCoCurated({
      getRecord: (p) => cardFor(`https://owner.test/${p.get('rkey')}`),
      // A links call at all would mean the default asked Constellation.
    });
    const snap = await snapshotBackedCollection('semble', OWNER, SEMBLE_COL);
    expect(snap.members.map((m) => m.url)).toEqual(['https://owner.test/ownerCard']);
  });

  it('adds a link written in a contributor’s own repo', async () => {
    mockPds();
    installCoCurated({
      links: () =>
        jsonRes({
          linking_records: [
            { did: OTHER, collection: 'network.cosmik.collectionLink', rkey: 'foreign1' },
            // The owner's own links come from listRecords; a duplicate here must
            // not produce a second member.
            { did: OWNER, collection: 'network.cosmik.collectionLink', rkey: 'l1' },
          ],
          cursor: null,
        }),
      getRecord: (p) => {
        const rkey = p.get('rkey')!;
        if (rkey === 'foreign1') {
          return jsonRes({
            value: {
              collection: { uri: SEMBLE_COL },
              card: { uri: `at://${OTHER}/network.cosmik.card/theirCard` },
            },
          });
        }
        return cardFor(`https://a.test/${rkey}`);
      },
    });

    const snap = await snapshotBackedCollection('semble', OWNER, SEMBLE_COL, {
      includeForeign: true,
    });
    expect(snap.complete).toBe(true);
    expect(snap.members.map((m) => m.url).sort()).toEqual([
      'https://a.test/ownerCard',
      'https://a.test/theirCard',
    ]);
  });

  it('re-checks each indexed record: a link that names another collection is dropped', async () => {
    mockPds();
    installCoCurated({
      links: () =>
        jsonRes({
          linking_records: [
            { did: OTHER, collection: 'network.cosmik.collectionLink', rkey: 'stale' },
          ],
          cursor: null,
        }),
      getRecord: (p) => {
        const rkey = p.get('rkey')!;
        if (rkey === 'stale') {
          return jsonRes({
            value: {
              collection: { uri: `at://${OWNER}/network.cosmik.collection/SOMETHING_ELSE` },
              card: { uri: `at://${OTHER}/network.cosmik.card/theirCard` },
            },
          });
        }
        return cardFor(`https://a.test/${rkey}`);
      },
    });

    const snap = await snapshotBackedCollection('semble', OWNER, SEMBLE_COL, {
      includeForeign: true,
    });
    expect(snap.members.map((m) => m.url)).toEqual(['https://a.test/ownerCard']);
  });

  it('a Constellation outage yields complete:false, not a silently short list', async () => {
    mockPds();
    installCoCurated({
      links: () => jsonRes({ error: 'boom' }, 503),
      getRecord: (p) => cardFor(`https://a.test/${p.get('rkey')}`),
    });
    const snap = await snapshotBackedCollection('semble', OWNER, SEMBLE_COL, {
      includeForeign: true,
    });
    expect(snap.complete).toBe(false);
    expect(snap.members).toHaveLength(1); // the owner's half still renders
  });

  it('queries the Margin membership shape by its own backlink path', async () => {
    mockPds();
    installFetch({
      listRecords: () => jsonRes({ records: [] }),
      links: (p) => {
        expect(p.get('collection')).toBe('at.margin.collectionItem');
        expect(p.get('path')).toBe('.collection');
        expect(p.get('target')).toBe(MARGIN_COL);
        return jsonRes({
          linking_records: [
            { did: OTHER, collection: 'at.margin.collectionItem', rkey: 'foreign1' },
          ],
          cursor: null,
        });
      },
      getRecord: (p) => {
        const rkey = p.get('rkey')!;
        if (rkey === 'foreign1') {
          return jsonRes({
            value: { collection: MARGIN_COL, annotation: `at://${OTHER}/at.margin.note/n1` },
          });
        }
        return jsonRes({
          value: {
            $type: 'at.margin.note',
            motivation: 'bookmarking',
            target: { source: 'https://margin.test/post' },
          },
        });
      },
    });

    const snap = await snapshotBackedCollection('margin', OWNER, MARGIN_COL, {
      includeForeign: true,
    });
    expect(snap.members.map((m) => m.url)).toEqual(['https://margin.test/post']);
  });
});

// ---------------------------------------------------------------------------
// Order: oldest addition first, off the MEMBERSHIP record's timestamp. A room
// reads top to bottom in the order it was built, and neither where a membership
// record lives (owner repo vs Constellation) nor the concurrency of the resolve
// pool may decide that. See routes/rooms.ts.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The subrequest budget. A Worker invocation is capped at 1000 subrequests and
// crossing it THROWS, so a big co-curated room used to fail to load entirely
// rather than come back short. The budget converts that into the `complete: false`
// the caller already knows how to render.
// ---------------------------------------------------------------------------

describe('snapshotBackedCollection — subrequest budget', () => {
  afterEach(() => vi.restoreAllMocks());

  /** `count` contributors, each with one link in their own repo pointing at a card
   *  in that same repo — the shape of a busy open room. */
  function installBusyRoom(count: number) {
    const dids = Array.from({ length: count }, (_, i) => `did:plc:c${i}`);
    mockPds({
      [OWNER]: OWNER_PDS,
      ...Object.fromEntries(dids.map((d, i) => [d, `https://c${i}.pds`])),
    });
    installFetch({
      listRecords: () =>
        jsonRes({
          records: [
            {
              uri: `at://${OWNER}/network.cosmik.collectionLink/l1`,
              cid: 'x',
              value: {
                collection: { uri: SEMBLE_COL },
                card: { uri: `at://${OWNER}/network.cosmik.card/ownerCard` },
              },
            },
          ],
        }),
      links: () =>
        jsonRes({
          linking_records: dids.map((did) => ({
            did,
            collection: 'network.cosmik.collectionLink',
            rkey: 'theirLink',
          })),
          cursor: null,
        }),
      getRecord: (p) => {
        const repo = p.get('repo')!;
        if (p.get('collection') === 'network.cosmik.collectionLink') {
          return jsonRes({
            value: {
              collection: { uri: SEMBLE_COL },
              card: { uri: `at://${repo}/network.cosmik.card/theirCard` },
            },
          });
        }
        return jsonRes({
          value: {
            $type: 'network.cosmik.card',
            type: 'URL',
            content: { url: `https://a.test/${repo}` },
          },
        });
      },
    });
    return dids;
  }

  it('answers a room too big to resolve with a short list, not a failure', async () => {
    installBusyRoom(40);
    const fetchSpy = vi.mocked(globalThis.fetch);

    const snap = await snapshotBackedCollection('semble', OWNER, SEMBLE_COL, {
      includeForeign: true,
      maxSubrequests: 20,
    });

    // The old behaviour on a real Worker was a throw past the cap, which
    // snapshotBackedCollection's catch turned into an empty list.
    expect(snap.complete).toBe(false);
    expect(snap.members.length).toBeGreaterThan(0);
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(20);
  });

  it('caps foreign verification so it cannot starve item resolution', async () => {
    installBusyRoom(40);

    // Half the budget goes to verifying links; the rest is still there to resolve
    // the cards, so the owner's own article survives a flood of contributions.
    const snap = await snapshotBackedCollection('semble', OWNER, SEMBLE_COL, {
      includeForeign: true,
      maxSubrequests: 20,
    });

    expect(snap.members.map((m) => m.url)).toContain(`https://a.test/${OWNER}`);
  });

  it('leaves a room that fits inside the budget complete', async () => {
    installBusyRoom(3);
    const snap = await snapshotBackedCollection('semble', OWNER, SEMBLE_COL, {
      includeForeign: true,
    });
    expect(snap.complete).toBe(true);
    expect(snap.members).toHaveLength(4); // the owner's card plus three contributions
  });

  // The two phases used to keep separate PDS caches, so a contributor who owned the
  // card their link pointed at was resolved twice — two subrequests, one answer.
  it('resolves each DID once across both phases', async () => {
    installBusyRoom(3);
    const pdsSpy = vi.mocked(didResolver.resolvePdsUrl);

    await snapshotBackedCollection('semble', OWNER, SEMBLE_COL, { includeForeign: true });

    const resolved = pdsSpy.mock.calls.map(([did]) => did);
    expect(new Set(resolved).size).toBe(resolved.length);
  });

  it('defaults to a budget with room for the rest of the invocation', () => {
    expect(SNAPSHOT_SUBREQUESTS).toBeLessThan(1000);
  });
});

describe('snapshotBackedCollection — addedAt ordering', () => {
  afterEach(() => vi.restoreAllMocks());

  /** Owner links l1/l2/l3 in the order given; each card's url is its rkey. */
  function installDated(owner: Array<{ rkey: string; addedAt?: string }>, foreignAddedAt?: string) {
    installFetch({
      listRecords: () =>
        jsonRes({
          records: owner.map((l) => ({
            uri: `at://${OWNER}/network.cosmik.collectionLink/${l.rkey}`,
            cid: 'x',
            value: {
              collection: { uri: SEMBLE_COL },
              card: { uri: `at://${OWNER}/network.cosmik.card/${l.rkey}` },
              ...(l.addedAt ? { addedAt: l.addedAt } : {}),
            },
          })),
        }),
      links: () =>
        foreignAddedAt
          ? jsonRes({
              linking_records: [
                { did: OTHER, collection: 'network.cosmik.collectionLink', rkey: 'foreign1' },
              ],
              cursor: null,
            })
          : jsonRes({ linking_records: [], cursor: null }),
      getRecord: (p) => {
        const rkey = p.get('rkey')!;
        if (rkey === 'foreign1') {
          return jsonRes({
            value: {
              collection: { uri: SEMBLE_COL },
              card: { uri: `at://${OTHER}/network.cosmik.card/theirs` },
              addedAt: foreignAddedAt,
            },
          });
        }
        return jsonRes({
          value: {
            $type: 'network.cosmik.card',
            type: 'URL',
            content: { url: `https://a.test/${rkey}` },
          },
        });
      },
    });
  }

  it('returns members oldest-addition first, whatever order the repo lists them in', async () => {
    mockPds();
    installDated([
      { rkey: 'newest', addedAt: '2026-08-14T17:35:29.962Z' },
      { rkey: 'oldest', addedAt: '2026-06-01T09:00:00.000Z' },
      { rkey: 'middle', addedAt: '2026-07-04T12:00:00.000Z' },
    ]);
    const snap = await snapshotBackedCollection('semble', OWNER, SEMBLE_COL);
    expect(snap.members.map((m) => m.url)).toEqual([
      'https://a.test/oldest',
      'https://a.test/middle',
      'https://a.test/newest',
    ]);
    expect(snap.members[0].addedAt).toBe('2026-06-01T09:00:00.000Z');
  });

  it('interleaves a contributor’s add by date, not after the owner’s', async () => {
    mockPds();
    installDated(
      [
        { rkey: 'first', addedAt: '2026-06-01T09:00:00.000Z' },
        { rkey: 'last', addedAt: '2026-09-01T09:00:00.000Z' },
      ],
      '2026-07-01T09:00:00.000Z'
    );
    const snap = await snapshotBackedCollection('semble', OWNER, SEMBLE_COL, {
      includeForeign: true,
    });
    expect(snap.members.map((m) => m.url)).toEqual([
      'https://a.test/first',
      'https://a.test/theirs',
      'https://a.test/last',
    ]);
  });

  it('sorts an undated membership record last rather than treating it as oldest', async () => {
    mockPds();
    installDated([{ rkey: 'undated' }, { rkey: 'dated', addedAt: '2026-06-01T09:00:00.000Z' }]);
    const snap = await snapshotBackedCollection('semble', OWNER, SEMBLE_COL);
    expect(snap.members.map((m) => m.url)).toEqual([
      'https://a.test/dated',
      'https://a.test/undated',
    ]);
    expect(snap.members[1].addedAt).toBeUndefined();
  });
});

// An incremental caller (the materialized room) stores what it resolved and hands
// it back as `skipLinks`: those links are still LISTED, so the caller can diff
// its store against the collection, but nothing is fetched for them. Together
// with per-member failure containment, that is what makes a repeat snapshot
// cost what changed.
describe('snapshotBackedCollection — incremental (skipLinks / listed)', () => {
  afterEach(() => vi.restoreAllMocks());

  const OWNER_LINK = (rkey: string) => `at://${OWNER}/network.cosmik.collectionLink/${rkey}`;
  const cardFor = (url: string) =>
    jsonRes({ value: { $type: 'network.cosmik.card', type: 'URL', content: { url } } });

  /** Two owner links, one contributor link via Constellation. */
  function installRoom(getRecord?: (p: URLSearchParams) => Response) {
    installFetch({
      listRecords: () =>
        jsonRes({
          records: ['a', 'b'].map((rkey) => ({
            uri: OWNER_LINK(rkey),
            cid: 'x',
            value: {
              collection: { uri: SEMBLE_COL },
              card: { uri: `at://${OWNER}/network.cosmik.card/${rkey}` },
            },
          })),
        }),
      links: () =>
        jsonRes({
          linking_records: [
            { did: OTHER, collection: 'network.cosmik.collectionLink', rkey: 'theirs' },
          ],
          cursor: null,
        }),
      getRecord:
        getRecord ??
        ((p) => {
          if (p.get('collection') === 'network.cosmik.collectionLink') {
            return jsonRes({
              value: {
                collection: { uri: SEMBLE_COL },
                card: { uri: `at://${OTHER}/network.cosmik.card/theirCard` },
              },
            });
          }
          return cardFor(`https://a.test/${p.get('rkey')}`);
        }),
    });
  }

  it('lists a skipped link without fetching anything for it', async () => {
    mockPds();
    installRoom();
    const fetchSpy = vi.mocked(globalThis.fetch);
    const THEIRS = `at://${OTHER}/network.cosmik.collectionLink/theirs`;

    const snap = await snapshotBackedCollection('semble', OWNER, SEMBLE_COL, {
      includeForeign: true,
      skipLinks: new Set([OWNER_LINK('a'), THEIRS]),
    });

    expect(snap.complete).toBe(true);
    expect(snap.listingComplete).toBe(true);
    expect(snap.listed.sort()).toEqual([OWNER_LINK('a'), OWNER_LINK('b'), THEIRS].sort());
    // Only b was resolved: one getRecord, for its card. The contributor's link
    // was neither verified nor followed, so their PDS was never even resolved.
    expect(snap.members.map((m) => m.url)).toEqual(['https://a.test/b']);
    const getRecords = fetchSpy.mock.calls
      .map(([input]) => new URL(String(input)))
      .filter((u) => u.pathname.endsWith('getRecord'));
    expect(getRecords).toHaveLength(1);
    expect(vi.mocked(didResolver.resolvePdsUrl)).not.toHaveBeenCalledWith(OTHER);
  });

  it('confines a transient failure to the member it hit', async () => {
    mockPds();
    installRoom((p) => {
      if (p.get('rkey') === 'b') return jsonRes({ error: 'InternalServerError' }, 500);
      return cardFor(`https://a.test/${p.get('rkey')}`);
    });

    const snap = await snapshotBackedCollection('semble', OWNER, SEMBLE_COL);

    // Not complete — a live member may be missing — but the one that resolved is
    // still there for a caller that stores members one at a time.
    expect(snap.complete).toBe(false);
    expect(snap.listingComplete).toBe(true);
    expect(snap.members.map((m) => m.url)).toEqual(['https://a.test/a']);
    expect(snap.skipped).toEqual([
      {
        reason: TRANSIENT_SKIP,
        itemUri: `at://${OWNER}/network.cosmik.card/b`,
        linkUri: OWNER_LINK('b'),
      },
    ]);
  });

  it('a genuinely gone item is a permanent skip, not a transient one', async () => {
    mockPds();
    installRoom((p) => {
      if (p.get('rkey') === 'b') return jsonRes({ error: 'RecordNotFound' }, 400);
      return cardFor(`https://a.test/${p.get('rkey')}`);
    });
    const snap = await snapshotBackedCollection('semble', OWNER, SEMBLE_COL);
    expect(snap.complete).toBe(true);
    expect(snap.skipped.map((s) => s.reason)).toEqual(['item-not-resolvable']);
  });

  it('a foreign ref that cannot be verified stays listed, and only the list is incomplete', async () => {
    mockPds();
    installRoom((p) => {
      if (p.get('collection') === 'network.cosmik.collectionLink') {
        return jsonRes({ error: 'InternalServerError' }, 500);
      }
      return cardFor(`https://a.test/${p.get('rkey')}`);
    });
    const snap = await snapshotBackedCollection('semble', OWNER, SEMBLE_COL, {
      includeForeign: true,
    });
    // Constellation names the ref, so it is a member until its repo says otherwise:
    // a caller holding a row for it must not delete that row over a 5xx. The walk
    // itself finished, so the listing IS whole; what is missing is the member.
    expect(snap.listingComplete).toBe(true);
    expect(snap.listed).toContain(`at://${OTHER}/network.cosmik.collectionLink/theirs`);
    expect(snap.complete).toBe(false);
    expect(snap.members).toHaveLength(2);
  });

  it('a foreign ref whose repo cannot be resolved stays listed too', async () => {
    mockPds({ [OWNER]: OWNER_PDS }); // OTHER resolves to nothing: a deactivated account
    installRoom();
    const snap = await snapshotBackedCollection('semble', OWNER, SEMBLE_COL, {
      includeForeign: true,
    });
    expect(snap.listingComplete).toBe(true);
    expect(snap.listed).toContain(`at://${OTHER}/network.cosmik.collectionLink/theirs`);
    expect(snap.complete).toBe(false);
  });

  it('a foreign ref that answers "gone" or "elsewhere" is un-listed', async () => {
    mockPds();
    installRoom((p) => {
      if (p.get('collection') === 'network.cosmik.collectionLink') {
        return jsonRes({ error: 'RecordNotFound' }, 400);
      }
      return cardFor(`https://a.test/${p.get('rkey')}`);
    });
    const snap = await snapshotBackedCollection('semble', OWNER, SEMBLE_COL, {
      includeForeign: true,
    });
    expect(snap.listingComplete).toBe(true);
    expect(snap.complete).toBe(true);
    expect(snap.listed).not.toContain(`at://${OTHER}/network.cosmik.collectionLink/theirs`);
  });

  it('running out of budget mid-resolution keeps what resolved and stays retryable', async () => {
    mockPds();
    installRoom();
    const snap = await snapshotBackedCollection('semble', OWNER, SEMBLE_COL, {
      // owner PDS + one listRecords page + one getRecord: the second card is refused.
      maxSubrequests: 3,
    });
    expect(snap.complete).toBe(false);
    expect(snap.listingComplete).toBe(true);
    expect(snap.members).toHaveLength(1);
    expect(snap.skipped.map((s) => s.reason)).toEqual([TRANSIENT_SKIP]);
  });
});
