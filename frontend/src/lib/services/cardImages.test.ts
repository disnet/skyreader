import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cacheableImageUrls,
  clearCardImages,
  keepCardImages,
  MAX_CARD_IMAGES,
  MAX_OPAQUE_IMAGES,
} from './cardImages';

describe('cacheableImageUrls', () => {
  const own = ['https://skyreader.app', 'https://api.skyreader.app'];

  it('keeps https pictures from other sites, normalized and deduped', () => {
    expect(
      cacheableImageUrls(
        [
          'https://img.example.com/a b.jpg',
          'https://img.example.com/a%20b.jpg#frag',
          'https://cdn.example.org/c.png',
        ],
        own
      )
    ).toEqual(['https://img.example.com/a%20b.jpg', 'https://cdn.example.org/c.png']);
  });

  it('leaves out our own origins, plain http and anything unparseable', () => {
    expect(
      cacheableImageUrls(
        [
          'https://api.skyreader.app/api/saved/rk/asset?path=cover.jpg',
          'https://skyreader.app/icons/icon.png',
          'http://insecure.example.com/a.jpg',
          'data:image/png;base64,AAAA',
          'not a url',
        ],
        own
      )
    ).toEqual([]);
  });

  it('caps the set', () => {
    const urls = Array.from({ length: MAX_CARD_IMAGES + 20 }, (_, i) => `https://e.com/${i}.jpg`);
    expect(cacheableImageUrls(urls, own)).toHaveLength(MAX_CARD_IMAGES);
  });
});

// A Cache API and fetch just big enough for sync(): a Map of url → Response.
function fakeEnv(respond: (url: string, mode: RequestMode) => Response | Error) {
  const store = new Map<string, Response>();
  const cache = {
    keys: async () => [...store.keys()].map((url) => ({ url }) as Request),
    match: async (req: Request | string) => store.get(typeof req === 'string' ? req : req.url),
    put: async (url: string, res: Response) => void store.set(url, res),
    delete: async (req: Request | string) => store.delete(typeof req === 'string' ? req : req.url),
  };
  vi.stubGlobal('caches', {
    open: async () => cache,
    delete: async () => {
      store.clear();
      return true;
    },
  });
  vi.stubGlobal('location', { origin: 'https://skyreader.app' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const out = respond(url, init.mode!);
      if (out instanceof Error) throw out;
      return out;
    })
  );
  return store;
}

function opaque(): Response {
  const res = new Response(null, { status: 200 });
  Object.defineProperty(res, 'type', { value: 'opaque' });
  return res;
}

async function settle() {
  // keepCardImages runs detached; let its passes finish.
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('keepCardImages', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('stores CORS copies, prunes what the set no longer holds', async () => {
    const store = fakeEnv(
      () => new Response('x', { status: 200, headers: { 'content-type': 'image/png' } })
    );
    keepCardImages(['https://a.example/1.png', 'https://a.example/2.png']);
    await settle();
    expect([...store.keys()].sort()).toEqual([
      'https://a.example/1.png',
      'https://a.example/2.png',
    ]);
    keepCardImages(['https://a.example/2.png']);
    await settle();
    expect([...store.keys()]).toEqual(['https://a.example/2.png']);
  });

  it('falls back to opaque copies, but only up to the allowance', async () => {
    const store = fakeEnv((_url, mode) => (mode === 'cors' ? new TypeError('CORS') : opaque()));
    const urls = Array.from({ length: MAX_OPAQUE_IMAGES + 5 }, (_, i) => `https://b.example/${i}`);
    keepCardImages(urls);
    await settle();
    expect(store.size).toBe(MAX_OPAQUE_IMAGES);
  });

  it('skips a CORS error response and a non-image', async () => {
    const store = fakeEnv((url) =>
      url.endsWith('404')
        ? new Response('', { status: 404 })
        : new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })
    );
    keepCardImages(['https://c.example/404', 'https://c.example/page']);
    await settle();
    expect(store.size).toBe(0);
  });

  it('stops writing once cleared', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const store = fakeEnv(
      () => new Response('x', { status: 200, headers: { 'content-type': 'image/png' } })
    );
    const realFetch = globalThis.fetch as unknown as (...a: unknown[]) => Promise<Response>;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (...a: unknown[]) => {
        await gate;
        return realFetch(...a);
      })
    );
    keepCardImages(['https://d.example/1.png']);
    keepCardImages(['https://d.example/2.png']); // queued behind the first
    await settle();
    await clearCardImages();
    release();
    await settle();
    expect(store.size).toBe(0);
  });
});
