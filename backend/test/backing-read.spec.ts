import { describe, it, expect, vi, afterEach } from 'vitest';
import { extractUrlFromRecord, snapshotBackedCollection } from '../src/services/backing/read';
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

/** Route fetch by xrpc method; sub-handlers branch on query params. */
function installFetch(handlers: {
  listRecords?: (p: URLSearchParams) => Response;
  getRecord?: (p: URLSearchParams) => Response;
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
