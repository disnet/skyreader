// Mounted-project test (jsdom): the store reads localStorage and runes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let did: string | null = null;
let run = 0;
vi.mock('$lib/stores/auth.svelte', () => ({
  auth: {
    get user() {
      return did ? { did, handle: 'reader.test' } : null;
    },
  },
}));

const { recentReadsStore, PREVIOUS_READ_WINDOW_MS } = await import('./recentReads.svelte');

beforeEach(() => {
  localStorage.clear();
  // The store keeps what it loaded per account, so each test reads as a fresh one.
  run += 1;
  did = `did:plc:reader${run}`;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('recentReadsStore', () => {
  it('names the article read before this one, not this one', () => {
    recentReadsStore.record('https://a.test/first', 'First');
    recentReadsStore.record('https://b.test/second', 'Second');

    expect(recentReadsStore.previousBefore('https://b.test/second')?.title).toBe('First');
    // Same article in another URL variant is still "this one".
    expect(recentReadsStore.previousBefore('https://b.test/second/')?.title).toBe('First');
  });

  it('moves a re-read article to the top instead of listing it twice', () => {
    recentReadsStore.record('https://a.test/first', 'First');
    recentReadsStore.record('https://b.test/second', 'Second');
    recentReadsStore.record('https://a.test/first', 'First');

    expect(recentReadsStore.entries.map((e) => e.url)).toEqual([
      'https://a.test/first',
      'https://b.test/second',
    ]);
  });

  it('offers nothing once the previous read is days old', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    recentReadsStore.record('https://a.test/first', 'First');
    vi.setSystemTime(Date.now() + PREVIOUS_READ_WINDOW_MS + 1);
    recentReadsStore.record('https://b.test/second', 'Second');

    expect(recentReadsStore.previousBefore('https://b.test/second')).toBeNull();
  });

  it('keeps each account to itself, and tracks no guest', () => {
    recentReadsStore.record('https://a.test/first', 'First');
    did = 'did:plc:someone-else';
    expect(recentReadsStore.entries).toEqual([]);

    did = null;
    recentReadsStore.record('https://b.test/second', 'Second');
    expect(recentReadsStore.entries).toEqual([]);
  });

  it('ignores what is not a web page', () => {
    recentReadsStore.record('at://did:plc:x/app.bsky.feed.post/1', 'A post');
    expect(recentReadsStore.entries).toEqual([]);
  });
});
