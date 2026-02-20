import { onDestroy } from 'svelte';
import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
import type { ItemLabelType } from '$lib/types';

const BLOCK_SELECTORS = 'p, h1, h2, h3, h4, h5, h6, blockquote, pre, figure, li';
const MIN_TEXT_LENGTH = 20;

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
  let observer: IntersectionObserver | null = null;
  let hasRestored = false;

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

    const root = params.scrollRoot() ?? null;

    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const idx = parseInt((entry.target as HTMLElement).dataset.paraIndex || '0', 10);

          if (entry.isIntersecting) {
            // Track the current paragraph in view
            if (idx > currentParagraphIndex) {
              currentParagraphIndex = idx;
            }
          } else if (!entry.isIntersecting && entry.boundingClientRect.top < 0) {
            // Element scrolled past the top — user has read past it
            const newIdx = idx + 1;
            if (newIdx > currentParagraphIndex) {
              currentParagraphIndex = newIdx;
            }
          }
        }

        // Update furthest-read
        if (currentParagraphIndex > furthestParagraphIndex) {
          furthestParagraphIndex = currentParagraphIndex;
          // Persist to IndexedDB (debounced inside the store)
          itemLabelsStore.setReadProgress(
            params.itemKey(),
            params.itemType(),
            furthestParagraphIndex,
            totalParagraphs
          );
        }
      },
      {
        root,
        // Fire when element crosses the middle of the viewport
        rootMargin: '-50% 0px -50% 0px',
        threshold: 0,
      }
    );

    for (const el of paragraphs) {
      observer.observe(el);
    }
  }

  function scrollToParagraph(index: number) {
    if (index < 0 || index >= paragraphs.length) return;
    const el = paragraphs[index];
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    currentParagraphIndex = index;
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
    if (observer) {
      observer.disconnect();
      observer = null;
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
    scrollToParagraph,
    nextParagraph,
    prevParagraph,
    restorePosition,
    cleanup,
  };
}
