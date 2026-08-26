// The fullscreen reader as a navigation stack, shared by the feed, saved, home,
// linkblog and highlights surfaces so they all behave identically — including
// opening a curated Collection piece on top of the edition reader.
//
// A piece opened from an edition pushes onto the stack, so Back returns to the
// edition (not the list). Each level pushes a history entry tagged with its depth
// (`page.state.readerDepth`); Back regresses the depth and the effect pops the
// stack to match, restoring the list scroll position once it empties.
//
// **The URL contract.** Each level is shallow-routed: the pushed entry keeps the
// host surface's path and query and adds `?read=<item key>` (see `readerLink.ts`).
// It is still an overlay, not a route — nothing navigates, the list never
// unmounts — but the address bar now names what you're reading, so a reload,
// bookmark or shared link reopens it and Forward reopens what Back closed.
// Within a session `page.state.readerDepth` remains the single driver; the `read`
// param is only read on a cold load (no depth state at all) and on Forward, where
// state alone can't rebuild the stack. On a cold load the current entry is first
// rewritten to the bare list URL, so the one close path (`history.back()`) still
// lands on the container list.
//
// Call once at the top of a component's <script> (during init, so the internal
// $effect binds to that component's lifecycle). Read `readerItem` in markup; it's
// reactive. Selection-driven opens read `feedViewStore`, which both views share.
import { pushState, replaceState } from '$app/navigation';
import { page } from '$app/state';
import { appManager } from '$lib/stores/app.svelte';
import { articlesStore } from '$lib/stores/articles.svelte';
import { savesStore } from '$lib/stores/saves.svelte';
import { socialStore } from '$lib/stores/social.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import { viewTitleStore } from '$lib/stores/viewTitle.svelte';
import { feedViewStore, type FeedDisplayItem } from '$lib/stores/feedView.svelte';
import { fetchCollectionDoc } from '$lib/utils/collectionPiece';
import { getItemTitle } from '$lib/utils/displayItem';
import {
  READ_PARAM,
  fetchReaderDocument,
  readerUrl,
  resolveReaderItem,
} from '$lib/utils/readerLink';
import type { ReaderCollectionItem } from '$lib/types';

export function useReaderStack(config: { onReaderChange?: (open: boolean) => void } = {}) {
  let readerStack = $state<FeedDisplayItem[]>([]);
  let savedScrollY = 0;
  let readerItem = $derived(readerStack.length ? readerStack[readerStack.length - 1] : null);

  // A key we've given up on: the stores were hydrated and the network fallback
  // came back empty. Without it, a permanently unknown key would re-enter the
  // restore effect on every store tick.
  let abandonedKey: string | null = null;
  // The key an async resolution is in flight for, so the effect doesn't start a
  // second one while it waits.
  let resolvingKey: string | null = null;

  /** What the address bar actually says right now — see the restore effect. */
  function currentUrl(): URL {
    return new URL(location.href);
  }

  $effect(() => {
    const depth = page.state.readerDepth ?? 0;
    if (depth < readerStack.length) {
      readerStack = readerStack.slice(0, depth);
      if (depth === 0) {
        config.onReaderChange?.(false);
        requestAnimationFrame(() => {
          window.scrollTo(0, savedScrollY);
        });
      }
    }
  });

  // Name the history entry (and any shared link's preview) after what's open, and
  // hand the tab title back to the host page on close. An override rather than a
  // plain set: the host's own title effect re-runs on unrelated changes (unread
  // counts), and must not win while the reader is up.
  $effect(() => {
    const item = readerItem;
    if (!item) return;
    viewTitleStore.setOverride(getItemTitle(item));
    return () => viewTitleStore.setOverride(null);
  });

  // Restore the reader from the URL. Runs on a cold load (`?read=` with no depth
  // state — a reload, bookmark or shared link) and on Forward-reopen (a
  // depth-tagged entry whose stack we already popped). Reading the stores here is
  // what makes it re-run as Dexie hydration fills them, so it waits out a slow
  // cold start rather than racing it.
  $effect(() => {
    // `page.state` is the reactive trigger — SvelteKit replaces it on every
    // push, pop and real navigation — while the live location is the truth.
    // `page.url` is neither: a shallow push moves the address bar without
    // touching it, and a pop back to an entry we rewrote restores a `page.url`
    // still carrying the param the address bar no longer shows, so reading it
    // here would reopen a reader the user just closed.
    const depth = page.state.readerDepth ?? 0;
    const key = currentUrl().searchParams.get(READ_PARAM);
    if (!key || key === abandonedKey || key === resolvingKey) return;

    const isColdLoad = depth === 0 && readerStack.length === 0;
    if (!isColdLoad && depth <= readerStack.length) return;

    const item = resolveReaderItem(key, {
      saves: savesStore.articles,
      getArticle: (guid) => articlesStore.getByGuid(guid),
      documents: socialStore.documents,
    });
    if (item) {
      restoreItem(item, isColdLoad);
      return;
    }

    // Nothing local yet. Hydration is still the likely explanation, so only reach
    // for the network (and only then give up) once the stores have settled.
    //
    // Settled means the *refresh* finished, not `isInitialized` — that flag is
    // already true throughout `phase === 'refreshing'`, which is exactly the
    // window in which the backend sync fills `articlesStore`. Giving up there
    // would abandon a feed article's key seconds before the sync that supplies
    // it, on precisely the devices that need the wait: a newly signed-in one, or
    // one whose IndexedDB was evicted.
    if (appManager.phase !== 'ready' && appManager.phase !== 'error') return;
    resolvingKey = key;
    void fetchReaderDocument(key, fetchCollectionDoc).then((fetched) => {
      resolvingKey = null;
      // The user can close, navigate or open something else while the fetch is out.
      if (currentUrl().searchParams.get(READ_PARAM) !== key) return;
      const currentDepth = page.state.readerDepth ?? 0;
      const stillColdLoad = currentDepth === 0 && readerStack.length === 0;
      if (!stillColdLoad && currentDepth <= readerStack.length) return;
      if (fetched) {
        restoreItem(fetched, stillColdLoad);
        return;
      }
      // A save or feed item that's personal to someone else, or one that aged out
      // of this reader's cache. Say so once and drop the param — no failure state.
      abandonedKey = key;
      toastStore.update(toastStore.add('Article unavailable'), 'error');
      replaceState(readerUrl(currentUrl(), null), {});
    });
  });

  // Put `item` on the stack for a URL that already names it. A cold load has no
  // entry beneath to go back to, so synthesize one: rewrite the current entry to
  // the bare list URL, then push the reader's. Back then closes the reader and
  // lands on the list — from an external link that costs a second press to leave
  // the app, which beats Back exiting mid-read.
  function restoreItem(item: FeedDisplayItem, synthesizeBase: boolean) {
    if (synthesizeBase) {
      const here = currentUrl();
      const bare = readerUrl(here, null);
      const withItem = readerUrl(here, item.key);
      savedScrollY = 0;
      replaceState(bare, {});
      readerStack = [item];
      pushState(withItem, { readerDepth: 1 });
    } else {
      readerStack = [...readerStack, item];
    }
    config.onReaderChange?.(true);
  }

  function openReader(item: FeedDisplayItem) {
    if (readerStack.length === 0) savedScrollY = window.scrollY;
    const url = readerUrl(currentUrl(), item.key);
    readerStack = [...readerStack, item];
    pushState(url, { readerDepth: readerStack.length });
    config.onReaderChange?.(true);
  }

  // Pop one level; the popstate-driven effect updates the stack (and restores the
  // list scroll position once it empties). Back also restores the entry beneath's
  // URL, so the `read` param follows the stack for free.
  function closeReader() {
    history.back();
  }

  function openSelectedReader() {
    const key = feedViewStore.selectedKey;
    if (key === null) return;
    const item = feedViewStore.currentItems.find((i) => i.key === key);
    if (item) openReader(item);
  }

  // Open a curated Collection piece in the reader. The piece is a resolved preview
  // (title/URL, no body), so fetch its full document on demand, then push it.
  // Falls back to the browser if it can't be fetched.
  async function openCollectionPiece(item: ReaderCollectionItem) {
    try {
      const doc = await fetchCollectionDoc(item.document);
      if (doc) {
        openReader({ type: 'document', item: doc, key: doc.recordUri });
        return;
      }
    } catch (e) {
      console.error('Failed to fetch collection piece:', e);
    }
    if (item.canonicalUrl) window.open(item.canonicalUrl, '_blank', 'noopener');
  }

  return {
    get readerItem() {
      return readerItem;
    },
    get isOpen() {
      return readerStack.length > 0;
    },
    openReader,
    closeReader,
    openSelectedReader,
    openCollectionPiece,
  };
}
