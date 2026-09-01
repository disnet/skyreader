import { api } from '$lib/services/api';
import { itemLabelsStore } from './itemLabels.svelte';
import { MAX_ARTICLES_PER_FEED } from '$lib/services/articleMerge';
import type { Article, Subscription } from '$lib/types';

/**
 * Older items for one feed, read straight from the server-side archive.
 *
 * Each device keeps only the newest K articles per feed and trims oldest-first,
 * so an unread item older than that simply vanished from the only copy the
 * reader could see. D1 never pruned it — "D1 is the archive … no pruning" — but
 * that is cold comfort to someone who watched an article disappear and
 * reasonably called it lost data.
 *
 * These items are deliberately TRANSIENT: they are never merged into the capped
 * Dexie set. This is an archive view, not new membership — merging would push
 * the local set past K again and re-open the divergence the canonical window
 * closes. Read state still applies (the server annotates it, and marking one
 * read goes through the normal path), so the view is live, just not resident.
 */
const PAGE_SIZE = 30;

function createFeedArchiveStore() {
  // The subscription these items belong to. Switching feeds resets everything —
  // nothing here is worth keeping across a navigation.
  let subscriptionId = $state<number | null>(null);
  let items = $state<Article[]>([]);
  let loading = $state(false);
  let exhausted = $state(false);
  let error = $state<string | null>(null);

  function reset(nextSubscriptionId: number | null) {
    subscriptionId = nextSubscriptionId;
    items = [];
    loading = false;
    exhausted = false;
    error = null;
  }

  /**
   * Load the next page below the local window.
   *
   * The first page starts at offset K — exactly where the local set stops — so
   * the archive picks up where the list left off with nothing repeated and
   * nothing skipped.
   */
  async function loadMore(sub: Subscription) {
    if (!sub.id || !sub.feedUrl) return;
    if (sub.sourceType && sub.sourceType !== 'rss') return;
    if (loading || exhausted) return;
    if (subscriptionId !== sub.id) reset(sub.id);

    loading = true;
    error = null;
    try {
      const offset = MAX_ARTICLES_PER_FEED + items.length;
      const feed = await api.fetchFeedArchive(sub.feedUrl, offset, PAGE_SIZE);
      const fetched = feed.items ?? [];

      const seen = new Set(items.map((a) => a.guid));
      const fresh: Article[] = [];
      for (const item of fetched) {
        if (seen.has(item.guid)) continue;
        seen.add(item.guid);
        fresh.push({
          subscriptionId: sub.id,
          guid: item.guid,
          url: item.url,
          title: item.title,
          author: item.author,
          content: item.content,
          summary: item.summary,
          imageUrl: item.imageUrl,
          publishedAt: item.publishedAt,
          fetchedAt: Date.now(),
          contentTruncated: item.contentTruncated || undefined,
        });
      }

      // Read state rides the response; apply it additively, same as the timeline
      // path, so an item read on another device doesn't come back looking unread.
      const readGuids = fetched.filter((i) => i.read).map((i) => i.guid);
      if (readGuids.length > 0) {
        await itemLabelsStore.applyAnnotatedReads(readGuids, 'article');
      }

      items = [...items, ...fresh];
      // A short page is the bottom of the archive. A full page that was entirely
      // duplicates would otherwise loop forever, so treat that as the end too.
      if (fetched.length < PAGE_SIZE || fresh.length === 0) exhausted = true;
    } catch (e) {
      console.error('Failed to load older items:', e);
      error = 'Could not load older items';
    } finally {
      loading = false;
    }
  }

  return {
    get items() {
      return subscriptionId === null ? [] : items;
    },
    get loading() {
      return loading;
    },
    get exhausted() {
      return exhausted;
    },
    get error() {
      return error;
    },
    get subscriptionId() {
      return subscriptionId;
    },
    reset,
    loadMore,
  };
}

export const feedArchiveStore = createFeedArchiveStore();
