import { onDestroy } from 'svelte';
import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
import type { ItemLabelType } from '$lib/types';

const BLOCK_SELECTORS = 'p, h1, h2, h3, h4, h5, h6, blockquote, pre, figure, li';
const MIN_TEXT_LENGTH = 20;
const SAVE_DEBOUNCE_MS = 500;
// `scrollIntoView({ behavior: 'smooth' })` keeps emitting scroll events for a few
// hundred ms after it starts. Ignore them for a little longer than that so a jump
// we initiated is never mistaken for the reader moving.
const PROGRAMMATIC_SCROLL_SETTLE_MS = 1000;

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
  let scrollTarget: EventTarget | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let lastScrollTop = 0;
  let programmaticScroll = false;
  let programmaticScrollTimer: ReturnType<typeof setTimeout> | null = null;

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
  function updateCurrentParagraph(save = true) {
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

    // Persist only in response to an actual scroll. setupObserver also measures
    // the initial position, but doing so must not overwrite progress hydrated
    // from the server while an uncached article body is still loading.
    if (save) debouncedSave();
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
      'background:color-mix(in srgb, var(--color-primary,#0066cc) 4%, transparent);' +
      'transition:top 0.25s ease,height 0.25s ease,opacity 0.25s ease;' +
      'opacity:0;z-index:0;';
    container.style.position = 'relative';
    container.insertBefore(el, container.firstChild);
    return el;
  }

  function updateHighlight() {
    const contentEl = params.contentEl();
    if (!contentEl || paragraphs.length === 0) return;

    // Anchor the highlight to the body *wrapper*, not the content element itself.
    // Injecting it as a child of contentEl would steal the `:first-child` slot and
    // displace the first paragraph (which has its top margin zeroed only while it's
    // the first child), making the text jump down on expand. The wrapper fills the
    // same box, so the absolute highlight lands identically.
    const highlightHost = contentEl.parentElement ?? contentEl;

    if (!highlightEl) {
      highlightEl = createHighlightEl(highlightHost);
    }

    const para = paragraphs[currentParagraphIndex];
    if (!para) return;

    const top = getOffsetRelativeTo(para, highlightHost);
    const height = para.offsetHeight;

    highlightEl.style.top = `${top}px`;
    highlightEl.style.height = `${height}px`;
    highlightEl.style.opacity = '1';
  }

  /**
   * True while the detected body is too short to contain the saved position — the
   * lazily-loaded article hasn't landed yet and we're still looking at the short
   * description fallback (the same condition `restorePosition` reports as
   * `'partial'`). Every index measurable against that stub is an artifact of the
   * partial DOM, so persisting one would replace progress synced from another
   * device with a near-zero value.
   */
  function bodyIsPartial(): boolean {
    const saved = itemLabelsStore.getReadProgress(params.itemKey());
    if (!saved || saved.paragraphIndex <= 0) return false;
    return saved.paragraphIndex > paragraphs.length - 1;
  }

  /**
   * Mute the scroll handler while a `scrollIntoView` we triggered plays out.
   * Restoring a position (or stepping to the next paragraph) is not reading, and
   * the intermediate positions the animation sweeps through are always behind the
   * destination we already recorded.
   */
  function beginProgrammaticScroll() {
    programmaticScroll = true;
    if (programmaticScrollTimer) clearTimeout(programmaticScrollTimer);
    programmaticScrollTimer = setTimeout(() => {
      programmaticScrollTimer = null;
      programmaticScroll = false;
      // Re-baseline the direction heuristic against where the jump landed, so the
      // next real scroll isn't compared with a pre-jump offset.
      lastScrollTop = params.scrollRoot()?.scrollTop ?? window.scrollY;
    }, PROGRAMMATIC_SCROLL_SETTLE_MS);
  }

  function debouncedSave() {
    if (saveTimer) clearTimeout(saveTimer);
    // Whose scroll this is, captured when the save was QUEUED. A delta arriving
    // during the debounce may replace the stored progress with another device's
    // newer position; publishing this one afterwards would rewind that device
    // and, worse, republish the older position as authoritative.
    const queuedAt = Date.now();
    saveTimer = setTimeout(() => {
      saveTimer = null;
      // Re-checked at flush time rather than when the save was queued: the full
      // body may have arrived in the meantime, which makes the position real.
      if (bodyIsPartial()) return;
      const stored = itemLabelsStore.getLabel(params.itemKey(), 'readProgress');
      const storedAt = stored?.props.lastReadAt as number | undefined;
      if (typeof storedAt === 'number' && storedAt > queuedAt) return;
      itemLabelsStore.setReadProgress(
        params.itemKey(),
        params.itemType(),
        currentParagraphIndex,
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
      if (programmaticScroll) return;
      requestAnimationFrame(() => {
        if (programmaticScroll) return;
        updateCurrentParagraph();
      });
    };

    scrollTarget.addEventListener('scroll', scrollHandler, { passive: true });

    // Initial position check
    updateCurrentParagraph(false);
  }

  /**
   * Jump to a paragraph. The scroll handler is muted for the duration of the
   * animation, so the destination set here — not whatever the animation happens to
   * sweep past — is what gets recorded. `persist: false` additionally keeps the
   * jump out of the saved position; restores use it, since replaying where the
   * reader already was is not progress.
   */
  function scrollToParagraph(index: number, { persist = true }: { persist?: boolean } = {}) {
    if (index < 0 || index >= paragraphs.length) return;
    const el = paragraphs[index];
    if (!el) return;
    beginProgrammaticScroll();
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    currentParagraphIndex = index;
    if (currentParagraphIndex > furthestParagraphIndex) {
      furthestParagraphIndex = currentParagraphIndex;
    }
    updateHighlight();
    if (persist) {
      // The muted scroll handler no longer persists this move for us.
      debouncedSave();
    } else if (saveTimer) {
      // Drop anything queued before this jump. A restore that re-runs after the
      // body settles can otherwise let a measurement taken mid-animation — while
      // the fallback body was still on screen — flush behind it.
      clearTimeout(saveTimer);
      saveTimer = null;
    }
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

  /**
   * Restore the saved reading position.
   * - `'exact'`   — the saved paragraph exists in the detected set and we scrolled to it.
   * - `'partial'` — there is a saved position but the body isn't fully loaded yet, so the
   *                 index clamped short; the caller should retry once more content arrives.
   * - `'none'`    — nothing to restore.
   *
   * Saved-article and feed-article bodies load lazily (the in-memory copy is stripped),
   * so the first detect pass often sees only the short description fallback. Reporting
   * `'partial'` lets the reader re-restore when the full body lands instead of stranding
   * the user at the top.
   */
  function restorePosition(): 'exact' | 'partial' | 'none' {
    const saved = itemLabelsStore.getReadProgress(params.itemKey());
    if (!saved || saved.paragraphIndex <= 0 || paragraphs.length === 0) return 'none';
    const exact = saved.paragraphIndex <= paragraphs.length - 1;
    const targetIdx = Math.min(saved.paragraphIndex, paragraphs.length - 1);
    // Never persist a restore: on the `'partial'` path `targetIdx` is clamped to the
    // end of the fallback body, and writing that back would be the reset this hook
    // exists to prevent.
    scrollToParagraph(targetIdx, { persist: false });
    return exact ? 'exact' : 'partial';
  }

  /**
   * The DOM element the saved reading position points at, or null when there is
   * no saved position (or the body isn't rendered yet). Used by paged mode, which
   * turns to that element's page rather than scrolling. Detects paragraphs on
   * demand so it works even when the scroll observer isn't active.
   */
  function restoreTargetElement(): HTMLElement | null {
    const saved = itemLabelsStore.getReadProgress(params.itemKey());
    if (!saved || saved.paragraphIndex <= 0) return null;
    const paras = detectParagraphs();
    if (paras.length === 0) return null;
    const idx = Math.min(saved.paragraphIndex, paras.length - 1);
    return paras[idx] ?? null;
  }

  /** The article's block elements, detected on demand (paged mode maps pages to
   *  paragraphs itself, without the scroll observer). */
  function paragraphElements(): HTMLElement[] {
    return detectParagraphs();
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
    if (programmaticScrollTimer) {
      clearTimeout(programmaticScrollTimer);
      programmaticScrollTimer = null;
    }
    programmaticScroll = false;
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
    scrollToParagraph,
    nextParagraph,
    prevParagraph,
    restorePosition,
    restoreTargetElement,
    paragraphElements,
    cleanup,
  };
}
