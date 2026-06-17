// The fullscreen reader as a navigation stack, shared by the feed and saved-list
// views so both behave identically — including opening a curated Collection
// piece on top of the edition reader.
//
// A piece opened from an edition pushes onto the stack, so Back returns to the
// edition (not the list). Each level pushes a history entry tagged with its depth
// (`page.state.readerDepth`); Back regresses the depth and the effect pops the
// stack to match, restoring the list scroll position once it empties.
//
// Call once at the top of a component's <script> (during init, so the internal
// $effect binds to that component's lifecycle). Read `readerItem` in markup; it's
// reactive. Selection-driven opens read `feedViewStore`, which both views share.
import { pushState } from '$app/navigation';
import { page } from '$app/state';
import { feedViewStore, type FeedDisplayItem } from '$lib/stores/feedView.svelte';
import { fetchCollectionDoc } from '$lib/utils/collectionPiece';
import type { ReaderCollectionItem } from '$lib/types';

export function useReaderStack(config: { onReaderChange?: (open: boolean) => void } = {}) {
  let readerStack = $state<FeedDisplayItem[]>([]);
  let savedScrollY = 0;
  let readerItem = $derived(readerStack.length ? readerStack[readerStack.length - 1] : null);

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

  function openReader(item: FeedDisplayItem) {
    if (readerStack.length === 0) savedScrollY = window.scrollY;
    readerStack = [...readerStack, item];
    pushState('', { readerDepth: readerStack.length });
    config.onReaderChange?.(true);
  }

  // Pop one level; the popstate-driven effect updates the stack (and restores the
  // list scroll position once it empties).
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
