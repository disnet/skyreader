import { describe, expect, it, afterEach, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initDatabase } from './app';
import { resolvePdsUrl } from './did-resolver';

const DID = 'did:plc:resolver123';
const PDS = 'https://pds.example.com';

function didDoc(id: string) {
  return JSON.stringify({
    id,
    service: [
      {
        id: '#atproto_pds',
        type: 'AtprotoPersonalDataServer',
        serviceEndpoint: PDS,
      },
    ],
  });
}

function freshDb() {
  const db = new Database(':memory:');
  initDatabase(db);
  return db;
}

describe('resolvePdsUrl', () => {
  let fetchMock: ReturnType<typeof spyOn> | undefined;
  afterEach(() => {
    fetchMock?.mockRestore();
    fetchMock = undefined;
  });

  it('resolves a did:plc via plc.directory and caches it', async () => {
    const db = freshDb();
    let calledUrl = '';
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
      calledUrl = String(input);
      return new Response(didDoc(DID));
    }) as unknown as typeof fetch);

    expect(await resolvePdsUrl(db, DID)).toBe(PDS);
    expect(calledUrl).toBe(`https://plc.directory/${DID}`);

    // Second call is served from the SQLite cache — no extra fetch.
    expect(await resolvePdsUrl(db, DID)).toBe(PDS);
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it('resolves a did:web from /.well-known/did.json', async () => {
    const db = freshDb();
    let calledUrl = '';
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
      calledUrl = String(input);
      return new Response(didDoc('did:web:example.com'));
    }) as unknown as typeof fetch);

    expect(await resolvePdsUrl(db, 'did:web:example.com')).toBe(PDS);
    expect(calledUrl).toBe('https://example.com/.well-known/did.json');
  });

  it('caches a null result for an unresolvable DID (no retry within TTL)', async () => {
    const db = freshDb();
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch);

    expect(await resolvePdsUrl(db, DID)).toBeNull();
    expect(await resolvePdsUrl(db, DID)).toBeNull();
    // The null was cached, so plc.directory was hit only once.
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it('re-resolves once the cache TTL expires', async () => {
    const db = freshDb();
    // A stale cache entry (resolved 2 days ago, past the 1-day TTL).
    db.run('INSERT INTO did_cache (did, pds_url, cached_at) VALUES (?, ?, ?)', [
      DID,
      'https://old.pds.example.com',
      Date.now() - 2 * 24 * 60 * 60 * 1000,
    ]);
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      return new Response(didDoc(DID));
    }) as unknown as typeof fetch);

    // Returns the freshly-resolved PDS, not the stale cached one.
    expect(await resolvePdsUrl(db, DID)).toBe(PDS);
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it('returns null for an unsupported DID method without fetching', async () => {
    const db = freshDb();
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      throw new Error('should not fetch');
    }) as unknown as typeof fetch);

    expect(await resolvePdsUrl(db, 'did:example:nope')).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(0);
  });
});
