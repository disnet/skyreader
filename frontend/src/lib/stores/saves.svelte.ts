import { db, getMetadata, setMetadata } from '$lib/services/db';
import { safePut, safeBulkPut } from '$lib/services/safeDb.svelte';
import { api, ApiError, ExtractionBlockedError } from '$lib/services/api';
import type { ExtractedArticle } from '$lib/services/api';
import { generateTid } from '$lib/utils/tid';
import { urlKey } from '$lib/utils/urlKey';
import { syncQueue, type SavedPayload } from '$lib/services/sync-queue';
import { syncStore } from './sync.svelte';
import { auth } from './auth.svelte';
import { extractArticle } from '$lib/services/extract';
import { loadStoredBody } from '$lib/services/itemBody';
import { subscriptionsStore } from './subscriptions.svelte';
import { preferExtractedBody } from '$lib/utils/saveBody';
import { failedSaveBody, isFailedSaveBody, type SaveFetchFailure } from '$lib/utils/saveAnywhere';
import { computeContentStats } from '$lib/services/articleMerge';
import { savedSearchStore } from './savedSearch.svelte';
import { compareSavedNewestFirst } from '$lib/utils/savedPile';
import type { Article, SavedItem } from '$lib/types';

/**
 * Whether save writes/reads can reach the backend at all.
 *
 * A guest has no account, so every mutation takes the offline branch: the save
 * is written to IndexedDB and the server-bound half is queued. That queue is
 * also the migration — signing in flushes it to the new account through the
 * ordinary sync run, the same way itemLabels migrates read state. Guest saves
 * keep the RSS body (extraction is session-gated), matching an offline save.
 */
type StoredBodyRef = Pick<Article, 'id' | 'guid' | 'subscriptionId'>;

function canReachBackend(): boolean {
  return syncStore.isOnline && !auth.isGuest;
}

// Derive a word count from the best available body text, returning null when
// there's nothing to count. Used so a saved item's read time never silently
// falls back to "1 min" from the short RSS description — every save path that
// has any body computes a real count locally even when the extractor/proxy
// didn't supply one.
function wordCountFrom(...texts: (string | null | undefined)[]): number | null {
  const body = texts.find((t) => t && t.trim().length > 0) || undefined;
  // A link-only save's note isn't the article: no words to read, no read time.
  if (isFailedSaveBody(body)) return null;
  return computeContentStats(body).wordCount || null;
}

// The extracted webpage body is the largest field on a saved item and is only
// read in the fullscreen reader (the card preview uses `description`; read time
// uses the stored `wordCount`). Drop it from the in-memory list so the store
// doesn't hold every body at once — the full text stays in IndexedDB and is
// pulled back per-item by getContent() when the reader opens.
function toLightSaved(item: SavedItem): SavedItem {
  if (item.content == null) return item;
  const { content: _content, ...rest } = item;
  return { ...rest, content: null };
}

function createSavesStore() {
  let articles = $state<SavedItem[]>([]);
  let loading = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);

  // Display-item key of a freshly-added save that the saved view should open in
  // the reader once it appears. Consumed (and cleared) by SavedListView.
  let pendingOpenKey = $state<string | null>(null);

  // O(1) lookup maps
  let savedByGuid = $state<Map<string, SavedItem>>(new Map());
  let savedByUrl = $state<Map<string, SavedItem>>(new Map());
  // The same saves under their canonical form, so a link that arrives from
  // another network (a Semble connection, a share) still finds the save the
  // reader already has when only a trailing slash or a utm param differs.
  // Exact matches always win; this is only consulted when one misses.
  let savedByUrlKey = $state<Map<string, SavedItem>>(new Map());

  function rebuildMaps() {
    const byGuid = new Map<string, SavedItem>();
    const byUrl = new Map<string, SavedItem>();
    const byUrlKey = new Map<string, SavedItem>();
    for (const bm of articles) {
      if (bm.itemGuid) byGuid.set(bm.itemGuid, bm);
      if (bm.url) {
        byUrl.set(bm.url, bm);
        const key = urlKey(bm.url);
        if (key) byUrlKey.set(key, bm);
      }
    }
    savedByGuid = byGuid;
    savedByUrl = byUrl;
    savedByUrlKey = byUrlKey;
  }

  // Self-heal old saves that have a body but no stored word count (pre-fix
  // saves, failed extractions, offline replays). Without this they fall back to
  // counting the short RSS description and show a misleading "1 min". Mutates
  // each item's wordCount in place and returns the ones that changed so the
  // caller can PATCH the backend (so the fix sticks across reloads/devices).
  function backfillWordCounts(items: SavedItem[]): SavedItem[] {
    const backfilled: SavedItem[] = [];
    for (const a of items) {
      if (a.wordCount == null && a.content) {
        const wc = wordCountFrom(a.content);
        if (wc != null) {
          a.wordCount = wc;
          backfilled.push(a);
        }
      }
    }
    return backfilled;
  }

  function pushWordCountBackfills(backfilled: SavedItem[]) {
    if (backfilled.length > 0 && canReachBackend()) {
      void Promise.all(
        backfilled.map((a) =>
          api.updateSaved(a.rkey, { wordCount: a.wordCount! }).catch((err) => {
            console.warn('Failed to backfill saved word count:', err);
          })
        )
      );
    }
  }

  const PAGE_SIZE = 50;
  const BODY_BATCH = 200;
  // Digest of the last external-backed snapshot applied to the cache (Dexie
  // metadata key); echoed to /api/saved so an unchanged snapshot isn't re-shipped.
  const SNAPSHOT_DIGEST_KEY = 'savedSnapshotDigest';
  // Server-clock high-water mark for GET /api/saved/updates (Dexie metadata key).
  const UPDATES_SINCE_KEY = 'savedUpdatesSince';
  // Safety valve on update paging (each page is up to 200 edits).
  const MAX_UPDATE_PAGES = 10;

  // The list endpoint returns metadata only (the body is the bulk of a row and
  // we already cache it). Fill each item's `content` in place: reuse the cached
  // body when we still have it, otherwise fetch bodies for the unseen rkeys.
  // Offline, items keep whatever body the cache had (null for genuinely new ones).
  async function hydrateBodies(
    items: SavedItem[],
    cachedByRkey: Map<string, SavedItem>
  ): Promise<SavedItem[]> {
    const needFetch: string[] = [];
    const hydrated: SavedItem[] = [];
    for (const it of items) {
      if (it.content != null) continue;
      const cached = cachedByRkey.get(it.rkey);
      const cachedBody = cached?.content;
      // A body edited in place since we cached it (an extension re-save) is
      // stale — the server's updatedAt no longer matches the cached one.
      const stale = (cached?.updatedAt ?? null) !== (it.updatedAt ?? null);
      if (cachedBody != null && !stale) {
        it.content = cachedBody;
      } else {
        needFetch.push(it.rkey);
      }
    }
    if (needFetch.length === 0 || !syncStore.isOnline) return hydrated;

    const byRkey = new Map(items.map((it) => [it.rkey, it]));
    for (let i = 0; i < needFetch.length; i += BODY_BATCH) {
      const chunk = needFetch.slice(i, i + BODY_BATCH);
      try {
        const { bodies } = await api.getSavedBodies(chunk);
        for (const [rkey, body] of Object.entries(bodies)) {
          const it = byRkey.get(rkey);
          if (it && body != null) {
            it.content = body;
            // Drop any in-memory copy the reader cached — it may be the stale body.
            contentCache.delete(rkey);
            hydrated.push(it);
          }
        }
      } catch (err) {
        console.warn('Failed to hydrate saved bodies:', err);
      }
    }
    return hydrated;
  }

  // Older saves edited in place (an extension re-save upgrading the body, a
  // background extraction filling a stub). The incremental refresh below can't
  // see them — they don't move saved_at — so ask for rows changed since the last
  // high-water mark and re-hydrate the ones whose local copy is out of date.
  // Each page is applied (via `apply`) and only then is the mark advanced past
  // it, so a long backlog makes progress across refreshes and a page whose
  // bodies didn't all load is retried from where it started.
  async function pullUpdates(
    localByRkey: Map<string, SavedItem>,
    apply: (rows: SavedItem[]) => Promise<void>
  ): Promise<void> {
    let since = (await getMetadata<number>(UPDATES_SINCE_KEY)) ?? 0;
    for (let pageNo = 0; pageNo < MAX_UPDATE_PAGES; pageNo++) {
      const page = await api.getSavedUpdates(since);
      const changed: SavedItem[] = [];
      for (const u of page.articles) {
        const local = localByRkey.get(u.rkey);
        // Unknown rkeys are left to the list refresh (a local delete may be
        // queued); an unchanged stamp means we already hold this edit.
        if (!local || (local.updatedAt ?? null) === (u.updatedAt ?? null)) continue;
        changed.push({ ...local, ...u, content: null });
      }
      const hydrated = changed.length > 0 ? await hydrateBodies(changed, new Map()) : [];
      if (hydrated.length > 0) await apply(hydrated);
      // A body that failed to load keeps the mark here, so the next refresh
      // asks for this page again.
      if (hydrated.length !== changed.length) return;
      since = page.next;
      await setMetadata(UPDATES_SINCE_KEY, since);
      if (!page.more) return;
    }
  }

  // Swap edited rows into the list as it stands NOW — not the snapshot load()
  // started from, since a save or unsave may have landed while the updates
  // were in flight. A row no longer in the list was removed meanwhile and must
  // not be written back.
  async function applyUpdated(rows: SavedItem[]) {
    const present = new Set(articles.map((a) => a.rkey));
    const live = rows.filter((r) => present.has(r.rkey));
    if (live.length === 0) return;
    pushWordCountBackfills(backfillWordCounts(live));
    const byRkey = new Map(live.map((r) => [r.rkey, r]));
    articles = articles.map((a) => {
      const u = byRkey.get(a.rkey);
      return u ? toLightSaved(u) : a;
    });
    rebuildMaps();
    await safeBulkPut(db.saved, live);
    savedSearchStore.invalidate();
  }

  async function load() {
    loading = true;
    error = null;
    try {
      // Load from local cache first. The in-memory list is kept "light" (no
      // body); IndexedDB retains the full rows.
      //
      // Sorted by savedAt, not by the rkey the index reads in: rkey order is
      // only a proxy for save time (rkeys minted on another device, by the
      // extension, or by a backed collection don't line up), and this is the
      // order Home's "Recently saved" lane shows. The two paths below already
      // sort this way; the cache path returns early for a guest and for an
      // unchanged backed snapshot, so it has to as well or those two cases
      // render a "recent" lane that isn't.
      const cached = (await db.saved.orderBy('rkey').reverse().toArray()).sort(
        compareSavedNewestFirst
      );
      const cachedByRkey = new Map(cached.map((c) => [c.rkey, c]));
      const firstLoad = cached.length === 0;
      if (!firstLoad) {
        articles = cached.map(toLightSaved);
        rebuildMaps();
      }

      // A guest's saves live only in this browser: the cache IS the list, and
      // there is no backend to reconcile against (the list endpoint would 401).
      if (auth.isGuest) return;

      // Fetch the first page. The backend pages newest-first over a keyset
      // cursor; `full` means an external-backed snapshot that must replace the
      // cache wholesale (membership can be *removed* elsewhere, so it can't be
      // merged incrementally).
      //
      // Echo the digest of the last snapshot we applied so an unchanged one
      // costs bytes, not the whole list — but only while a cache exists to keep:
      // with an empty cache an `unchanged` answer would leave the list empty.
      const sinceDigest = firstLoad
        ? undefined
        : ((await getMetadata<string>(SNAPSHOT_DIGEST_KEY)) ?? undefined);
      const first = await api.getSaved({ limit: PAGE_SIZE, sinceDigest });

      // Membership and metadata are unchanged, but a previous body request may
      // have failed after the snapshot digest was stored. Retry only those
      // missing cached bodies before keeping the snapshot.
      if (first.unchanged) {
        const hydrated = await hydrateBodies(cached, cachedByRkey);
        if (hydrated.length > 0) {
          await safeBulkPut(db.saved, hydrated);
          savedSearchStore.invalidate();
        }
        return;
      }

      if (first.full) {
        const snapshot = first.articles as SavedItem[];

        // The snapshot is authoritative about collection MEMBERSHIP, which is
        // why it replaces rather than merges — an item removed in Semble or
        // Margin has to disappear here too. It is NOT authoritative about saves
        // that have never been sent: anything still in the queue is invisible
        // to the collection by definition. Dropping those rows made a guest's
        // saves vanish on the first authenticated boot (load() runs before the
        // queue drains) until a later poll brought them back.
        //
        // Keyed on the queue rather than on load order, so it holds whatever
        // order the boot happens to take, and covers the plain offline-account
        // case as well as sign-in from guest mode.
        const snapshotKeys = new Set(snapshot.map((a) => a.rkey));
        const pendingRkeys = await syncQueue.pendingSavedRkeys();
        const unsent = cached.filter((c) => pendingRkeys.has(c.rkey) && !snapshotKeys.has(c.rkey));

        // Bodies aren't in the response — reuse cached ones, fetch the rest —
        // before the clear()+replace below drops the old cache (and its bodies).
        await hydrateBodies(snapshot, cachedByRkey);
        const backfilled = backfillWordCounts(snapshot);
        const kept = [...unsent, ...snapshot].sort(compareSavedNewestFirst);
        articles = kept.map(toLightSaved);
        rebuildMaps();
        await db.saved.clear();
        if (kept.length > 0) {
          await safeBulkPut(db.saved, kept);
        }
        // A batch landed: rebuild the search corpus on the next search rather
        // than patching it row by row.
        savedSearchStore.invalidate();
        pushWordCountBackfills(backfilled);
        // Only after the snapshot is fully applied: a digest stored before the
        // cache write would claim "unchanged" over a cache we never built.
        if (first.digest) await setMetadata(SNAPSHOT_DIGEST_KEY, first.digest);
        return;
      }

      // Incremental merge: page newest-first, keeping items we don't already
      // have. New saves always sort ahead of cached ones (saved_at is set at
      // save time), so the first already-cached rkey means we've caught up —
      // stop there. On a first-ever load (empty cache) page through everything.
      const fresh: SavedItem[] = [];
      let page = first;
      let caughtUp = false;
      while (!caughtUp) {
        for (const a of page.articles as SavedItem[]) {
          if (!firstLoad && cachedByRkey.has(a.rkey)) {
            caughtUp = true;
            break;
          }
          fresh.push(a);
        }
        if (caughtUp || !page.cursor) break;
        page = await api.getSaved({ limit: PAGE_SIZE, cursor: page.cursor });
      }

      // Fresh items are new (not in cache), so their bodies always need fetching.
      await hydrateBodies(fresh, cachedByRkey);
      const backfilled = backfillWordCounts(fresh);

      // Merge the fresh (newer) items ahead of the cached ones, dropping any
      // cached row a fresh item supersedes, then keep the list in saved_at order.
      const freshKeys = new Set(fresh.map((a) => a.rkey));
      const merged = [
        ...fresh.map(toLightSaved),
        ...cached.filter((c) => !freshKeys.has(c.rkey)).map(toLightSaved),
      ].sort(compareSavedNewestFirst);

      articles = merged;
      rebuildMaps();

      // Upsert only the fresh rows (full bodies) — no clear(), so the rest of
      // the cache is left untouched.
      if (fresh.length > 0) {
        await safeBulkPut(db.saved, fresh);
        savedSearchStore.invalidate();
      }

      pushWordCountBackfills(backfilled);

      // Pick up in-place edits to saves older than the fresh page. Best effort:
      // a failure keeps the list as merged and retries on the next refresh.
      try {
        const localByRkey = new Map<string, SavedItem>([
          ...cached.map((c) => [c.rkey, c] as const),
          ...fresh.map((f) => [f.rkey, f] as const),
        ]);
        await pullUpdates(localByRkey, applyUpdated);
      } catch (err) {
        console.warn('Failed to fetch saved updates:', err);
      }
    } catch (err) {
      console.error('Failed to load saved items:', err);
      // Keep cached data if backend fails
    } finally {
      loading = false;
    }
  }

  /**
   * Why fetching the article failed, when that failure should still save the
   * link: the site refusing our fetcher, or the extract route itself failing
   * (a 5xx — the proxy couldn't fetch or parse the page). Anything else (offline,
   * signed out, rate limited) is a reason not to save at all, so it's rethrown.
   */
  function saveFetchFailure(err: unknown): SaveFetchFailure | null {
    if (err instanceof ExtractionBlockedError) return 'blocked';
    if (err instanceof ApiError && err.status >= 500) return 'failed';
    return null;
  }

  /**
   * Save a web URL. When the article itself can't be fetched, the save still
   * goes through with the link (and `hint.title` when the caller knows one) and
   * a note in place of the text pointing at the extension, which can re-save it
   * with the full text. `fetchFailed` on the result tells the caller which.
   *
   * Saving a URL that is already saved as such a note tries the fetch again and,
   * if it works this time, replaces the note with the article in place (same
   * save, same rkey). Any other existing save is left to the server's 409: a
   * fresh server extraction must not overwrite text the extension saved.
   */
  async function saveFromUrl(
    url: string,
    hint: { title?: string } = {}
  ): Promise<SavedItem & { fetchFailed?: SaveFetchFailure }> {
    saving = true;
    error = null;
    try {
      const rkey = generateTid();
      // The existing save when it is a link-only note this save may replace.
      // In memory saves are light (no body), so the note is read from Dexie.
      const existing = getByUrl(url);
      const noteSave =
        existing &&
        isFailedSaveBody((await db.saved.get(existing.rkey).catch(() => undefined))?.content)
          ? existing
          : null;

      // Fetch HTML via proxy and extract content client-side
      let extracted: ExtractedArticle;
      let fetchFailed: SaveFetchFailure | undefined;
      try {
        extracted = await extractArticle(url);
      } catch (err) {
        const failure = saveFetchFailure(err);
        if (!failure) throw err;
        fetchFailed = failure;
        let domain: string | null = null;
        try {
          domain = new URL(url).hostname.replace(/^www\./, '');
        } catch {
          // Unreachable for a URL the extract route accepted; leave it unset.
        }
        extracted = {
          title: hint.title?.trim() || null,
          author: null,
          description: null,
          content: failedSaveBody(url, failure),
          domain,
          image: null,
          published: null,
          wordCount: 0,
        };
      }

      // Prefer the extractor's word count, but never leave it null when a body
      // exists — count locally so the read time is right even if the proxy
      // omitted it.
      const wordCount = fetchFailed
        ? null
        : extracted.wordCount || wordCountFrom(extracted.content);

      // Still can't fetch it: the note already saved says everything this one
      // would, so leave that save as it is and report the same outcome.
      if (noteSave && fetchFailed) return { ...noteSave, fetchFailed };

      // An upgrade posts the stored URL: getByUrl also matches a normalized
      // spelling, but the server finds the save to replace by exact URL.
      const saveUrl = noteSave?.url ?? url;
      const result = await api.saveFromUrl(saveUrl, rkey, {
        ...(noteSave ? { updateContent: true } : {}),
        title: extracted.title || undefined,
        author: extracted.author || undefined,
        description: extracted.description || undefined,
        content: extracted.content || undefined,
        domain: extracted.domain || undefined,
        image: extracted.image || undefined,
        publishedAt: extracted.published || undefined,
        wordCount: wordCount || undefined,
      });

      const savedItem: SavedItem = {
        // An upgrade is the same save: keep what it had, like the server's
        // COALESCE does, where the extraction has nothing better.
        ...(noteSave ?? {}),
        rkey: noteSave?.rkey ?? rkey,
        uri: result.uri,
        url: saveUrl,
        title: extracted.title ?? noteSave?.title ?? null,
        author: extracted.author,
        description: extracted.description,
        content: extracted.content,
        contentType: 'webpage',
        domain: extracted.domain,
        image: extracted.image,
        wordCount,
        publishedAt: extracted.published,
        // An upgrade keeps its place in the list: it was saved back then.
        savedAt: noteSave?.savedAt ?? result.savedAt,
        source: 'url',
      };

      // Insert a light copy into memory immediately, then persist the full row
      // (with body) to IndexedDB — getContent reads it back on reader open.
      if (noteSave) {
        articles = articles.map((a) => (a.rkey === noteSave.rkey ? toLightSaved(savedItem) : a));
        // The reader may have cached the note.
        contentCache.delete(noteSave.rkey);
      } else {
        articles = [toLightSaved(savedItem), ...articles];
      }
      rebuildMaps();
      await safePut(db.saved, savedItem);
      savedSearchStore.upsert(savedItem);

      return fetchFailed ? { ...savedItem, fetchFailed } : savedItem;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save bookmark';
      error = msg;
      throw err;
    } finally {
      saving = false;
    }
  }

  async function saveArticle(article: {
    url: string;
    guid: string;
    subscriptionId?: number;
    title?: string;
    author?: string;
    summary?: string;
    imageUrl?: string;
    publishedAt?: string;
  }): Promise<SavedItem> {
    saving = true;
    error = null;
    try {
      const rkey = generateTid();
      const now = new Date().toISOString();
      // The URL this save carries, everywhere: '' for a newsletter, whose email
      // is the article. An older item's guessed "View in browser" link must
      // neither be extracted nor sent — with Semble/Margin backing on, the
      // save would publish that (often subscriber-tracking) link publicly.
      const url = await subscriptionsStore.resolveWebUrl(article);

      // Instant/offline fallback body: pull the RSS body back from IndexedDB.
      // The in-memory feed list is kept "light" (content stripped — see
      // toLightArticle), so the body isn't on the article passed in; db.articles
      // still holds the full row. The RSS body is often just an excerpt, so when
      // online we replace it below with a clean full-text extraction.
      let rssBody: string | null = null;
      // A long body (a newsletter, a long-form post) rides out-of-row: the
      // archive keeps it in R2 and the row only says `contentTruncated`. It's
      // recovered below, once the save is already on screen, so the full text
      // is what extraction has to beat — not an empty body a paywall wins by
      // default.
      let storedBodyRef: { ref: StoredBodyRef; feedUrl: string } | null = null;
      if (article.subscriptionId != null) {
        try {
          const row = await db.articles
            .where('guid')
            .equals(article.guid)
            .filter((r) => r.subscriptionId === article.subscriptionId)
            .first();
          rssBody = row?.content || null;
          const feedUrl = subscriptionsStore.getById(article.subscriptionId)?.feedUrl;
          if (!rssBody && row?.contentTruncated && feedUrl) {
            storedBodyRef = {
              ref: { id: row.id, guid: article.guid, subscriptionId: article.subscriptionId },
              feedUrl,
            };
          }
        } catch {
          // Best effort — fall back to no stored body.
        }
      }

      // Optimistically add to local state with the RSS body so the save appears
      // immediately and stays readable offline; the extracted body upgrades it
      // below. Insert a light copy into memory; persist the full row (with body)
      // to IndexedDB so getContent reads it back when the reader opens.
      const savedItem: SavedItem = {
        rkey,
        uri: '', // Will be set by backend
        url,
        title: article.title || null,
        author: article.author || null,
        description: article.summary || null,
        content: rssBody,
        contentType: 'article',
        domain: null,
        image: article.imageUrl || null,
        // Count the RSS body up-front so the read time is right immediately —
        // including offline, where extraction never runs. Upgraded below with
        // the extracted body's count when online.
        wordCount: wordCountFrom(rssBody),
        publishedAt: article.publishedAt || null,
        savedAt: now,
        source: 'feed',
        itemGuid: article.guid,
      };

      articles = [toLightSaved(savedItem), ...articles];
      rebuildMaps();
      await safePut(db.saved, savedItem);
      savedSearchStore.upsert(savedItem);

      if (canReachBackend()) {
        try {
          // Prefer a clean, full-text extraction of the article (same source as
          // URL saves) over the RSS body. Keep the RSS body when extraction
          // fails, returns nothing, or comes back much shorter than the feed's
          // own text — a paywall or sign-up teaser (see utils/saveBody.ts).
          // The stored-body read runs alongside extraction; either failing
          // leaves the other (or the row's own body) to save.
          const [stored, extraction] = await Promise.allSettled([
            storedBodyRef
              ? loadStoredBody(storedBodyRef.ref, storedBodyRef.feedUrl, {
                  guest: auth.isGuest,
                })
              : Promise.resolve(null),
            url ? extractArticle(url) : Promise.resolve(null),
          ]);
          if (stored.status === 'fulfilled' && stored.value?.status === 'found') {
            rssBody = stored.value.content;
          }
          let content = rssBody;
          let wordCount: number | null = null;
          let domain: string | null = null;
          try {
            if (extraction.status === 'rejected') throw extraction.reason;
            const extracted = extraction.value;
            if (extracted && preferExtractedBody(rssBody, extracted.content)) {
              content = extracted.content;
              wordCount = extracted.wordCount || null;
              domain = extracted.domain || null;
            }
          } catch (err) {
            console.warn('Article extraction failed, using feed body:', err);
          }

          // Never leave the count null when a body exists: extraction may have
          // failed (content stayed the RSS body) or returned a body with no
          // count. Count whatever body we ended up with.
          if (wordCount == null) wordCount = wordCountFrom(content);

          const result = await api.saveFromUrl(url, rkey, {
            fromFeed: true,
            itemGuid: article.guid,
            title: article.title,
            author: article.author,
            description: article.summary,
            content: content ?? undefined,
            image: article.imageUrl,
            publishedAt: article.publishedAt,
            domain: domain ?? undefined,
            wordCount: wordCount ?? undefined,
          });

          // Update with extracted content + server response
          const updated: SavedItem = {
            ...savedItem,
            content,
            wordCount,
            domain: domain ?? savedItem.domain,
            uri: result.uri,
            rkey: result.rkey,
          };
          articles = articles.map((a) => (a.rkey === rkey ? toLightSaved(updated) : a));
          rebuildMaps();
          await safePut(db.saved, updated);
          // The backend can hand back a different rkey; drop the optimistic key
          // so the corpus doesn't keep a stale copy of the same save.
          if (updated.rkey !== rkey) savedSearchStore.remove(rkey);
          savedSearchStore.upsert(updated);

          return updated;
        } catch (err) {
          // API failed but local state is already updated, queue for retry
          console.error('Failed to save article to backend, queueing:', err);
          await syncQueue.enqueue('create', 'saved', article.guid, {
            rkey,
            url,
            fromFeed: true,
            itemGuid: article.guid,
            title: article.title,
            author: article.author,
            description: article.summary,
            content: rssBody ?? undefined,
            wordCount: wordCountFrom(rssBody) ?? undefined,
            image: article.imageUrl,
            publishedAt: article.publishedAt,
          } as SavedPayload);
          return savedItem;
        }
      } else {
        // Offline or guest: queue the API call with the RSS body. Extraction
        // needs the network (and a session), and the queue replays the save
        // directly via the API (not this path), so these saves keep the RSS
        // body rather than the extracted one.
        await syncQueue.enqueue('create', 'saved', article.guid, {
          rkey,
          url,
          fromFeed: true,
          itemGuid: article.guid,
          title: article.title,
          author: article.author,
          description: article.summary,
          content: rssBody ?? undefined,
          wordCount: wordCountFrom(rssBody) ?? undefined,
          image: article.imageUrl,
          publishedAt: article.publishedAt,
        } as SavedPayload);
        return savedItem;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save article';
      error = msg;
      throw err;
    } finally {
      saving = false;
    }
  }

  async function saveDocument(doc: {
    recordUri: string;
    url: string;
    title?: string;
    description?: string;
    publishedAt?: string;
    // Pre-rendered body HTML. Standard.site documents render from structured
    // content, not URL extraction, so the caller passes the rendered body here
    // and we persist it as the saved copy's content (otherwise the saved reader
    // has nothing to show — see the collection-piece save path).
    content?: string;
  }): Promise<SavedItem> {
    saving = true;
    error = null;
    try {
      const rkey = generateTid();
      const now = new Date().toISOString();

      const savedItem: SavedItem = {
        rkey,
        uri: '',
        url: doc.url || '',
        title: doc.title || null,
        author: null,
        description: doc.description || null,
        content: doc.content ?? null,
        contentType: 'document',
        domain: null,
        image: null,
        wordCount: doc.content ? wordCountFrom(doc.content) : null,
        publishedAt: doc.publishedAt || null,
        savedAt: now,
        source: 'document',
        itemGuid: doc.recordUri,
      };

      articles = [savedItem, ...articles];
      rebuildMaps();
      await safePut(db.saved, savedItem);
      savedSearchStore.upsert(savedItem);

      if (canReachBackend()) {
        try {
          const result = await api.saveFromUrl(doc.url || '', rkey, {
            source: 'document',
            itemGuid: doc.recordUri,
            title: doc.title,
            description: doc.description,
            publishedAt: doc.publishedAt,
            // Persist the rendered body server-side too, so it survives the
            // backend-authoritative reload in load() (a 'document' save is a
            // metadata save — the backend stores this content rather than
            // extracting from the URL).
            content: doc.content,
            wordCount: savedItem.wordCount ?? undefined,
          });

          const updated: SavedItem = {
            ...savedItem,
            uri: result.uri,
            rkey: result.rkey,
          };
          articles = articles.map((a) => (a.rkey === rkey ? updated : a));
          rebuildMaps();
          await safePut(db.saved, updated);
          if (updated.rkey !== rkey) savedSearchStore.remove(rkey);
          savedSearchStore.upsert(updated);
          return updated;
        } catch (err) {
          console.error('Failed to save document to backend, queueing:', err);
          await syncQueue.enqueue('create', 'saved', doc.recordUri, {
            rkey,
            url: doc.url || '',
            source: 'document',
            itemGuid: doc.recordUri,
            title: doc.title,
            description: doc.description,
            publishedAt: doc.publishedAt,
            content: doc.content,
            wordCount: savedItem.wordCount ?? undefined,
          } as SavedPayload);
          return savedItem;
        }
      } else {
        await syncQueue.enqueue('create', 'saved', doc.recordUri, {
          rkey,
          url: doc.url || '',
          source: 'document',
          itemGuid: doc.recordUri,
          title: doc.title,
          description: doc.description,
          publishedAt: doc.publishedAt,
          content: doc.content,
          wordCount: savedItem.wordCount ?? undefined,
        } as SavedPayload);
        return savedItem;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save document';
      error = msg;
      throw err;
    } finally {
      saving = false;
    }
  }

  async function unsaveByGuid(guid: string) {
    const item = savedByGuid.get(guid);
    if (!item) return;

    // Optimistically remove from local state
    articles = articles.filter((a) => a.itemGuid !== guid);
    rebuildMaps();
    savedSearchStore.remove(item.rkey, guid);
    await db.saved.where('itemGuid').equals(guid).delete();

    if (canReachBackend()) {
      try {
        await api.deleteSavedByGuid(guid);
      } catch (err) {
        console.error('Failed to unsave by guid, queueing:', err);
        await syncQueue.enqueue('delete', 'saved', guid, {
          rkey: item.rkey,
          url: item.url,
          itemGuid: guid,
        } as SavedPayload);
      }
    } else {
      await syncQueue.enqueue('delete', 'saved', guid, {
        rkey: item.rkey,
        url: item.url,
        itemGuid: guid,
      } as SavedPayload);
    }
  }

  async function remove(rkey: string) {
    const item = articles.find((a) => a.rkey === rkey);

    // Optimistically remove from local state
    articles = articles.filter((a) => a.rkey !== rkey);
    rebuildMaps();
    contentCache.delete(rkey);
    savedSearchStore.remove(rkey, item?.itemGuid);
    await db.saved.delete(rkey);

    if (canReachBackend()) {
      try {
        await api.deleteSaved(rkey);
      } catch (err) {
        console.error('Failed to delete saved item, queueing:', err);
        await syncQueue.enqueue('delete', 'saved', rkey, {
          rkey,
          url: item?.url || '',
        } as SavedPayload);
      }
    } else {
      await syncQueue.enqueue('delete', 'saved', rkey, {
        rkey,
        url: item?.url || '',
      } as SavedPayload);
    }
  }

  // The save behind an arbitrary item key — a feed guid, a document record uri,
  // or a url — resolved down the same guid → url → canonical-url ladder that
  // isSaved() answers yes on. Callers that only ask "is this saved?" and
  // callers that need the row itself have to agree, or the Saved list can list
  // an article as saved (url match) and then find no save to read its savedAt
  // and archive state from.
  function find(guidOrUrl: string): SavedItem | undefined {
    if (!guidOrUrl) return undefined;
    const byGuid = savedByGuid.get(guidOrUrl);
    if (byGuid) return byGuid;
    const byUrl = savedByUrl.get(guidOrUrl);
    if (byUrl) return byUrl;
    const key = urlKey(guidOrUrl);
    return key ? savedByUrlKey.get(key) : undefined;
  }

  function isSaved(guidOrUrl: string): boolean {
    return find(guidOrUrl) !== undefined;
  }

  function getByUri(uri: string): SavedItem | undefined {
    return articles.find((a) => a.uri === uri);
  }

  function getByUrl(url: string): SavedItem | undefined {
    const exact = savedByUrl.get(url);
    if (exact) return exact;
    const key = urlKey(url);
    return key ? savedByUrlKey.get(key) : undefined;
  }

  function getByGuid(guid: string): SavedItem | undefined {
    return savedByGuid.get(guid);
  }

  // In-memory body cache, primed by prefetchContent() when a tile is hovered, so
  // opening the reader is instant — no IndexedDB roundtrip, no null→content flash.
  // Only non-null bodies are cached: a save's extracted text is immutable, but a
  // missing body can later be backfilled, so nulls always re-read. Bounded by the
  // handful of tiles a user can hover; entries are dropped on item removal.
  const contentCache = new Map<string, string>();

  // Warm the cache for a saved item ahead of an open (hover prefetch). Cheap and
  // idempotent; failures are non-fatal since getContent re-reads on open.
  async function prefetchContent(rkey: string): Promise<void> {
    if (!rkey || contentCache.has(rkey)) return;
    try {
      const row = await db.saved.get(rkey);
      if (row?.content) contentCache.set(rkey, row.content);
    } catch {
      // Non-fatal: getContent falls back to a fresh read on open.
    }
  }

  // Read a saved item's full body back from IndexedDB by rkey. The in-memory
  // list drops bodies (see toLightSaved); the reader calls this on open.
  async function getContent(rkey: string): Promise<string | null> {
    const cached = contentCache.get(rkey);
    if (cached != null) return cached;
    try {
      const row = await db.saved.get(rkey);
      if (row?.content != null) {
        contentCache.set(rkey, row.content);
        return row.content;
      }

      // The list is metadata-only and bodies are hydrated for fresh items in
      // load(); if that hydration was skipped or failed (offline at sync time, a
      // batch error, a backed stub awaiting extraction) the body never lands and
      // the incremental refresh won't revisit an already-cached row. Fetch it on
      // demand here as a self-healing fallback, and cache it so the next open is local.
      // A guest's saves have no server copy to fall back to.
      if (!canReachBackend()) return null;
      const { bodies } = await api.getSavedBodies([rkey]);
      const body = bodies[rkey] ?? null;
      if (body != null && row) {
        const filled = { ...row, content: body };
        await safePut(db.saved, filled);
        savedSearchStore.upsert(filled);
      }
      if (body != null) contentCache.set(rkey, body);
      return body;
    } catch {
      return null;
    }
  }

  return {
    get articles() {
      return articles;
    },
    get loading() {
      return loading;
    },
    get saving() {
      return saving;
    },
    get error() {
      return error;
    },
    get pendingOpenKey() {
      return pendingOpenKey;
    },
    set pendingOpenKey(key: string | null) {
      pendingOpenKey = key;
    },
    load,
    saveFromUrl,
    saveArticle,
    saveDocument,
    unsaveByGuid,
    remove,
    isSaved,
    find,
    getByUri,
    getByUrl,
    getByGuid,
    getContent,
    prefetchContent,
  };
}

export const savesStore = createSavesStore();
