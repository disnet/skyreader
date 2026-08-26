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
// background, so a first miss — or any answer it flags as still enriching — is
// retried a couple times shortly after.

import { api } from '$lib/services/api';
import type { ArticleMentions } from '$lib/types';

const FLUSH_DELAY_MS = 80;
const MAX_BATCH = 50;
const OFFLINE_RETRY_MS = 4000;
// Cold URLs enrich in the background proxy-side; re-poll to catch them. A single
// retry loses the race when Constellation is slow — and a document-target lookup
// adds an origin fetch on top — so retry twice with a lengthening backoff (5s,
// then 10s) before giving up until the card remounts.
const COLD_RETRY_MS = 5000;
const MAX_COLD_RETRIES = 2;
// Cap the session memo so a long scroll session can't grow it without bound.
// Each entry holds the per-lane mention breakdown for one URL; 1000 cards' worth
// is plenty to keep the visible window + recent history warm. Oldest-inserted
// entries are evicted first (plain FIFO — good enough for an adornment cache).
const MAX_CACHE_ENTRIES = 1000;

function createArticleMentionsStore() {
  let cache = $state<Map<string, ArticleMentions>>(new Map());

  // URLs we've already enqueued at least once (dedup the always-on per-card call).
  const requested = new Set<string>();
  // How many cold retries each URL has had (bounds re-polling to MAX_COLD_RETRIES).
  const coldRetries = new Map<string, number>();
  const docUrisByUrl = new Map<string, string>();
  let pending = new Map<string, string | undefined>();
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

    const all = [...pending.entries()];
    const batch = all.slice(0, MAX_BATCH);
    pending = new Map(all.slice(MAX_BATCH));
    if (pending.size > 0) scheduleFlush();

    try {
      const urls = batch.map(([url]) => url);
      const docUris = Object.fromEntries(
        batch.filter((entry): entry is [string, string] => Boolean(entry[1]))
      );
      const res = await api.fetchArticleMentions(
        urls,
        Object.keys(docUris).length ? docUris : undefined
      );
      const next = new Map(cache);
      for (const item of res.items ?? []) {
        // Re-insert at the tail so a just-seen URL counts as freshest for the
        // FIFO eviction below (delete-then-set moves it to the end).
        next.delete(item.url);
        next.set(item.url, item);
        // Re-poll while the proxy says an enrichment is in flight, and on a zero
        // total (which also covers a proxy failure, where nothing is enriching
        // and the field never arrives). A non-zero total is not proof the answer
        // is settled: an article's Leaflet lane is discovered on the read path
        // and can land after its Bluesky and Semble counts are already cached.
        if (item.pending || item.total === 0) {
          const attempts = coldRetries.get(item.url) ?? 0;
          if (attempts < MAX_COLD_RETRIES) {
            coldRetries.set(item.url, attempts + 1);
            setTimeout(() => requeue(item.url), COLD_RETRY_MS * (attempts + 1));
          }
        }
      }
      // Evict oldest entries past the cap. Drop their bookkeeping too so the URL
      // can be re-requested (and re-enriched) if it scrolls back into view.
      while (next.size > MAX_CACHE_ENTRIES) {
        const oldest = next.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        next.delete(oldest);
        requested.delete(oldest);
        coldRetries.delete(oldest);
        docUrisByUrl.delete(oldest);
      }
      cache = next;
    } catch (e) {
      // Silent degradation — let these URLs be retried by a later mount.
      console.error('Failed to fetch article mentions:', e);
      for (const [url] of batch) requested.delete(url);
    }
  }

  function requeue(url: string) {
    pending.set(url, docUrisByUrl.get(url));
    scheduleFlush();
  }

  // Request the mention breakdown for an article URL. No-op if already fetched
  // or in flight. Safe to call from every card's mount — calls are batched.
  function fetch(url: string, docUri?: string): void {
    if (!url) return;
    // A URL-only card may mount before the document version of the same item.
    // Let the later AT-URI upgrade through so Leaflet doesn't stay hidden behind
    // the session's URL-keyed memoization.
    const addsDocUri = Boolean(docUri) && !docUrisByUrl.has(url);
    if (requested.has(url) && !addsDocUri) return;
    requested.add(url);
    if (docUri) docUrisByUrl.set(url, docUri);
    pending.set(url, docUri);
    scheduleFlush();
  }

  // The breakdown for a URL, or undefined until it resolves. Reactive.
  function get(url: string): ArticleMentions | undefined {
    return cache.get(url);
  }

  return { fetch, get };
}

export const articleMentionsStore = createArticleMentionsStore();
