import { db, getMetadata, setMetadata } from '$lib/services/db';
import { safePut, safeBulkPut, safeUpdate } from '$lib/services/safeDb.svelte';
import {
  api,
  ApiError,
  ExtractionBlockedError,
  PdfExtractionError,
  FileUploadError,
} from '$lib/services/api';
import type { ExtractedArticle } from '$lib/services/api';
import { generateTid } from '$lib/utils/tid';
import { urlKey } from '$lib/utils/urlKey';
import { syncQueue, SAVED_DELETE_BATCH, type SavedPayload } from '$lib/services/sync-queue';
import { syncStore } from './sync.svelte';
import { auth } from './auth.svelte';
import { extractArticle } from '$lib/services/extract';
import { loadStoredBody } from '$lib/services/itemBody';
import { subscriptionsStore } from './subscriptions.svelte';
import { preferExtractedBody } from '$lib/utils/saveBody';
import {
  failedSaveBody,
  hasReadableContent,
  isFailedSaveBody,
  linkTitle,
  type SaveFetchFailure,
} from '$lib/utils/saveAnywhere';
import { computeContentStats } from '$lib/services/articleMerge';
import { savedSearchStore } from './savedSearch.svelte';
import { compareSavedNewestFirst } from '$lib/utils/savedPile';
import { epubCoverPath } from '$lib/utils/epubContent';
import { documentBody } from '$lib/utils/documentBody';
import { createBodyBatcher } from '$lib/utils/bodyBatcher';
import type { Article, SavedItem, SavedMetadataEdit } from '$lib/types';

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
// A book keeps its cover's path, read off the body on the way, for its card.
function toLightSaved(item: SavedItem): SavedItem {
  if (item.content == null) return item;
  const { content, ...rest } = item;
  const coverPath = item.contentType === 'epub' ? epubCoverPath(content) : null;
  return { ...rest, content: null, ...(coverPath ? { coverPath } : {}) };
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
  // The server's remembered "no body" answers, as [rkey, answeredAt] pairs.
  const KNOWN_EMPTY_KEY = 'savedKnownEmptyBodies';
  const KNOWN_EMPTY_TTL_MS = 24 * 60 * 60 * 1000;
  // Server-clock high-water mark for GET /api/saved/updates (Dexie metadata key).
  // V2: the first key's mark ran past saves it skipped as unknown (an import's,
  // see pullUpdates), so devices start this one over from zero to pick them up.
  const UPDATES_SINCE_KEY = 'savedUpdatesSinceV2';
  // Safety valve on update paging (each page is up to 200 rows; an import can
  // bring thousands at once).
  const MAX_UPDATE_PAGES = 25;

  // The list endpoint returns metadata only (the body is the bulk of a row and
  // we already cache it). Fill each item's `content` in place: reuse the cached
  // body when we still have it, otherwise fetch bodies for the unseen rkeys.
  // Offline, items keep whatever body the cache had (null for genuinely new ones).
  async function hydrateBodies(
    items: SavedItem[],
    cachedByRkey: Map<string, SavedItem>
  ): Promise<SavedItem[]> {
    await restoreKnownEmpty();
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
      } else if (stale || !bodyBatcher.knownEmpty(it.rkey)) {
        // Not one the server already said it has no body for (an import's,
        // whose text is fetched on open): every load would ask for them all.
        needFetch.push(it.rkey);
      }
    }
    if (needFetch.length === 0 || !syncStore.isOnline) return hydrated;

    const byRkey = new Map(items.map((it) => [it.rkey, it]));
    for (let i = 0; i < needFetch.length; i += BODY_BATCH) {
      const chunk = needFetch.slice(i, i + BODY_BATCH);
      try {
        const { bodies } = await api.getSavedBodies(chunk);
        for (const rkey of chunk) if (!bodies[rkey]) bodyBatcher.markEmpty(rkey);
        for (const [rkey, body] of Object.entries(bodies)) {
          const it = byRkey.get(rkey);
          if (it && body != null) {
            it.content = body;
            // Drop any in-memory copy the reader cached — it may be the stale body.
            invalidateContent(rkey);
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
  //
  // The same stream carries saves this device has never listed: ones dated
  // before the newest cached save (an import from another app, keeping each
  // article's original saved date), which the newest-first refresh stops short
  // of. Those go to `add`, unless an unsave of them is still queued here.
  async function pullUpdates(
    localByRkey: Map<string, SavedItem>,
    apply: (rows: SavedItem[]) => Promise<void>,
    add: (rows: SavedItem[]) => Promise<void>
  ): Promise<void> {
    let since = (await getMetadata<number>(UPDATES_SINCE_KEY)) ?? 0;
    let unsaving: Set<string> | null = null;
    for (let pageNo = 0; pageNo < MAX_UPDATE_PAGES; pageNo++) {
      const page = await api.getSavedUpdates(since);
      const changed: SavedItem[] = [];
      const added: SavedItem[] = [];
      for (const u of page.articles) {
        const local = localByRkey.get(u.rkey);
        if (!local) {
          unsaving ??= await syncQueue.pendingSavedRkeys('delete');
          if (!unsaving.has(u.rkey)) added.push({ ...u, content: null });
          continue;
        }
        // An unchanged stamp means we already hold this edit.
        if ((local.updatedAt ?? null) === (u.updatedAt ?? null)) continue;
        changed.push({ ...local, ...u, content: null });
      }
      const hydrated = changed.length > 0 ? await hydrateBodies(changed, new Map()) : [];
      if (hydrated.length > 0) await apply(hydrated);
      // A new save lands whether or not its body loaded (an import's has none
      // until it's opened), as the list refresh's do.
      if (added.length > 0) {
        await hydrateBodies(added, new Map());
        await add(added);
        for (const a of added) localByRkey.set(a.rkey, a);
      }
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

  // Saves removed on this device this session. A save listed by an updates
  // page fetched before its delete reached the server mustn't come back.
  const removedRkeys = new Set<string>();
  // The removals each load in flight has to leave out (see load).
  const loadRemovals = new Set<Set<string>>();
  function noteRemoved(rkey: string) {
    removedRkeys.add(rkey);
    for (const set of loadRemovals) set.add(rkey);
  }

  // Add saves the list refresh never sent (see pullUpdates), into the list as
  // it stands now.
  async function addListed(rows: SavedItem[]) {
    const present = new Set(articles.map((a) => a.rkey));
    const live = rows.filter((r) => !present.has(r.rkey) && !removedRkeys.has(r.rkey));
    if (live.length === 0) return;
    pushWordCountBackfills(backfillWordCounts(live));
    articles = [...articles, ...live.map(toLightSaved)].sort(compareSavedNewestFirst);
    rebuildMaps();
    await safeBulkPut(db.saved, live);
    savedSearchStore.invalidate();
  }

  async function load() {
    loading = true;
    error = null;
    // A save deleted while this load is in flight (a bulk delete right after a
    // page opens) stays deleted, whichever of the cache read or the server page
    // saw it first. Only this load's window: an rkey deleted before it began is
    // already gone from both.
    const removedDuringLoad = new Set<string>();
    loadRemovals.add(removedDuringLoad);
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
      const cached = (await db.saved.orderBy('rkey').reverse().toArray())
        .filter((c) => !removedDuringLoad.has(c.rkey))
        .sort(compareSavedNewestFirst);
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

      // A save whose delete is still queued (a bulk delete cut short by a
      // refresh) is listed by the server until the queue drains. It stays gone.
      const unsaving = await syncQueue.pendingSavedRkeys('delete');
      const stillSaved = (rkey: string) => !removedDuringLoad.has(rkey) && !unsaving.has(rkey);

      if (first.full) {
        const snapshot = (first.articles as SavedItem[]).filter((a) => stillSaved(a.rkey));

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
        articles = kept.filter((a) => !removedDuringLoad.has(a.rkey)).map(toLightSaved);
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
          if (stillSaved(a.rkey)) fresh.push(a);
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
      ]
        .filter((a) => !removedDuringLoad.has(a.rkey))
        .sort(compareSavedNewestFirst);

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
        await pullUpdates(localByRkey, applyUpdated, addListed);
      } catch (err) {
        console.warn('Failed to fetch saved updates:', err);
      }
    } catch (err) {
      console.error('Failed to load saved items:', err);
      // Keep cached data if backend fails
    } finally {
      loadRemovals.delete(removedDuringLoad);
      loading = false;
    }
  }

  /**
   * Why fetching the article failed, when that failure should still save the
   * link: the site refusing our fetcher, or the extract route itself failing
   * (a 5xx — the proxy couldn't fetch or parse the page). Anything else (offline,
   * signed out, rate limited) is a reason not to save at all, so it's rethrown.
   * A PDF the proxy couldn't read is its own reason: the extension can't help.
   */
  function saveFetchFailure(err: unknown): SaveFetchFailure | null {
    if (err instanceof ExtractionBlockedError) return 'blocked';
    if (err instanceof PdfExtractionError) {
      if (err.format === 'epub') return err.upgradeRequired ? 'epubUpgrade' : 'epub';
      return err.upgradeRequired ? 'pdfUpgrade' : 'pdf';
    }
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
      // The existing save when it is a link-only note this save may replace, or
      // one stored with nothing to read (saved before empty extractions became
      // notes). In memory saves are light (no body), so the body is read from
      // Dexie; a body that isn't cached here is unknown, and left alone.
      const existing = getByUrl(url);
      const existingBody = existing
        ? (await db.saved.get(existing.rkey).catch(() => undefined))?.content
        : undefined;
      const noteSave =
        existing &&
        (isFailedSaveBody(existingBody) ||
          (typeof existingBody === 'string' && !hasReadableContent(existingBody)))
          ? existing
          : null;

      // Fetch HTML via proxy and extract content client-side
      let extracted: ExtractedArticle;
      let fetchFailed: SaveFetchFailure | undefined;
      try {
        extracted = await extractArticle(url);
        // Fetched, but nothing to read (a page that builds its text with
        // scripts): keep what the page said about itself, and put the note
        // where the article would be rather than save a blank page.
        if (!hasReadableContent(extracted.content)) {
          fetchFailed = 'empty';
          extracted = {
            ...extracted,
            title: extracted.title || hint.title?.trim() || linkTitle(url),
            content: failedSaveBody(url, 'empty'),
            wordCount: 0,
            contentType: undefined,
          };
        }
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
          title: hint.title?.trim() || linkTitle(url),
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
        contentType: extracted.contentType,
        captureMethod: 'server',
        doi: extracted.doi || undefined,
      });

      const savedItem: SavedItem = {
        // An upgrade is the same save: keep what it had, like the server's
        // COALESCE does, where the extraction has nothing better.
        ...(noteSave ?? {}),
        rkey: noteSave?.rkey ?? rkey,
        uri: result.uri,
        url: saveUrl,
        // The server answers with what it stored, which keeps a field the
        // reader edited by hand over this extraction's.
        title:
          (result.title !== undefined ? result.title : extracted.title) ?? noteSave?.title ?? null,
        author: result.author !== undefined ? result.author : extracted.author,
        description: result.description !== undefined ? result.description : extracted.description,
        content: extracted.content,
        contentType: extracted.contentType ?? 'webpage',
        domain: extracted.domain,
        image: extracted.image,
        wordCount,
        publishedAt: result.publishedAt !== undefined ? result.publishedAt : extracted.published,
        // An upgrade keeps its place in the list: it was saved back then.
        savedAt: noteSave?.savedAt ?? result.savedAt,
        source: 'url',
      };

      // Insert a light copy into memory immediately, then persist the full row
      // (with body) to IndexedDB — getContent reads it back on reader open.
      if (noteSave) {
        articles = articles.map((a) => (a.rkey === noteSave.rkey ? toLightSaved(savedItem) : a));
        // The reader may have cached the note.
        invalidateContent(noteSave.rkey);
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

  /**
   * Upload a PDF or an EPUB as a save (Supporter; the server holds to the plan's
   * limits). The server reads it and answers the save with its reflowed body, so
   * it is readable — and highlightable — at once. Needs a connection: there is no
   * queue for a file. Uploading a file already saved answers that save.
   */
  async function uploadFile(file: File, kind: 'pdf' | 'epub'): Promise<SavedItem> {
    if (!canReachBackend()) {
      throw new Error(auth.isGuest ? 'Uploading a file needs an account.' : 'You are offline.');
    }
    saving = true;
    error = null;
    try {
      const rkey = generateTid();
      let result: SavedItem;
      try {
        result =
          kind === 'epub'
            ? await api.uploadEpub(file, rkey, file.name)
            : await api.uploadPdf(file, rkey, file.name);
      } catch (err) {
        if (err instanceof FileUploadError && err.code === 'already_saved' && err.rkey) {
          const existing = articles.find((a) => a.rkey === err.rkey);
          if (existing) return existing;
        }
        throw err;
      }
      const savedItem: SavedItem = {
        rkey: result.rkey,
        uri: result.uri,
        url: '',
        title: result.title,
        author: result.author,
        description: result.description,
        content: result.content,
        contentType: kind,
        domain: null,
        image: null,
        wordCount: result.wordCount,
        publishedAt: result.publishedAt,
        savedAt: result.savedAt,
        source: 'upload',
      };
      articles = [toLightSaved(savedItem), ...articles];
      rebuildMaps();
      await safePut(db.saved, savedItem);
      savedSearchStore.upsert(savedItem);
      return savedItem;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to upload the file';
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
        url: article.url,
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
        // The page's declared DOI is the article's whichever body is kept, and
        // rides a queued retry too.
        let doi: string | undefined;
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
            // No URL, nothing to extract: an emailed newsletter is its own article.
            article.url ? extractArticle(article.url) : Promise.resolve(null),
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
            doi = extracted?.doi || undefined;
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

          const result = await api.saveFromUrl(article.url, rkey, {
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
            doi,
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
          // A reader that opened (or a tile hovered) while extraction ran has
          // cached the optimistic RSS body; it would keep serving that excerpt
          // for the rest of the session. Persist the kept body, then drop the
          // cache, before the maps change: a reader re-reading on that change
          // finds the new row.
          await safePut(db.saved, updated);
          invalidateContent(rkey);
          invalidateContent(updated.rkey);
          articles = articles.map((a) => (a.rkey === rkey ? toLightSaved(updated) : a));
          rebuildMaps();
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
            url: article.url,
            fromFeed: true,
            itemGuid: article.guid,
            title: article.title,
            author: article.author,
            description: article.summary,
            content: rssBody ?? undefined,
            wordCount: wordCountFrom(rssBody) ?? undefined,
            image: article.imageUrl,
            publishedAt: article.publishedAt,
            doi,
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
          url: article.url,
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

      let savedItem: SavedItem = {
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
          // A save from a list brings no body (its documents are held light):
          // render it from the record, or the saved reader has only the
          // description to show.
          if (!savedItem.content) {
            const body = await documentBody(doc.recordUri);
            // Unsaved while the record was fetched: it stays unsaved.
            if (!articles.some((a) => a.rkey === rkey)) return savedItem;
            if (body) {
              savedItem = { ...savedItem, content: body, wordCount: wordCountFrom(body) };
              articles = articles.map((a) => (a.rkey === rkey ? toLightSaved(savedItem) : a));
              await safePut(db.saved, savedItem);
              savedSearchStore.upsert(savedItem);
              invalidateContent(rkey);
            }
          }
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
            content: savedItem.content ?? undefined,
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
            content: savedItem.content ?? undefined,
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
          content: savedItem.content ?? undefined,
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
    noteRemoved(item.rkey);
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
    noteRemoved(rkey);
    articles = articles.filter((a) => a.rkey !== rkey);
    rebuildMaps();
    contentCache.delete(rkey);
    savedSearchStore.remove(rkey, item?.itemGuid);
    await db.saved.delete(rkey);
    await deleteOnServer(rkey, item);
  }

  /** Delete a save on the server, or queue the delete when that can't happen now. */
  async function deleteOnServer(rkey: string, item: SavedItem | undefined) {
    if (canReachBackend()) {
      try {
        await api.deleteSaved(rkey);
      } catch (err) {
        console.error('Failed to delete saved item, queueing:', err);
        await syncQueue.enqueueSavedDeletes([{ rkey, url: item?.url || '' }]);
      }
    } else {
      // Through the bulk path's queueing, so it also drops a queued create or
      // edit of this save (those are keyed by guid, not rkey).
      await syncQueue.enqueueSavedDeletes([{ rkey, url: item?.url || '' }]);
    }
  }

  /**
   * Delete several saves (the Library's select mode). They leave the list in one
   * step (one filter and one map rebuild, not one per save, which froze the tab
   * for a few thousand), then go to the server's bulk delete, 500 a request,
   * which removes them everywhere at once and cleans up behind them (stored files,
   * collections, a backed Library's Semble/Margin records). Every delete is
   * queued before the first request and cleared as the server confirms it, so a
   * refresh, a closed tab or a dropped connection part way leaves the rest in
   * the sync queue, which sends them the same way.
   */
  async function removeMany(rkeys: string[], onProgress?: (done: number) => void) {
    const gone = new Set(rkeys);
    const items = new Map<string, SavedItem>();
    for (const a of articles) if (gone.has(a.rkey)) items.set(a.rkey, a);
    for (const rkey of gone) {
      noteRemoved(rkey);
      contentCache.delete(rkey);
      savedSearchStore.remove(rkey, items.get(rkey)?.itemGuid);
    }
    articles = articles.filter((a) => !gone.has(a.rkey));
    rebuildMaps();
    await db.saved.bulkDelete([...gone]).catch((err) => {
      console.error('Failed to delete saved items locally:', err);
    });

    const queued = await syncQueue
      .enqueueSavedDeletes(
        [...gone].map((rkey) => ({ rkey, url: items.get(rkey)?.url || '' }) as SavedPayload)
      )
      .catch((err) => {
        console.error('Failed to queue saved deletes:', err);
        return null;
      });
    const toSend = queued ?? [...gone];
    let done = gone.size - toSend.length;
    if (done > 0) onProgress?.(done);
    if (!canReachBackend()) return;
    for (let i = 0; i < toSend.length; i += SAVED_DELETE_BATCH) {
      const chunk = toSend.slice(i, i + SAVED_DELETE_BATCH);
      try {
        await api.deleteSavedMany(chunk);
      } catch (err) {
        // The rest wait in the queue for the next sync.
        console.warn('Failed to delete saved items, left queued:', err);
        return;
      }
      if (queued) {
        await syncQueue.clearSavedDeletes(chunk).catch((err) => {
          console.error('Failed to clear sent saved deletes:', err);
        });
      }
      onProgress?.((done += chunk.length));
    }
  }

  // The reader's own edit of a save's title, author, description or date.
  // Applied here at once; the server keeps it over any later re-extraction of
  // the same save. A rejected edit (an empty title, say) is put back and
  // rethrown for the editor to show; one that can't reach the server waits in
  // the sync queue like any other save write.
  async function editMetadata(rkey: string, edit: SavedMetadataEdit): Promise<void> {
    const before = articles.find((a) => a.rkey === rkey);
    if (!before || Object.keys(edit).length === 0) return;

    const changes: Partial<SavedItem> = { ...edit };
    const apply = async (fields: Partial<SavedItem>) => {
      articles = articles.map((a) => (a.rkey === rkey ? { ...a, ...fields } : a));
      rebuildMaps();
      await safeUpdate(db.saved, rkey, fields).catch(() => {});
      savedSearchStore.invalidate();
    };
    await apply(changes);

    // Under the key a still-unsynced create of this save was queued with (its
    // guid, for a feed or document save), so the edit rides on that create.
    const queue = () =>
      syncQueue.enqueue('update', 'saved', before.itemGuid || rkey, {
        rkey,
        url: before.url,
        metadata: edit,
      } as SavedPayload);

    if (!canReachBackend()) {
      await queue();
      return;
    }
    try {
      const { updatedAt } = await api.updateSaved(rkey, edit);
      // This device already holds the edit: take the server's stamp so the next
      // updates pull doesn't re-fetch the body over it.
      if (updatedAt) await apply({ updatedAt });
    } catch (err) {
      // Only a 400 is the server refusing the edit itself. A 404 is a save
      // whose create hasn't synced yet, a 401 an expired session: both wait.
      if (err instanceof ApiError && err.status === 400) {
        const restore: Partial<SavedItem> = {};
        for (const key of Object.keys(edit) as (keyof SavedMetadataEdit)[]) {
          restore[key] = before[key] as never;
        }
        await apply(restore);
        throw err;
      }
      console.error('Failed to edit saved item, queueing:', err);
      await queue();
    }
  }

  // Which save the details editor (EditSavedDetails, mounted in AppShell) is open on.
  let editingRkey = $state<string | null>(null);

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

  function getByRkey(rkey: string): SavedItem | undefined {
    return articles.find((a) => a.rkey === rkey);
  }

  function getByGuid(guid: string): SavedItem | undefined {
    return savedByGuid.get(guid);
  }

  // In-memory body cache, primed by prefetchContent() when a tile is hovered, so
  // opening the reader is instant — no IndexedDB roundtrip, no null→content flash.
  // Only non-null bodies are cached: a save's extracted text is immutable, but a
  // missing body can later be backfilled, so nulls always re-read. (A feed save
  // is the exception: its optimistic RSS body is replaced once extraction lands,
  // and saveArticle invalidates the entry when it does.) Bounded by the
  // handful of tiles a user can hover; entries are dropped on item removal.
  const contentCache = new Map<string, string>();
  // List surfaces' body lookups, batched and deduped (see createBodyBatcher).
  // Its "no body" answers are kept across page loads (KNOWN_EMPTY_KEY): without
  // that, every boot asked again about every save imported without its text,
  // hundreds of rkeys in batches of 200 each time. A day's expiry still picks up
  // a body the server backfilled later; opening a save always asks on its own.
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  const bodyBatcher = createBodyBatcher(
    (rkeys) => api.getSavedBodies(rkeys).then((r) => r.bodies),
    {
      emptyTtlMs: KNOWN_EMPTY_TTL_MS,
      onEmptyChange() {
        if (persistTimer) return;
        persistTimer = setTimeout(() => {
          persistTimer = null;
          // After the restore, so a write can't replace the saved answers with
          // only the few this page has learned so far.
          void restoreKnownEmpty()
            .then(() => setMetadata(KNOWN_EMPTY_KEY, bodyBatcher.emptyEntries()))
            .catch(() => {});
        }, 1000);
      },
    }
  );
  let knownEmptyRestore: Promise<void> | null = null;
  function restoreKnownEmpty(): Promise<void> {
    knownEmptyRestore ??= getMetadata<Array<[string, number]>>(KNOWN_EMPTY_KEY)
      .then((saved) => {
        if (Array.isArray(saved)) bodyBatcher.restoreEmpty(saved);
      })
      .catch(() => {
        // A cold start just asks again.
      });
    return knownEmptyRestore;
  }
  // Bumped on every invalidation. A read that began before one may have seen
  // the old row, so it answers but doesn't cache what it read.
  let contentEpoch = 0;
  function invalidateContent(rkey: string) {
    contentCache.delete(rkey);
    bodyBatcher.forget(rkey);
    contentEpoch++;
  }

  // Warm the cache for a saved item ahead of an open (hover prefetch). Cheap and
  // idempotent; failures are non-fatal since getContent re-reads on open.
  async function prefetchContent(rkey: string): Promise<void> {
    if (!rkey || contentCache.has(rkey)) return;
    try {
      const epoch = contentEpoch;
      const row = await db.saved.get(rkey);
      if (row?.content && epoch === contentEpoch) contentCache.set(rkey, row.content);
    } catch {
      // Non-fatal: getContent falls back to a fresh read on open.
    }
  }

  // A feed save with no body of its own can still be read from its feed item:
  // the row in db.articles, or — for a long body the archive kept out-of-row (a
  // newsletter, usually) — the archive's stored copy. A save made offline, or
  // whose stored-body read failed at save time, lands with no body; without this
  // the reader shows only its description. Best effort: null when the feed item
  // is gone from this device.
  async function feedBodyFor(guid: string | null | undefined): Promise<string | null> {
    if (!guid) return null;
    const row = await db.articles.where('guid').equals(guid).first();
    if (!row) return null;
    if (row.content) return row.content;
    if (!row.contentTruncated) return null;
    const feedUrl = subscriptionsStore.getById(row.subscriptionId)?.feedUrl;
    if (!feedUrl) return null;
    const stored = await loadStoredBody(
      { id: row.id, guid, subscriptionId: row.subscriptionId },
      feedUrl,
      { guest: auth.isGuest }
    );
    return stored.status === 'found' ? stored.content : null;
  }

  // Read a saved item's full body back from IndexedDB by rkey. The in-memory
  // list drops bodies (see toLightSaved); the reader calls this on open, with
  // `opening` so a save imported without its text is fetched then. Cards and
  // the magazine never pass it (rendering a list mustn't fetch pages); they pass
  // `fromList` instead, so their lookups are batched.
  async function getContent(
    rkey: string,
    { opening = false, fromList = false }: { opening?: boolean; fromList?: boolean } = {}
  ): Promise<string | null> {
    const cached = contentCache.get(rkey);
    if (cached != null) return cached;
    try {
      const epoch = contentEpoch;
      const row = await db.saved.get(rkey);
      if (row?.content) {
        if (epoch === contentEpoch) contentCache.set(rkey, row.content);
        return row.content;
      }

      // The list is metadata-only and bodies are hydrated for fresh items in
      // load(); if that hydration was skipped or failed (offline at sync time, a
      // batch error, a backed stub awaiting extraction) the body never lands and
      // the incremental refresh won't revisit an already-cached row. Fetch it on
      // demand here as a self-healing fallback, and cache it so the next open is local.
      // A guest's saves have no server copy to fall back to.
      if (canReachBackend()) {
        // A failed fetch must not skip the local feed-body fallback below. A
        // list's many asks (`fromList`: cards, the magazine) share batched
        // requests that remember "no body" and back off on errors; a single
        // read asks on its own, and the reader's open may extract.
        const body = fromList
          ? await restoreKnownEmpty().then(() => bodyBatcher.get(rkey))
          : await api
              .getSavedBodies([rkey], opening ? { extract: true } : {})
              .then((r) => r.bodies[rkey])
              .catch(() => null);
        if (body) {
          if (row) {
            const filled = { ...row, content: body };
            await safePut(db.saved, filled);
            savedSearchStore.upsert(filled);
          }
          contentCache.set(rkey, body);
          return body;
        }
      }

      const save = row ?? articles.find((a) => a.rkey === rkey);
      const itemGuid = save?.itemGuid;

      // A document saved without its body (from a list, before saves rendered
      // one): render it from the record now, and keep it so the next open is local.
      if (opening && save?.source === 'document' && canReachBackend()) {
        const body = await documentBody(itemGuid);
        if (body) {
          // Only the body: the row may have taken an edit while the record was
          // fetched. Kept on this device; the server holds none to compare.
          const wordCount = save.wordCount ? null : wordCountFrom(body);
          const fields: Partial<SavedItem> = { content: body, ...(wordCount ? { wordCount } : {}) };
          await safeUpdate(db.saved, rkey, fields).catch(() => {});
          if (wordCount) {
            articles = articles.map((a) => (a.rkey === rkey ? { ...a, wordCount } : a));
          }
          savedSearchStore.invalidate();
          if (epoch === contentEpoch) contentCache.set(rkey, body);
          return body;
        }
      }

      // Not cached here (only the save's own body is), so a later backfill of
      // the save still wins on the next open.
      const feedBody = await feedBodyFor(itemGuid).catch(() => null);
      if (feedBody) return feedBody;

      // An empty body is still an answer: the reader turns it into the
      // link-only note for a URL save.
      return row?.content ?? null;
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
    get editing() {
      return editingRkey ? (articles.find((a) => a.rkey === editingRkey) ?? null) : null;
    },
    openEditor(rkey: string) {
      editingRkey = rkey;
    },
    closeEditor() {
      editingRkey = null;
    },
    editMetadata,
    load,
    saveFromUrl,
    uploadFile,
    saveArticle,
    saveDocument,
    unsaveByGuid,
    remove,
    removeMany,
    isSaved,
    find,
    getByUri,
    getByUrl,
    getByGuid,
    getByRkey,
    getContent,
    prefetchContent,
  };
}

export const savesStore = createSavesStore();
