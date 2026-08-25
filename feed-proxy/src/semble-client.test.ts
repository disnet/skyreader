import { describe, expect, it, afterEach, spyOn } from 'bun:test';
import { fetchSembleContext, isEmptySembleContext } from './semble-client';

const ARTICLE = 'https://example.com/the-article';

// Answer each of the five URL-API calls with a canned body; anything not named
// resolves empty, so a test only has to say the part it cares about.
function mockSemble(bodies: Record<string, unknown>) {
  return spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
    const nsid = new URL(String(input)).pathname.split('/').pop()!;
    return new Response(JSON.stringify(bodies[nsid] ?? {}), {
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch);
}

const edge = (target: string, type: string, id?: string, curator = 'did:plc:eve') => ({
  connection: { ...(id ? { id } : {}), type, curator: { id: curator, handle: 'eve.test' } },
  source: { url: ARTICLE },
  target: { url: target, metadata: { title: target } },
});

describe('fetchSembleContext connections', () => {
  afterEach(() => {
    (globalThis.fetch as ReturnType<typeof spyOn>).mockRestore?.();
  });

  it('keeps every edge when Semble sends no connection ids', async () => {
    mockSemble({
      'network.cosmik.connection.getForUrl': {
        connections: [
          edge('https://a.example/one', 'SUPPORTS'),
          edge('https://b.example/two', 'SUPPORTS'),
          edge('https://c.example/three', 'REFUTES'),
        ],
      },
    });

    const context = await fetchSembleContext(ARTICLE);
    expect(context?.connections.map((c) => c.other.url)).toEqual([
      'https://a.example/one',
      'https://b.example/two',
      'https://c.example/three',
    ]);
    // The fallback key still has to be a key: unique, so the reader can list them.
    expect(new Set(context!.connections.map((c) => c.id)).size).toBe(3);
  });

  it('still collapses a genuine duplicate without an id', async () => {
    mockSemble({
      'network.cosmik.connection.getForUrl': {
        connections: [
          edge('https://a.example/one', 'SUPPORTS'),
          edge('https://a.example/one', 'SUPPORTS'),
        ],
      },
    });

    const context = await fetchSembleContext(ARTICLE);
    expect(context?.connections).toHaveLength(1);
  });

  it('keeps the same claim from two curators as two edges', async () => {
    mockSemble({
      'network.cosmik.connection.getForUrl': {
        connections: [
          edge('https://a.example/one', 'SUPPORTS', undefined, 'did:plc:eve'),
          edge('https://a.example/one', 'SUPPORTS', undefined, 'did:plc:frank'),
        ],
      },
    });

    const context = await fetchSembleContext(ARTICLE);
    expect(context?.connections.map((c) => c.curator.did)).toEqual([
      'did:plc:eve',
      'did:plc:frank',
    ]);
  });

  it('prefers Semble’s own id when it sends one', async () => {
    mockSemble({
      'network.cosmik.connection.getForUrl': {
        connections: [
          edge('https://a.example/one', 'SUPPORTS', 'conn-1'),
          edge('https://a.example/one', 'SUPPORTS', 'conn-2'),
        ],
      },
    });

    const context = await fetchSembleContext(ARTICLE);
    expect(context?.connections.map((c) => c.id)).toEqual(['conn-1', 'conn-2']);
  });
});

// Collections and notes key lists on the reader's side too, and a duplicate key
// there is fatal, not cosmetic — Svelte throws on it in production as well.
describe('fetchSembleContext collections and notes', () => {
  afterEach(() => {
    (globalThis.fetch as ReturnType<typeof spyOn>).mockRestore?.();
  });

  const collection = (name: string, id?: string) => ({
    ...(id ? { id } : {}),
    name,
    author: { id: 'did:plc:erin', handle: 'erin.test' },
  });

  it('gives id-less collections distinct keys', async () => {
    mockSemble({
      'network.cosmik.collection.getForUrl': {
        collections: [collection('Reading'), collection('Protocol design')],
      },
    });

    const context = await fetchSembleContext(ARTICLE);
    expect(context?.collections.map((c) => c.name)).toEqual(['Reading', 'Protocol design']);
    expect(new Set(context!.collections.map((c) => c.id)).size).toBe(2);
    expect(context!.collections.every((c) => c.id)).toBe(true);
  });

  it('collapses the same collection returned twice', async () => {
    mockSemble({
      'network.cosmik.collection.getForUrl': {
        collections: [collection('Reading', 'col-1'), collection('Reading', 'col-1')],
      },
    });

    expect((await fetchSembleContext(ARTICLE))?.collections).toHaveLength(1);
  });

  it('gives id-less notes distinct keys and drops a repeat', async () => {
    mockSemble({
      'network.cosmik.card.getNoteCardsForUrl': {
        notes: [
          { note: 'First thought', author: { id: 'did:plc:erin', handle: 'erin.test' } },
          { note: 'Second thought', author: { id: 'did:plc:erin', handle: 'erin.test' } },
          { note: 'First thought', author: { id: 'did:plc:erin', handle: 'erin.test' } },
        ],
      },
    });

    const context = await fetchSembleContext(ARTICLE);
    expect(context?.notes.map((n) => n.text)).toEqual(['First thought', 'Second thought']);
    expect(new Set(context!.notes.map((n) => n.id)).size).toBe(2);
  });
});

// Semble keys a card by the URL string, so `/post` and `/post/` are two keys —
// and a site whose canonical carries the slash holds everything under the form
// our normalizer trims away. Asking only the trimmed form reads as "nobody
// saved this" while the lane's own count says a dozen people did.
describe('fetchSembleContext url variants', () => {
  afterEach(() => {
    (globalThis.fetch as ReturnType<typeof spyOn>).mockRestore?.();
  });

  const SLASHED = `${ARTICLE}/`;

  // Answer per (nsid, url) instead of per nsid: only the named URL holds anything.
  function mockSembleForUrl(held: string, bodies: Record<string, unknown>) {
    return spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
      const parsed = new URL(String(input));
      const nsid = parsed.pathname.split('/').pop()!;
      const asked = parsed.searchParams.get('url');
      const body = asked === held ? (bodies[nsid] ?? {}) : {};
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch);
  }

  const library = {
    user: { id: 'did:plc:erin', handle: 'erin.test', name: 'Erin' },
    card: { note: { text: 'Filed this' }, createdAt: '2026-03-20T00:00:00.000Z' },
  };

  it('follows the trailing-slash form when that is the one Semble holds', async () => {
    mockSembleForUrl(SLASHED, {
      'network.cosmik.card.getUrlMetadata': { stats: { libraryCount: 15, collectionCount: 16 } },
      'network.cosmik.card.getLibrariesForUrl': { libraries: [library] },
    });

    const context = await fetchSembleContext(ARTICLE);
    expect(context?.savers.map((s) => s.author.handle)).toEqual(['erin.test']);
    expect(context?.stats?.saves).toBe(15);
    // The card page has to point at the URL the card actually lives under.
    expect(context?.cardUrl).toBe(`https://semble.so/url/${encodeURIComponent(SLASHED)}`);
  });

  it('keeps the canonical trimmed form when that is the one Semble holds', async () => {
    mockSembleForUrl(ARTICLE, {
      'network.cosmik.card.getUrlMetadata': { stats: { libraryCount: 3 } },
      'network.cosmik.card.getLibrariesForUrl': { libraries: [library] },
    });

    const context = await fetchSembleContext(ARTICLE);
    expect(context?.savers).toHaveLength(1);
    expect(context?.cardUrl).toBe(`https://semble.so/url/${encodeURIComponent(ARTICLE)}`);
  });

  it('reports an empty card as empty rather than picking a form at random', async () => {
    mockSembleForUrl('https://nothing.example/', {});

    const context = await fetchSembleContext(ARTICLE);
    expect(context && isEmptySembleContext(context)).toBe(true);
    expect(context?.cardUrl).toBe(`https://semble.so/url/${encodeURIComponent(ARTICLE)}`);
  });
});
