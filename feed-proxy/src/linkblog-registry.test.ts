import { describe, expect, it, afterEach, beforeEach, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initDatabase } from './app';
import { getLinkblogRegistry } from './linkblog-registry';
import { resetConstellationBreaker, setConstellationLimits } from './constellation-client';

const MARKER_URL = 'https://skyreader.app/linkblog';

function freshDb(): Database {
  const db = new Database(':memory:');
  initDatabase(db);
  return db;
}

function seedCache(db: Database, dids: string[], cachedAt: number): void {
  db.run('INSERT INTO linkblog_registry_cache (marker, dids_json, cached_at) VALUES (?, ?, ?)', [
    MARKER_URL,
    JSON.stringify(dids),
    cachedAt,
  ]);
}

beforeEach(() => {
  resetConstellationBreaker();
  setConstellationLimits();
});
afterEach(() => {
  (globalThis.fetch as ReturnType<typeof spyOn>).mockRestore?.();
  resetConstellationBreaker();
  setConstellationLimits();
});

describe('getLinkblogRegistry', () => {
  it('unions paginated results across both marked collections', async () => {
    // Page 1 of each collection carries a cursor; page 2 ends it. The two
    // collections overlap on did:c, which must appear once.
    const pages: Record<string, { linking_dids: string[]; cursor?: string }> = {
      'site.standard.publication|': { linking_dids: ['did:a', 'did:b'], cursor: 'p2' },
      'site.standard.publication|p2': { linking_dids: ['did:c'] },
      'site.standard.document|': { linking_dids: ['did:c', 'did:d'] },
    };
    spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/links/distinct-dids');
      expect(url.searchParams.get('target')).toBe(MARKER_URL);
      const key = `${url.searchParams.get('collection')}|${url.searchParams.get('cursor') ?? ''}`;
      return new Response(JSON.stringify(pages[key] ?? { linking_dids: [] }));
    }) as unknown as typeof fetch);

    const db = freshDb();
    expect((await getLinkblogRegistry(db)).sort()).toEqual(['did:a', 'did:b', 'did:c', 'did:d']);

    // Cached — a second call answers from SQLite without touching the network.
    const callsBefore = (globalThis.fetch as ReturnType<typeof spyOn>).mock.calls.length;
    expect((await getLinkblogRegistry(db)).sort()).toEqual(['did:a', 'did:b', 'did:c', 'did:d']);
    expect((globalThis.fetch as ReturnType<typeof spyOn>).mock.calls.length).toBe(callsBefore);
  });

  it('serves the stale cache without a fetch while the shared breaker is open', async () => {
    const spy = spyOn(globalThis, 'fetch').mockImplementation(
      (async () => new Response('err', { status: 503 })) as unknown as typeof fetch
    );
    const db = freshDb();
    seedCache(db, ['did:stale'], Date.now() - 60 * 60 * 1000); // an hour old

    // First refresh attempt: 5xx on both collections, so the registry falls back
    // to the stale cache (and its failures count toward the shared breaker).
    expect(await getLinkblogRegistry(db)).toEqual(['did:stale']);
    expect(spy.mock.calls.length).toBeGreaterThan(0);

    // Enough failures from anywhere in the process open the breaker; from then on
    // the registry stops issuing requests at all and keeps serving stale.
    for (let i = 0; i < 3; i++) await getLinkblogRegistry(db);
    const callsBefore = spy.mock.calls.length;
    expect(await getLinkblogRegistry(db)).toEqual(['did:stale']);
    expect(spy.mock.calls.length).toBe(callsBefore);
  });

  it('returns an empty list when Constellation fails and nothing is cached', async () => {
    spyOn(globalThis, 'fetch').mockImplementation((async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch);
    expect(await getLinkblogRegistry(freshDb())).toEqual([]);
  });
});
