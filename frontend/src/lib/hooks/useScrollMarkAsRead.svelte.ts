import { onDestroy } from 'svelte';
import {
  appScrollElement,
  appScrollTop,
  onAppScroll,
  onAppScrollRootChange,
} from '$lib/utils/appScroll';

interface ScrollMarkAsReadParams {
  getArticleElements: () => HTMLElement[];
  getItemKey: (index: number) => string | undefined;
  /** Read on every setup, so turning the preference off takes effect live. */
  enabled: () => boolean;
  onMarkAsRead: (key: string) => void;
}

/**
 * Hook for scroll-to-mark-as-read functionality.
 * Observes article elements and marks them as read when they scroll past the top
 * of the scroll viewport — the framed content card on desktop, the window on
 * mobile (see utils/appScroll).
 */
export function useScrollMarkAsRead(params: ScrollMarkAsReadParams) {
  let lastScrollY = 0;
  let scrollDirection: 'up' | 'down' | null = null;
  let scrollMarkObserver: IntersectionObserver | null = null;
  let observerRoot: Element | null = null;
  const observed = new Set<HTMLElement>();
  let stopScrollListener: (() => void) | null = null;
  let stopRootListener: (() => void) | null = null;

  function updateScrollDirection() {
    const currentScrollY = appScrollTop();
    if (currentScrollY > lastScrollY) {
      scrollDirection = 'down';
    } else if (currentScrollY < lastScrollY) {
      scrollDirection = 'up';
    }
    lastScrollY = currentScrollY;
  }

  function disconnect() {
    scrollMarkObserver?.disconnect();
    scrollMarkObserver = null;
    observed.clear();
  }

  // Called whenever the list changes. The observer is kept and only the
  // elements that came or went are (un)observed: rebuilding it re-observed every
  // card, each with its own initial callback, once per item marked read.
  function setupObserver() {
    if (!params.enabled()) {
      disconnect();
      return;
    }

    // Reset scroll direction to prevent stale direction from marking items
    // when content changes cause elements to shift above the viewport
    scrollDirection = null;

    const root = appScrollElement();
    if (scrollMarkObserver && observerRoot !== root) disconnect();
    if (!scrollMarkObserver) {
      observerRoot = root;
      scrollMarkObserver = createObserver(root);
    }

    // Keys follow the index, which shifts when the list changes, so every
    // current element gets its key refreshed even if it's already observed.
    const current = new Set<HTMLElement>();
    params.getArticleElements().forEach((el, index) => {
      const key = params.getItemKey(index);
      if (!el || !key) return;
      el.dataset.key = key;
      current.add(el);
      if (!observed.has(el)) scrollMarkObserver!.observe(el);
    });
    for (const el of observed) {
      if (!current.has(el)) scrollMarkObserver.unobserve(el);
    }
    observed.clear();
    for (const el of current) observed.add(el);
  }

  function createObserver(root: Element | null): IntersectionObserver {
    return new IntersectionObserver(
      (entries) => {
        // Only process if scrolling down
        if (scrollDirection !== 'down') return;

        entries.forEach((entry) => {
          // Article left the scroll viewport from the top and is no longer
          // intersecting. Both rects are in client coordinates, so comparing
          // against the root's own top (not 0) is what makes this correct when
          // the scroller is the inset content card rather than the window.
          const rootTop = entry.rootBounds?.top ?? 0;
          if (!entry.isIntersecting && entry.boundingClientRect.top < rootTop) {
            const key = (entry.target as HTMLElement).dataset.key;
            if (key) {
              params.onMarkAsRead(key);
            }
          }
        });
      },
      {
        root, // the content card, or null for the window
        rootMargin: '0px',
        threshold: 0,
      }
    );
  }

  function init() {
    stopScrollListener?.();
    stopScrollListener = onAppScroll(updateScrollDirection);
    // Crossing the shell breakpoint changes which element is the scroller, and
    // so which element the observer must be rooted on.
    stopRootListener?.();
    stopRootListener = onAppScrollRootChange(() => {
      lastScrollY = appScrollTop();
      setupObserver();
    });
    lastScrollY = appScrollTop();
    setupObserver();
  }

  function cleanup() {
    stopScrollListener?.();
    stopScrollListener = null;
    stopRootListener?.();
    stopRootListener = null;
    disconnect();
  }

  // Auto-cleanup on component destroy
  onDestroy(cleanup);

  return {
    init,
    cleanup,
    setupObserver,
  };
}
