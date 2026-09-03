import { describe, it, expect, vi, afterEach } from 'vitest';
import { collectionOwnerDid, collectionPageLink, resolveRoomInput } from './rooms';

const COLLECTION_URI = 'at://did:plc:abc123/network.cosmik.collection/3muahss6xki2b';

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

  it('rejects everything else', async () => {
    expect(await resolveRoomInput('')).toBeNull();
    expect(await resolveRoomInput('not a link')).toBeNull();
    expect(await resolveRoomInput('at://did:plc:abc123/only-two')).toBeNull();
    expect(await resolveRoomInput('https://semble.so/url/whatever')).toBeNull();
    expect(await resolveRoomInput('https://example.com/profile/x/collections/y')).toBeNull();
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

  it('has no link for a provider with no collection page', () => {
    const margin = 'at://did:plc:abc123/at.margin.collection/3muahss6xki2b';
    expect(collectionPageLink(margin, 'disnetdev.com')).toBeNull();
    expect(collectionPageLink('not a uri', 'disnetdev.com')).toBeNull();
  });
});
