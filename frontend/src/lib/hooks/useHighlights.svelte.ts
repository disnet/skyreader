import { onDestroy } from 'svelte';
import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
import { createSelector, createSelectorForElement, findTextInDOM } from '$lib/utils/textSelector';
import {
  saveHighlightToMargin as saveToMargin,
  removeHighlightFromMargin,
  updateHighlightNoteOnMargin,
} from '$lib/services/marginHighlights';
import type { ItemLabelType, Highlight, TextQuoteSelector } from '$lib/types';

const BLOCK_SELECTORS = 'p, h1, h2, h3, h4, h5, h6, blockquote, pre, figure, li';
const INTERACTIVE_MEDIA_SELECTOR = 'video, audio, iframe, embed, object';

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

interface HighlightParams {
  contentEl: () => HTMLElement | undefined;
  itemKey: () => string;
  itemType: () => ItemLabelType;
  enabled: () => boolean;
  // Article URL/title, used as the target when saving a highlight to Margin.
  itemUrl?: () => string | undefined;
  itemTitle?: () => string | undefined;
}

export function useHighlights(params: HighlightParams) {
  // State exposed for the component to render the popover
  let popoverState = $state<{
    mode: 'create' | 'remove';
    anchorRect: DOMRect;
    pendingSelector?: TextQuoteSelector;
    highlightId?: string;
  } | null>(null);

  let currentEl: HTMLElement | null = null;
  let dblclickHandler: ((e: MouseEvent) => void) | null = null;
  let mouseupHandler: ((e: MouseEvent) => void) | null = null;
  let clickHandler: ((e: MouseEvent) => void) | null = null;
  let touchendHandler: ((e: TouchEvent) => void) | null = null;
  let selectionchangeHandler: (() => void) | null = null;
  let appliedMarks: HTMLElement[] = [];

  // Touch bookkeeping. Mobile browsers don't emit `dblclick`/`mouseup` for
  // tap-to-highlight or touch text selection, so we synthesize both. A
  // double-tap highlights the paragraph. For text selection we keep the native
  // selection (so iOS's Copy/Look Up menu still works) and stash the selector;
  // the private highlight is created once the user clears the selection.
  let lastTapTime = 0;
  let lastTapX = 0;
  let lastTapY = 0;
  let sawTouch = false;
  let pendingTouchSelector: TextQuoteSelector | null = null;

  function applyHighlights() {
    clearMarks();
    const el = params.contentEl();
    if (!el) return;

    const highlights = itemLabelsStore.getHighlights(params.itemKey());
    for (const highlight of highlights) {
      const range = findTextInDOM(highlight.selector, el);
      if (!range) continue;
      wrapRange(range, highlight.id);
    }
  }

  function wrapRange(range: Range, highlightId: string) {
    // For ranges within a single text node, use surroundContents
    if (
      range.startContainer === range.endContainer &&
      range.startContainer.nodeType === Node.TEXT_NODE
    ) {
      const mark = document.createElement('mark');
      mark.className = 'highlight';
      mark.dataset.highlightId = highlightId;
      try {
        range.surroundContents(mark);
        appliedMarks.push(mark);
      } catch {
        // surroundContents can fail if range crosses element boundaries
        wrapRangeMultiNode(range, highlightId);
      }
      return;
    }

    wrapRangeMultiNode(range, highlightId);
  }

  function wrapRangeMultiNode(range: Range, highlightId: string) {
    // Walk text nodes within the range and wrap each one
    const container = params.contentEl();
    if (!container) return;

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let node = walker.nextNode();
    while (node) {
      if (range.intersectsNode(node)) {
        textNodes.push(node as Text);
      }
      node = walker.nextNode();
    }

    for (const textNode of textNodes) {
      const nodeRange = document.createRange();

      if (textNode === range.startContainer) {
        nodeRange.setStart(textNode, range.startOffset);
      } else {
        nodeRange.setStart(textNode, 0);
      }

      if (textNode === range.endContainer) {
        nodeRange.setEnd(textNode, range.endOffset);
      } else {
        nodeRange.setEnd(textNode, textNode.textContent?.length ?? 0);
      }

      if (nodeRange.toString().length === 0) continue;

      const mark = document.createElement('mark');
      mark.className = 'highlight';
      mark.dataset.highlightId = highlightId;
      try {
        nodeRange.surroundContents(mark);
        appliedMarks.push(mark);
      } catch {
        // Skip if we can't wrap this node
      }
    }
  }

  function clearMarks() {
    for (const mark of appliedMarks) {
      const parent = mark.parentNode;
      if (!parent) continue;
      while (mark.firstChild) {
        parent.insertBefore(mark.firstChild, mark);
      }
      parent.removeChild(mark);
      parent.normalize();
    }
    appliedMarks = [];
  }

  /**
   * Toggle a whole-paragraph highlight for the block element containing `target`.
   * Shared by desktop double-click and mobile double-tap. Returns true when a
   * highlight was created or removed (so callers can suppress default gestures).
   */
  function highlightParagraph(target: HTMLElement | null): boolean {
    if (!target) return false;
    // Don't intercept interactive content.
    if (target.closest(`a, ${INTERACTIVE_MEDIA_SELECTOR}`)) return false;

    const blockEl = target.closest(BLOCK_SELECTORS) as HTMLElement | null;
    if (!blockEl) return false;

    const container = params.contentEl();
    if (!container || !container.contains(blockEl)) return false;

    // Check if this paragraph already has a highlight
    const highlights = itemLabelsStore.getHighlights(params.itemKey());
    const paragraphText = blockEl.textContent ?? '';
    const existingHighlight = highlights.find((h) => h.selector.exact === paragraphText);

    if (existingHighlight) {
      // Toggle off: remove the highlight
      void removeFromMargin(existingHighlight);
      itemLabelsStore.removeHighlight(params.itemKey(), existingHighlight.id);
      requestAnimationFrame(applyHighlights);
      return true;
    }

    // Create a highlight for the whole paragraph
    const selector = createSelectorForElement(blockEl, container);
    const highlight: Highlight = {
      id: generateId(),
      selector,
      createdAt: Date.now(),
    };
    itemLabelsStore.addHighlight(params.itemKey(), params.itemType(), highlight);
    requestAnimationFrame(applyHighlights);
    return true;
  }

  function handleDblClick(e: MouseEvent) {
    if (!params.enabled()) return;
    highlightParagraph(e.target as HTMLElement);
  }

  function handleTouchEnd(e: TouchEvent) {
    if (!params.enabled()) return;
    // Only single-finger gestures participate.
    if (e.changedTouches.length !== 1) return;
    sawTouch = true;

    const touch = e.changedTouches[0];
    const now = Date.now();
    const dt = now - lastTapTime;
    const dx = Math.abs(touch.clientX - lastTapX);
    const dy = Math.abs(touch.clientY - lastTapY);

    // Double-tap: highlight the whole paragraph (checked first, since a
    // double-tap also selects a word).
    if (lastTapTime && dt < 300 && dx < 30 && dy < 30) {
      pendingTouchSelector = null;
      const target =
        (e.target as HTMLElement | null) ??
        (document.elementFromPoint(touch.clientX, touch.clientY) as HTMLElement | null);
      if (highlightParagraph(target)) {
        e.preventDefault();
        window.getSelection()?.removeAllRanges();
      }
      lastTapTime = 0;
      return;
    }

    // Otherwise remember the tap so the next one can complete a double-tap.
    // Text selections are tracked via `selectionchange`, not here.
    lastTapTime = now;
    lastTapX = touch.clientX;
    lastTapY = touch.clientY;
  }

  /**
   * Touch selection lifecycle. We never clear the user's selection ourselves —
   * that would dismiss iOS's native Copy/Look Up menu. Instead we stash the
   * selector while a selection is live, then create a private highlight when the
   * user clears it (selection collapses).
   */
  function handleSelectionChange() {
    if (!sawTouch || !params.enabled()) return;

    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.rangeCount) {
      const range = selection.getRangeAt(0);
      const container = params.contentEl();
      if (container && container.contains(range.commonAncestorContainer)) {
        const selectedText = range.toString().trim();
        if (selectedText.length >= 3) {
          pendingTouchSelector = createSelector(range, container);
          return;
        }
      }
      // Selection is outside our content or too short — nothing to highlight.
      pendingTouchSelector = null;
      return;
    }

    // Selection collapsed: realize the pending highlight, if any.
    if (!pendingTouchSelector) return;
    const selector = pendingTouchSelector;
    pendingTouchSelector = null;
    const highlight: Highlight = {
      id: generateId(),
      selector,
      createdAt: Date.now(),
    };
    itemLabelsStore.addHighlight(params.itemKey(), params.itemType(), highlight);
    requestAnimationFrame(applyHighlights);
  }

  function handleMouseUp(e: MouseEvent) {
    if (!params.enabled()) return;
    const target = e.target as HTMLElement;
    if (target.closest(INTERACTIVE_MEDIA_SELECTOR)) return;
    // Small delay to let selection finalize
    setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return;

      const range = selection.getRangeAt(0);
      const container = params.contentEl();
      if (!container || !container.contains(range.commonAncestorContainer)) return;

      const selectedText = range.toString().trim();
      if (!selectedText || selectedText.length < 3) return;

      const rect = range.getBoundingClientRect();
      const selector = createSelector(range, container);

      popoverState = {
        mode: 'create',
        anchorRect: rect,
        pendingSelector: selector,
      };
    }, 10);
  }

  function handleClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.closest(INTERACTIVE_MEDIA_SELECTOR)) return;
    const mark = target.closest('mark.highlight') as HTMLElement | null;
    if (!mark) return;

    const highlightId = mark.dataset.highlightId;
    if (!highlightId) return;

    e.preventDefault();
    e.stopPropagation();

    const rect = mark.getBoundingClientRect();
    popoverState = {
      mode: 'remove',
      anchorRect: rect,
      highlightId,
    };
  }

  function createHighlightFromPopover(note?: string) {
    if (!popoverState?.pendingSelector) return;

    const trimmed = note?.trim();
    const highlight: Highlight = {
      id: generateId(),
      selector: popoverState.pendingSelector,
      createdAt: Date.now(),
      ...(trimmed ? { note: trimmed } : {}),
    };
    itemLabelsStore.addHighlight(params.itemKey(), params.itemType(), highlight);
    window.getSelection()?.removeAllRanges();
    popoverState = null;
    requestAnimationFrame(applyHighlights);
  }

  /** Create a highlight from the current selection and push it to Margin. */
  function createHighlightFromPopoverToMargin(note?: string) {
    if (!popoverState?.pendingSelector) return;

    const trimmed = note?.trim();
    const highlight: Highlight = {
      id: generateId(),
      selector: popoverState.pendingSelector,
      createdAt: Date.now(),
      ...(trimmed ? { note: trimmed } : {}),
    };
    itemLabelsStore.addHighlight(params.itemKey(), params.itemType(), highlight);
    window.getSelection()?.removeAllRanges();
    popoverState = null;
    requestAnimationFrame(applyHighlights);
    void saveHighlightToMargin(highlight);
  }

  /** Save (or clear) the note on the highlight currently targeted by the popover. */
  function saveNoteFromPopover(note: string) {
    if (!popoverState?.highlightId) return;
    const itemKey = params.itemKey();
    const highlightId = popoverState.highlightId;
    popoverState = null;
    void (async () => {
      await itemLabelsStore.setHighlightNote(itemKey, highlightId, note);
      const updated = itemLabelsStore.getHighlights(itemKey).find((h) => h.id === highlightId);
      if (updated?.marginRkey) {
        await updateNoteOnMargin(updated);
      }
    })();
  }

  function removeHighlightFromPopover() {
    if (!popoverState?.highlightId) return;
    const highlightId = popoverState.highlightId;
    const existing = itemLabelsStore
      .getHighlights(params.itemKey())
      .find((h) => h.id === highlightId);
    if (existing) void removeFromMargin(existing);
    itemLabelsStore.removeHighlight(params.itemKey(), highlightId);
    popoverState = null;
    requestAnimationFrame(applyHighlights);
  }

  function closePopover() {
    popoverState = null;
  }

  // --- Margin (at.margin.note) sync ---
  // The actual write/queue logic lives in the shared marginHighlights service so
  // this reader path and the standalone Highlights view stay in lockstep; the
  // wrappers here just re-apply the on-page marks after a save.

  /** Push a single highlight to the user's Margin (at.margin.note). */
  async function saveHighlightToMargin(highlight: Highlight) {
    const ok = await saveToMargin(
      params.itemKey(),
      highlight,
      params.itemUrl?.(),
      params.itemTitle?.()
    );
    if (ok) requestAnimationFrame(applyHighlights);
  }

  /** Delete the Margin note backing a highlight (called when the highlight is removed). */
  async function removeFromMargin(highlight: Highlight) {
    await removeHighlightFromMargin(params.itemKey(), highlight);
  }

  /** Push an edited note onto the highlight's existing Margin note (same rkey). */
  async function updateNoteOnMargin(highlight: Highlight) {
    await updateHighlightNoteOnMargin(
      params.itemKey(),
      highlight,
      params.itemUrl?.(),
      params.itemTitle?.()
    );
  }

  /** True when the highlight currently targeted by the popover is saved to Margin. */
  function isPopoverHighlightSavedToMargin(): boolean {
    if (!popoverState?.highlightId) return false;
    const hl = itemLabelsStore
      .getHighlights(params.itemKey())
      .find((h) => h.id === popoverState!.highlightId);
    return !!hl?.marginUri;
  }

  /** The current note on the highlight targeted by the popover (for prefill). */
  function popoverHighlightNote(): string {
    if (!popoverState?.highlightId) return '';
    const hl = itemLabelsStore
      .getHighlights(params.itemKey())
      .find((h) => h.id === popoverState!.highlightId);
    return hl?.note ?? '';
  }

  /** Save-on-Margin action for the popover's currently-targeted highlight. */
  function savePopoverHighlightToMargin() {
    if (!popoverState?.highlightId) return;
    const hl = itemLabelsStore
      .getHighlights(params.itemKey())
      .find((h) => h.id === popoverState!.highlightId);
    popoverState = null;
    if (hl) void saveHighlightToMargin(hl);
  }

  /** Toggle highlight on the paragraph at the given index (for keyboard shortcut) */
  function toggleParagraphHighlight(paragraphIndex: number) {
    const container = params.contentEl();
    if (!container) return;

    const paragraphs = Array.from(container.querySelectorAll(BLOCK_SELECTORS)) as HTMLElement[];
    const para = paragraphs.filter((el) => (el.textContent?.trim() || '').length >= 20)[
      paragraphIndex
    ];
    if (!para) return;

    const highlights = itemLabelsStore.getHighlights(params.itemKey());
    const paragraphText = para.textContent ?? '';
    const existingHighlight = highlights.find((h) => h.selector.exact === paragraphText);

    if (existingHighlight) {
      void removeFromMargin(existingHighlight);
      itemLabelsStore.removeHighlight(params.itemKey(), existingHighlight.id);
    } else {
      const selector = createSelectorForElement(para, container);
      const highlight: Highlight = {
        id: generateId(),
        selector,
        createdAt: Date.now(),
      };
      itemLabelsStore.addHighlight(params.itemKey(), params.itemType(), highlight);
    }
    requestAnimationFrame(applyHighlights);
  }

  function attach() {
    const el = params.contentEl();
    if (!el || el === currentEl) return;
    detach();
    currentEl = el;

    dblclickHandler = handleDblClick;
    mouseupHandler = handleMouseUp;
    clickHandler = handleClick;
    touchendHandler = handleTouchEnd;
    selectionchangeHandler = handleSelectionChange;

    el.addEventListener('dblclick', dblclickHandler);
    // Listen on document so we catch mouseup even when the user
    // drag-selects past the edge of the content element
    document.addEventListener('mouseup', mouseupHandler);
    el.addEventListener('click', clickHandler);
    // Touch: synthesize double-tap (paragraph) since mobile browsers don't fire
    // dblclick. Non-passive so we can suppress the default double-tap gesture.
    el.addEventListener('touchend', touchendHandler, { passive: false });
    // Touch selections are realized into highlights when the user clears them.
    document.addEventListener('selectionchange', selectionchangeHandler);

    // Apply existing highlights
    applyHighlights();
  }

  function detach() {
    if (currentEl) {
      if (dblclickHandler) currentEl.removeEventListener('dblclick', dblclickHandler);
      if (mouseupHandler) document.removeEventListener('mouseup', mouseupHandler);
      if (clickHandler) currentEl.removeEventListener('click', clickHandler);
      if (touchendHandler) currentEl.removeEventListener('touchend', touchendHandler);
    }
    if (selectionchangeHandler)
      document.removeEventListener('selectionchange', selectionchangeHandler);
    clearMarks();
    currentEl = null;
    dblclickHandler = null;
    mouseupHandler = null;
    clickHandler = null;
    touchendHandler = null;
    selectionchangeHandler = null;
    pendingTouchSelector = null;
    popoverState = null;
  }

  onDestroy(detach);

  return {
    get popoverState() {
      return popoverState;
    },
    attach,
    detach,
    applyHighlights,
    createHighlightFromPopover,
    createHighlightFromPopoverToMargin,
    saveNoteFromPopover,
    removeHighlightFromPopover,
    closePopover,
    toggleParagraphHighlight,
    savePopoverHighlightToMargin,
    get popoverHighlightSavedToMargin() {
      return isPopoverHighlightSavedToMargin();
    },
    get popoverHighlightNote() {
      return popoverHighlightNote();
    },
  };
}
