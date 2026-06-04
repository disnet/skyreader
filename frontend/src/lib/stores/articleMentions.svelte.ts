// Network-wide article mentions (Phase 5).
//
// For a regular article, ask the backend (which asks the feed-proxy, which asks
// Constellation) "who across the Atmosphere referenced this URL, and how?" —
// sliced into lanes (linkblog notes / Bluesky posts / margin.at highlights /
// Semble saves). This is *adornment only*: it loads lazily and degrades silently
// (no line shown) when there's nothing or the lookup is unavailable.
//
// Decoupled from article ingest on purpose. Article rows are inserted once and
// never updated on re-fetch (articleMerge), but mention counts accumulate over
// hours/days — so we fetch by URL, not off the cached article. Requests are
// batched (cards mount in bursts) and deduped; results memoized per URL for the
// session. The proxy caches the expensive work and enriches cold URLs in the
// background, so a first miss is retried a couple times shortly after.

import { api } from '$lib/services/api';
import type { ArticleMentions } from '$lib/types';

const FLUSH_DELAY_MS = 80;
const MAX_BATCH = 50;
const OFFLINE_RETRY_MS = 4000;
// Cold URLs enrich in the background proxy-side; re-poll to catch them. A single
// retry loses the race when Constellation is slow, so retry twice with a
// lengthening backoff (5s, then 10s) before giving up until the card remounts.
const COLD_RETRY_MS = 5000;
const MAX_COLD_RETRIES = 2;

function createArticleMentionsStore() {
  let cache = $state<Map<string, ArticleMentions>>(new Map());

  // URLs we've already enqueued at least once (dedup the always-on per-card call).
  const requested = new Set<string>();
  // How many cold retries each URL has had (bounds re-polling to MAX_COLD_RETRIES).
  const coldRetries = new Map<string, number>();
  let pending = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleFlush(delay = FLUSH_DELAY_MS) {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, delay);
  }

  async function flush() {
    if (pending.size === 0) return;

    // Hold requests until we're online, rather than firing doomed fetches.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      scheduleFlush(OFFLINE_RETRY_MS);
      return;
    }

    const all = [...pending];
    const batch = all.slice(0, MAX_BATCH);
    pending = new Set(all.slice(MAX_BATCH));
    if (pending.size > 0) scheduleFlush();

    try {
      const res = await api.fetchArticleMentions(batch);
      const next = new Map(cache);
      for (const item of res.items ?? []) {
        next.set(item.url, item);
        // A zero may be genuine or just not-yet-enriched; retry a couple times
        // with a lengthening backoff to outlast a slow background enrichment.
        if (item.total === 0) {
          const attempts = coldRetries.get(item.url) ?? 0;
          if (attempts < MAX_COLD_RETRIES) {
            coldRetries.set(item.url, attempts + 1);
            setTimeout(() => requeue(item.url), COLD_RETRY_MS * (attempts + 1));
          }
        }
      }
      cache = next;
    } catch (e) {
      // Silent degradation — let these URLs be retried by a later mount.
      console.error('Failed to fetch article mentions:', e);
      for (const url of batch) requested.delete(url);
    }
  }

  function requeue(url: string) {
    pending.add(url);
    scheduleFlush();
  }

  // Request the mention breakdown for an article URL. No-op if already fetched
  // or in flight. Safe to call from every card's mount — calls are batched.
  function fetch(url: string): void {
    if (!url || requested.has(url)) return;
    requested.add(url);
    pending.add(url);
    scheduleFlush();
  }

  // The breakdown for a URL, or undefined until it resolves. Reactive.
  function get(url: string): ArticleMentions | undefined {
    return cache.get(url);
  }

  return { fetch, get };
}

export const articleMentionsStore = createArticleMentionsStore();
