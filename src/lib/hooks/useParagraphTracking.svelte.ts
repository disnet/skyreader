import { onDestroy } from 'svelte';
import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
import type { ItemLabelType } from '$lib/types';

const BLOCK_SELECTORS = 'p, h1, h2, h3, h4, h5, h6, blockquote, pre, figure, li';
const MIN_TEXT_LENGTH = 20;
const SAVE_DEBOUNCE_MS = 500;

interface ParagraphTrackingParams {
  contentEl: () => HTMLElement | undefined;
  scrollRoot: () => HTMLElement | null | undefined;
  itemKey: () => string;
  itemType: () => ItemLabelType;
  enabled: () => boolean;
}

export function useParagraphTracking(params: ParagraphTrackingParams) {
  let paragraphs: HTMLElement[] = [];
  let currentParagraphIndex = $state(0);
  let furthestParagraphIndex = $state(0);
  let totalParagraphs = $state(0);
  let markerTopPercent = $state(0);
  let markerHeightPercent = $state(0);
  let hasRestored = false;
  let scrollHandler: (() => void) | null = null;
  let scrollTarget: EventTarget | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let lastScrollTop = 0;

  function detectParagraphs() {
    const el = params.contentEl();
    if (!el) return [];

    const elements = Array.from(el.querySelectorAll(BLOCK_SELECTORS)) as HTMLElement[];
    // Filter out very short elements and deduplicate (nested li inside blockquote etc.)
    const filtered = elements.filter((el) => {
      const text = el.textContent?.trim() || '';
      return text.length >= MIN_TEXT_LENGTH;
    });

    // Assign data attributes
    filtered.forEach((el, i) => {
      el.dataset.paraIndex = String(i);
    });

    return filtered;
  }

  function getScrollTop(): number {
    const root = params.scrollRoot();
    if (root) {
      return root.scrollTop;
    }
    return window.scrollY;
  }

  function getViewportTop(): number {
    const root = params.scrollRoot();
    if (root) {
      return root.getBoundingClientRect().top;
    }
    return 0;
  }

  /**
   * Update current paragraph based on scroll direction:
   * - Scrolling down: advance when the next paragraph's top edge gets close to
   *   the top of the viewport (early trigger so it feels responsive)
   * - Scrolling up: go back when the current paragraph's bottom goes past the
   *   bottom of the viewport (only change once it's fully scrolled off-screen below)
   */
  function updateCurrentParagraph() {
    if (paragraphs.length === 0) return;

    const scrollTop = getScrollTop();
    const scrollingDown = scrollTop >= lastScrollTop;
    lastScrollTop = scrollTop;

    const root = params.scrollRoot();
    const viewportTop = root ? root.getBoundingClientRect().top : 0;
    const viewportHeight = root ? root.clientHeight : window.innerHeight;
    const viewportBottom = viewportTop + viewportHeight;

    // Offset from edges for triggering transitions
    const topOffset = 60;

    if (scrollingDown) {
      // Scrolling down: advance when the next paragraph's top gets close to the top edge
      let newIndex = currentParagraphIndex;
      for (let i = currentParagraphIndex + 1; i < paragraphs.length; i++) {
        const rect = paragraphs[i].getBoundingClientRect();
        if (rect.top <= viewportTop + topOffset) {
          newIndex = i;
        } else {
          break;
        }
      }
      currentParagraphIndex = newIndex;
    } else {
      // Scrolling up: go back when the current paragraph's bottom goes past the viewport bottom
      let newIndex = currentParagraphIndex;
      while (newIndex > 0) {
        const rect = paragraphs[newIndex].getBoundingClientRect();
        if (rect.bottom >= viewportBottom) {
          newIndex--;
        } else {
          break;
        }
      }
      currentParagraphIndex = newIndex;
    }

    updateMarkerPosition();

    // Update furthest-read
    if (currentParagraphIndex > furthestParagraphIndex) {
      furthestParagraphIndex = currentParagraphIndex;
      debouncedSave();
    }
  }

  function getOffsetRelativeTo(el: HTMLElement, ancestor: HTMLElement): number {
    let top = 0;
    let current: HTMLElement | null = el;
    while (current && current !== ancestor) {
      top += current.offsetTop;
      current = current.offsetParent as HTMLElement | null;
    }
    return top;
  }

  function updateMarkerPosition() {
    const contentEl = params.contentEl();
    if (!contentEl || paragraphs.length === 0) return;

    const containerHeight = contentEl.scrollHeight;
    if (containerHeight === 0) return;

    const para = paragraphs[currentParagraphIndex];
    if (!para) return;

    const paraTop = getOffsetRelativeTo(para, contentEl);
    const paraHeight = para.offsetHeight;

    markerTopPercent = (paraTop / containerHeight) * 100;
    markerHeightPercent = (paraHeight / containerHeight) * 100;
  }

  function debouncedSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      itemLabelsStore.setReadProgress(
        params.itemKey(),
        params.itemType(),
        furthestParagraphIndex,
        totalParagraphs
      );
    }, SAVE_DEBOUNCE_MS);
  }

  function setupObserver() {
    cleanup();
    if (!params.enabled()) return;

    const contentEl = params.contentEl();
    if (!contentEl) return;

    paragraphs = detectParagraphs();
    totalParagraphs = paragraphs.length;

    if (paragraphs.length === 0) return;

    // Restore saved progress
    const saved = itemLabelsStore.getReadProgress(params.itemKey());
    if (saved && saved.paragraphIndex > 0 && !hasRestored) {
      furthestParagraphIndex = saved.paragraphIndex;
      hasRestored = true;
    }

    const root = params.scrollRoot();
    scrollTarget = root ?? window;

    scrollHandler = () => {
      requestAnimationFrame(updateCurrentParagraph);
    };

    scrollTarget.addEventListener('scroll', scrollHandler, { passive: true });

    // Initial position check
    updateCurrentParagraph();
    updateMarkerPosition();
  }

  function scrollToParagraph(index: number) {
    if (index < 0 || index >= paragraphs.length) return;
    const el = paragraphs[index];
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    currentParagraphIndex = index;
    updateMarkerPosition();
  }

  function nextParagraph() {
    if (currentParagraphIndex < totalParagraphs - 1) {
      scrollToParagraph(currentParagraphIndex + 1);
    }
  }

  function prevParagraph() {
    if (currentParagraphIndex > 0) {
      scrollToParagraph(currentParagraphIndex - 1);
    }
  }

  function restorePosition(): boolean {
    const saved = itemLabelsStore.getReadProgress(params.itemKey());
    if (saved && saved.paragraphIndex > 0 && paragraphs.length > 0) {
      const targetIdx = Math.min(saved.paragraphIndex, paragraphs.length - 1);
      scrollToParagraph(targetIdx);
      return true;
    }
    return false;
  }

  function cleanup() {
    if (scrollHandler && scrollTarget) {
      scrollTarget.removeEventListener('scroll', scrollHandler);
      scrollHandler = null;
      scrollTarget = null;
    }
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
  }

  onDestroy(cleanup);

  return {
    get currentParagraphIndex() {
      return currentParagraphIndex;
    },
    get furthestParagraphIndex() {
      return furthestParagraphIndex;
    },
    get totalParagraphs() {
      return totalParagraphs;
    },
    get markerTopPercent() {
      return markerTopPercent;
    },
    get markerHeightPercent() {
      return markerHeightPercent;
    },
    setupObserver,
    scrollToParagraph,
    nextParagraph,
    prevParagraph,
    restorePosition,
    cleanup,
  };
}
