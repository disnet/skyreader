// Named `.component.test.ts` so it runs in the project that compiles runes —
// the store is a `.svelte.ts` module and `$state` needs the Svelte plugin.
import { beforeEach, describe, expect, it } from 'vitest';
import { feedStatusStore } from './feedStatus.svelte';

const FEED = 'https://example.com/feed.xml';
const OTHER = 'https://other.example/feed.xml';

describe('feedStatusStore under the timeline path', () => {
  beforeEach(() => {
    feedStatusStore.clearAll();
  });

  // The regression: boot used to seed every subscription with a 'pending' status
  // that rendered a spinner in the sidebar. Under the timeline path nothing
  // per-feed ever arrives to settle it — reads are served from the archive — so
  // a feed carries no status at all until the crawler's health report says it is
  // broken.
  it('reports no status for a subscribed feed nobody has fetched', () => {
    expect(feedStatusStore.getStatus(FEED)).toBeUndefined();
    expect(feedStatusStore.getStatusMessage(FEED)).toBe('');
    expect(feedStatusStore.canFetch(FEED)).toBe(true);
  });

  it('leaves a feed clean when a steady-state poll reports nothing broken', () => {
    feedStatusStore.applyHealthSnapshot({}, [FEED, OTHER]);

    expect(feedStatusStore.getStatus(FEED)).toBeUndefined();
    expect(feedStatusStore.errorFeeds).toEqual([]);
  });

  it('flags a feed the crawler reports broken, and clears it when it drops out', () => {
    feedStatusStore.applyHealthSnapshot({ [FEED]: { errorCount: 2, error: 'HTTP 404' } }, [
      FEED,
      OTHER,
    ]);
    expect(feedStatusStore.getStatus(FEED)?.status).toBe('error');
    expect(feedStatusStore.getStatus(OTHER)).toBeUndefined();

    feedStatusStore.applyHealthSnapshot({}, [FEED, OTHER]);
    expect(feedStatusStore.getStatus(FEED)?.status).toBe('ready');
    expect(feedStatusStore.errorFeeds).toEqual([]);
  });
});
