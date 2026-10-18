// Named `.component.test.ts` so it runs in the project that compiles runes.
//
// status() tells the Discussion whether the counts are still coming: an empty
// answer while the proxy enriches is "not yet", a failed lookup is "not now",
// and asking again puts a failed URL back to "not yet".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ user: { did: 'did:plc:me' } as { did: string } | null }));
const fetchArticleMentions = vi.fn();
vi.mock('$lib/services/api', () => ({
  api: {
    fetchArticleMentions: (...a: unknown[]) => fetchArticleMentions(...a),
    fetchGuestArticleMentions: (...a: unknown[]) => fetchArticleMentions(...a),
  },
}));
vi.mock('$lib/stores/auth.svelte', () => ({ auth }));

const URL_A = 'https://a.example/x';

async function freshStore() {
  vi.resetModules();
  return (await import('./articleMentions.svelte')).articleMentionsStore;
}

async function settle() {
  await vi.advanceTimersByTimeAsync(100);
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchArticleMentions.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('articleMentionsStore.status', () => {
  it('is pending until an answer, then ready', async () => {
    const store = await freshStore();
    fetchArticleMentions.mockResolvedValue({
      items: [{ url: URL_A, total: 2, lanes: [] }],
    });
    store.fetch(URL_A);
    expect(store.status(URL_A)).toBe('pending');
    await settle();
    expect(store.status(URL_A)).toBe('ready');
  });

  it('waits out the first re-poll of an empty, still-enriching answer only', async () => {
    const store = await freshStore();
    fetchArticleMentions.mockResolvedValue({
      items: [{ url: URL_A, total: 0, lanes: [], pending: true }],
    });
    store.fetch(URL_A);
    await settle();
    expect(store.status(URL_A)).toBe('pending');
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
    expect(store.status(URL_A)).toBe('ready');
  });

  it('is unavailable after a failure, and pending again when asked again', async () => {
    const store = await freshStore();
    fetchArticleMentions.mockRejectedValueOnce(new Error('down'));
    store.fetch(URL_A);
    await settle();
    expect(store.status(URL_A)).toBe('unavailable');
    fetchArticleMentions.mockResolvedValue({ items: [{ url: URL_A, total: 1, lanes: [] }] });
    store.fetch(URL_A);
    expect(store.status(URL_A)).toBe('pending');
    await settle();
    expect(store.status(URL_A)).toBe('ready');
  });
});
