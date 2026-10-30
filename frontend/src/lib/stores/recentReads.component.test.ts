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

const { recentReadsStore } = await import('./recentReads.svelte');

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
  it('moves a re-read article to the top instead of listing it twice', () => {
    recentReadsStore.record('https://a.test/first', 'First');
    recentReadsStore.record('https://b.test/second', 'Second');
    recentReadsStore.record('https://a.test/first', 'First');

    expect(recentReadsStore.entries.map((e) => e.url)).toEqual([
      'https://a.test/first',
      'https://b.test/second',
    ]);
  });

  it('knows a tracking-param variant is the same article', () => {
    recentReadsStore.record('https://a.test/post?utm_source=rss', 'Post');
    recentReadsStore.record('https://a.test/post', 'Post again');
    expect(recentReadsStore.entries.map((e) => e.title)).toEqual(['Post again']);
  });

  it('refreshes the time of an article re-read days later', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    recentReadsStore.record('https://a.test/first', 'First');
    vi.setSystemTime(Date.now() + 3 * 24 * 60 * 60 * 1000);
    recentReadsStore.record('https://a.test/first', 'First');

    expect(recentReadsStore.entries[0].at).toBe(Date.now());
  });

  it("doesn't overwrite what another tab recorded", () => {
    recentReadsStore.record('https://a.test/first', 'First');
    // Another tab writes straight to storage.
    const key = `skyreader-recent-reads:${did}`;
    const theirs = JSON.parse(localStorage.getItem(key)!);
    localStorage.setItem(
      key,
      JSON.stringify([{ url: 'https://c.test/other-tab', at: Date.now() }, ...theirs])
    );
    recentReadsStore.record('https://b.test/second', 'Second');

    expect(recentReadsStore.entries.map((e) => e.url)).toEqual([
      'https://b.test/second',
      'https://c.test/other-tab',
      'https://a.test/first',
    ]);
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
