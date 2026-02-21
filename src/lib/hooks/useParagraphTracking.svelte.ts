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
  let hasRestored = false;
  let highlightEl: HTMLDivElement | null = null;
  let scrollHandler: (() => void) | null = null;
  let clickHandler: ((e: Event) => void) | null = null;
  let clickTarget: HTMLElement | null = null;
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

  /**
   * Update current paragraph based on scroll direction:
   * - Scrolling down: advance as soon as the current paragraph's top edge
   *   goes above the viewport top (it's leaving the screen)
   * - Scrolling up: go back when the current paragraph's bottom goes past
   *   the viewport bottom (it's fully off-screen below)
   */
  function updateCurrentParagraph() {
    if (paragraphs.length === 0) return;

    const scrollTop = params.scrollRoot()?.scrollTop ?? window.scrollY;
    const scrollingDown = scrollTop >= lastScrollTop;
    lastScrollTop = scrollTop;

    const root = params.scrollRoot();
    const viewportTop = root ? root.getBoundingClientRect().top : 0;
    const viewportHeight = root ? root.clientHeight : window.innerHeight;
    const viewportBottom = viewportTop + viewportHeight;

    if (scrollingDown) {
      // Advance when the current paragraph's top goes above the viewport top
      while (currentParagraphIndex < paragraphs.length - 1) {
        const rect = paragraphs[currentParagraphIndex].getBoundingClientRect();
        if (rect.top < viewportTop) {
          currentParagraphIndex++;
        } else {
          break;
        }
      }
    } else {
      // Go back when the current paragraph's bottom is past the viewport bottom
      while (currentParagraphIndex > 0) {
        const rect = paragraphs[currentParagraphIndex].getBoundingClientRect();
        if (rect.bottom > viewportBottom) {
          currentParagraphIndex--;
        } else {
          break;
        }
      }
    }
    updateHighlight();

    // Update furthest-read
    if (currentParagraphIndex > furthestParagraphIndex) {
      furthestParagraphIndex = currentParagraphIndex;
    }

    // Save on every position change (up or down)
    debouncedSave();
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

  function createHighlightEl(container: HTMLElement): HTMLDivElement {
    const el = document.createElement('div');
    el.style.cssText =
      'position:absolute;left:-8px;right:-8px;pointer-events:none;border-radius:4px;' +
      'background:color-mix(in srgb, var(--color-primary,#3b82f6) 4%, transparent);' +
      'transition:top 0.25s ease,height 0.25s ease,opacity 0.25s ease;' +
      'opacity:0;z-index:0;';
    container.style.position = 'relative';
    container.insertBefore(el, container.firstChild);
    return el;
  }

  function updateHighlight() {
    const contentEl = params.contentEl();
    if (!contentEl || paragraphs.length === 0) return;

    if (!highlightEl) {
      highlightEl = createHighlightEl(contentEl);
    }

    const para = paragraphs[currentParagraphIndex];
    if (!para) return;

    const top = getOffsetRelativeTo(para, contentEl);
    const height = para.offsetHeight;

    highlightEl.style.top = `${top}px`;
    highlightEl.style.height = `${height}px`;
    highlightEl.style.opacity = '1';
  }

  function debouncedSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      itemLabelsStore.setReadProgress(
        params.itemKey(),
        params.itemType(),
        currentParagraphIndex,
        totalParagraphs
      );
    }, SAVE_DEBOUNCE_MS);
  }

  function goToParagraph(index: number) {
    if (index < 0 || index >= paragraphs.length) return;
    currentParagraphIndex = index;
    if (index > furthestParagraphIndex) {
      furthestParagraphIndex = index;
    }
    updateHighlight();
    debouncedSave();
    scrollToParagraph(index);
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

    // Click handler for paragraph navigation
    clickTarget = contentEl;
    clickHandler = (e: Event) => {
      const target = (e.target as HTMLElement).closest('[data-para-index]');
      if (!target) return;
      // Don't interfere with link clicks
      if ((e.target as HTMLElement).closest('a')) return;
      const index = parseInt((target as HTMLElement).dataset.paraIndex!, 10);
      if (!isNaN(index)) {
        goToParagraph(index);
      }
    };
    clickTarget.addEventListener('click', clickHandler);

    // Initial position check
    updateCurrentParagraph();
  }

  function scrollToParagraph(index: number) {
    if (index < 0 || index >= paragraphs.length) return;
    const el = paragraphs[index];
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    currentParagraphIndex = index;
    updateHighlight();
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
    if (clickHandler && clickTarget) {
      clickTarget.removeEventListener('click', clickHandler);
      clickHandler = null;
      clickTarget = null;
    }
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (highlightEl) {
      highlightEl.remove();
      highlightEl = null;
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
    setupObserver,
    goToParagraph,
    scrollToParagraph,
    nextParagraph,
    prevParagraph,
    restorePosition,
    cleanup,
  };
}
