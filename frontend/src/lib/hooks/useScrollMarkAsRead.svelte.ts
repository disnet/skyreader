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
  enabled: boolean;
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

  function setupObserver() {
    // Clean up existing observer
    if (scrollMarkObserver) {
      scrollMarkObserver.disconnect();
      scrollMarkObserver = null;
    }

    if (!params.enabled) return;

    // Reset scroll direction to prevent stale direction from marking items
    // when content changes cause elements to shift above the viewport
    scrollDirection = null;

    scrollMarkObserver = new IntersectionObserver(
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
        root: appScrollElement(), // the content card, or null for the window
        rootMargin: '0px',
        threshold: 0,
      }
    );

    // Observe all article elements
    const elements = params.getArticleElements();
    elements.forEach((el, index) => {
      const key = params.getItemKey(index);
      if (el && key) {
        el.dataset.key = key;
        scrollMarkObserver?.observe(el);
      }
    });
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
    scrollMarkObserver?.disconnect();
    scrollMarkObserver = null;
  }

  // Auto-cleanup on component destroy
  onDestroy(cleanup);

  return {
    init,
    cleanup,
    setupObserver,
  };
}
