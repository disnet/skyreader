import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  aggregateFollowedRooms,
  collectionOwnerDid,
  collectionPageLink,
  fetchRoomMemberCount,
  fetchRoomMembers,
  resolveRoomInput,
  scanReadAlongs,
} from './rooms';
import { forgetFollowPds, pdsForFollow } from './followGraph';

vi.mock('./followGraph', () => ({
  pdsForFollow: vi.fn(async () => 'https://pds.example'),
  forgetFollowPds: vi.fn(async () => {}),
}));

const COLLECTION_URI = 'at://did:plc:abc123/network.cosmik.collection/3muahss6xki2b';
const OTHER_URI = 'at://did:plc:abc123/network.cosmik.collection/3zzzzzzzzzzzz';
const MARGIN_URI = 'at://did:plc:abc123/at.margin.collection/3muahss6xki2b';
const FOLLOW = { did: 'did:plc:reader1', handle: 'reader1.bsky.social', avatar: 'a.jpg' };

function recordsResponse(values: unknown[]): Response {
  return new Response(
    JSON.stringify({
      records: values.map((value, i) => ({
        uri: `at://did:plc:reader1/app.skyreader.reading.readAlong/rk${i}`,
        value,
      })),
    }),
    { status: 200 }
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveRoomInput', () => {
  it('passes a bare collection at-uri through', async () => {
    expect(await resolveRoomInput(COLLECTION_URI)).toBe(COLLECTION_URI);
    expect(await resolveRoomInput(`  ${COLLECTION_URI}  `)).toBe(COLLECTION_URI);
  });

  it('extracts the uri param from a room link', async () => {
    const link = `https://skyreader.app/rooms?uri=${encodeURIComponent(COLLECTION_URI)}`;
    expect(await resolveRoomInput(link)).toBe(COLLECTION_URI);
  });

  it('converts a semble.so collection page with a DID in the path', async () => {
    expect(
      await resolveRoomInput('https://semble.so/profile/did:plc:abc123/collections/3muahss6xki2b')
    ).toBe(COLLECTION_URI);
  });

  it('converts a semble.so collection page by resolving the handle', async () => {
    const fetchMock = vi.fn(
      async (_input: string) =>
        new Response(JSON.stringify({ did: 'did:plc:abc123' }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await resolveRoomInput('https://semble.so/profile/disnetdev.com/collections/3muahss6xki2b')
    ).toBe(COLLECTION_URI);
    expect(fetchMock.mock.calls[0]?.[0]).toContain('resolveHandle?handle=disnetdev.com');
  });

  it('rejects a semble.so page whose handle does not resolve', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 400 }))
    );
    expect(
      await resolveRoomInput('https://semble.so/profile/nope.example/collections/3muahss6xki2b')
    ).toBeNull();
  });

  it('converts a margin.at collection page with a DID in the path', async () => {
    expect(
      await resolveRoomInput('https://margin.at/did:plc:abc123/collection/3muahss6xki2b')
    ).toBe(MARGIN_URI);
  });

  it('converts a margin.at collection page by resolving the handle', async () => {
    const fetchMock = vi.fn(
      async (_input: string) =>
        new Response(JSON.stringify({ did: 'did:plc:abc123' }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await resolveRoomInput('https://margin.at/disnetdev.com/collection/3muahss6xki2b')).toBe(
      MARGIN_URI
    );
    expect(fetchMock.mock.calls[0]?.[0]).toContain('resolveHandle?handle=disnetdev.com');
  });

  it('rejects a margin.at page that names no owner', async () => {
    // Margin's own-collections route: no handle, so no repo to build an at-uri in.
    expect(await resolveRoomInput('https://margin.at/collections/3muahss6xki2b')).toBeNull();
    expect(await resolveRoomInput('https://margin.at/profile/did:plc:abc123')).toBeNull();
  });

  it('rejects everything else', async () => {
    expect(await resolveRoomInput('')).toBeNull();
    expect(await resolveRoomInput('not a link')).toBeNull();
    expect(await resolveRoomInput('at://did:plc:abc123/only-two')).toBeNull();
    expect(await resolveRoomInput('https://semble.so/url/whatever')).toBeNull();
    expect(await resolveRoomInput('https://example.com/profile/x/collections/y')).toBeNull();
  });
});

describe('fetchRoomMembers', () => {
  function didsResponse(dids: string[], cursor?: string): Response {
    return new Response(JSON.stringify({ linking_dids: dids, cursor }), { status: 200 });
  }

  it('pages Constellation until it runs out of joiners', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(didsResponse(['did:plc:a', 'did:plc:b'], 'page2'))
      .mockResolvedValueOnce(didsResponse(['did:plc:b', 'did:plc:c']));
    vi.stubGlobal('fetch', fetchMock);
    // Deduped across pages: the same reader can appear on both.
    expect(await fetchRoomMembers(COLLECTION_URI)).toEqual(['did:plc:a', 'did:plc:b', 'did:plc:c']);
  });

  it('reads an empty room as empty, not as a failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => didsResponse([]))
    );
    expect(await fetchRoomMembers(COLLECTION_URI)).toEqual([]);
  });

  it('reports null when Constellation never answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 503 }))
    );
    expect(await fetchRoomMembers(COLLECTION_URI)).toBeNull();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      })
    );
    expect(await fetchRoomMembers(COLLECTION_URI)).toBeNull();
  });

  it('keeps what it collected when a later page fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(didsResponse(['did:plc:a'], 'page2'))
      .mockResolvedValueOnce(new Response('nope', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchRoomMembers(COLLECTION_URI)).toEqual(['did:plc:a']);
  });
});

describe('fetchRoomMemberCount', () => {
  it('asks Constellation for distinct joiners of this collection', async () => {
    const fetchMock = vi.fn(
      async (_input: string) => new Response(JSON.stringify({ total: 4 }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchRoomMemberCount(COLLECTION_URI)).toBe(4);
    const url = new URL(fetchMock.mock.calls[0]![0]);
    expect(url.pathname).toBe('/links/count/distinct-dids');
    expect(url.searchParams.get('target')).toBe(COLLECTION_URI);
    expect(url.searchParams.get('collection')).toBe('app.skyreader.reading.readAlong');
    expect(url.searchParams.get('path')).toBe('.subject');
  });

  it('reports null, not zero, when the lookup fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 }))
    );
    expect(await fetchRoomMemberCount(COLLECTION_URI)).toBeNull();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      })
    );
    expect(await fetchRoomMemberCount(COLLECTION_URI)).toBeNull();

    // A well-formed response with no usable total is the same non-answer.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
    );
    expect(await fetchRoomMemberCount(COLLECTION_URI)).toBeNull();
  });
});

describe('collectionOwnerDid', () => {
  it('reads the repo out of a collection at-uri', () => {
    expect(collectionOwnerDid(COLLECTION_URI)).toBe('did:plc:abc123');
    expect(collectionOwnerDid('at://did:plc:abc123/only-two')).toBeNull();
    expect(collectionOwnerDid('not a uri')).toBeNull();
  });
});

describe('collectionPageLink', () => {
  it('round-trips a Semble collection back to its page', async () => {
    const link = collectionPageLink(COLLECTION_URI, 'disnetdev.com');
    expect(link).toEqual({
      url: 'https://semble.so/profile/disnetdev.com/collections/3muahss6xki2b',
      provider: 'Semble',
    });
    // The inverse of the parser: what we build, we can read back.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ did: 'did:plc:abc123' }), { status: 200 }))
    );
    expect(await resolveRoomInput(link!.url)).toBe(COLLECTION_URI);
  });

  it('has no link without a resolved handle', () => {
    expect(collectionPageLink(COLLECTION_URI, null)).toBeNull();
    expect(collectionPageLink(COLLECTION_URI, undefined)).toBeNull();
    expect(collectionPageLink(COLLECTION_URI, '')).toBeNull();
    // Semble's page is handle-keyed; a DID or the appview's failure sentinel
    // would build a URL that 404s.
    expect(collectionPageLink(COLLECTION_URI, 'did:plc:abc123')).toBeNull();
    expect(collectionPageLink(COLLECTION_URI, 'handle.invalid')).toBeNull();
  });

  it('round-trips a Margin collection back to its page', async () => {
    const link = collectionPageLink(MARGIN_URI, 'disnetdev.com');
    expect(link).toEqual({
      url: 'https://margin.at/disnetdev.com/collection/3muahss6xki2b',
      provider: 'Margin',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ did: 'did:plc:abc123' }), { status: 200 }))
    );
    expect(await resolveRoomInput(link!.url)).toBe(MARGIN_URI);
  });

  it('links a Margin collection by DID when the handle did not resolve', async () => {
    // Margin's page accepts a DID in the handle slot, so the link never depends
    // on the appview answering.
    const byDid = 'https://margin.at/did:plc:abc123/collection/3muahss6xki2b';
    expect(collectionPageLink(MARGIN_URI, null)?.url).toBe(byDid);
    expect(collectionPageLink(MARGIN_URI, 'handle.invalid')?.url).toBe(byDid);
    expect(await resolveRoomInput(byDid)).toBe(MARGIN_URI);
  });

  it('has no link for an unknown provider or a malformed uri', () => {
    expect(
      collectionPageLink('at://did:plc:abc123/other.collection/3muahss6xki2b', 'x.com')
    ).toBeNull();
    expect(collectionPageLink('not a uri', 'disnetdev.com')).toBeNull();
  });
});

describe('scanReadAlongs', () => {
  it('lists a followed account’s rooms off their PDS', async () => {
    const fetchMock = vi.fn(async (_input: string) =>
      recordsResponse([
        { subject: COLLECTION_URI, createdAt: '2026-09-01T00:00:00Z' },
        { subject: OTHER_URI },
      ])
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(await scanReadAlongs(FOLLOW)).toEqual([
      {
        did: FOLLOW.did,
        subject: COLLECTION_URI,
        handle: FOLLOW.handle,
        displayName: undefined,
        avatar: FOLLOW.avatar,
        createdAt: '2026-09-01T00:00:00Z',
      },
      {
        did: FOLLOW.did,
        subject: OTHER_URI,
        handle: FOLLOW.handle,
        displayName: undefined,
        avatar: FOLLOW.avatar,
        createdAt: undefined,
      },
    ]);
    const url = new URL(fetchMock.mock.calls[0]![0]);
    expect(url.pathname).toBe('/xrpc/com.atproto.repo.listRecords');
    expect(url.searchParams.get('repo')).toBe(FOLLOW.did);
    expect(url.searchParams.get('collection')).toBe('app.skyreader.reading.readAlong');
  });

  it('skips malformed subjects and keeps the first of a repeated room', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        recordsResponse([
          { subject: COLLECTION_URI, createdAt: 'first' },
          { subject: COLLECTION_URI, createdAt: 'rejoined' },
          { subject: 'not a uri' },
          { createdAt: '2026-09-01T00:00:00Z' },
        ])
      )
    );
    const rows = await scanReadAlongs(FOLLOW);
    expect(rows.map((r) => r.subject)).toEqual([COLLECTION_URI]);
    expect(rows[0]!.createdAt).toBe('first');
  });

  it('forgets a cached PDS that will not answer, so the next pass re-resolves', async () => {
    vi.mocked(forgetFollowPds).mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 400 }))
    );
    expect(await scanReadAlongs(FOLLOW)).toEqual([]);
    expect(forgetFollowPds).toHaveBeenCalledWith(FOLLOW.did);

    vi.mocked(forgetFollowPds).mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      })
    );
    expect(await scanReadAlongs(FOLLOW)).toEqual([]);
    expect(forgetFollowPds).toHaveBeenCalledWith(FOLLOW.did);
  });

  it('gives up quietly on an account whose PDS will not resolve', async () => {
    vi.mocked(pdsForFollow).mockResolvedValueOnce(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await scanReadAlongs(FOLLOW)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('aggregateFollowedRooms', () => {
  const row = (did: string, subject: string) => ({ did, subject, handle: `${did}.test` });

  it('groups readers by room, busiest first', () => {
    const rooms = aggregateFollowedRooms([
      row('did:plc:a', OTHER_URI),
      row('did:plc:b', COLLECTION_URI),
      row('did:plc:c', COLLECTION_URI),
    ]);
    expect(rooms.map((r) => r.subject)).toEqual([COLLECTION_URI, OTHER_URI]);
    expect(rooms[0]!.readers.map((r) => r.did)).toEqual(['did:plc:b', 'did:plc:c']);
  });

  it('counts a reader once per room', () => {
    const rooms = aggregateFollowedRooms([
      row('did:plc:a', COLLECTION_URI),
      row('did:plc:a', COLLECTION_URI),
    ]);
    expect(rooms).toHaveLength(1);
    expect(rooms[0]!.readers).toHaveLength(1);
  });
});
