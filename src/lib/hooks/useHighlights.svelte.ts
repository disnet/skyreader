import { onDestroy } from 'svelte';
import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
import { createSelector, createSelectorForElement, findTextInDOM } from '$lib/utils/textSelector';
import type { ItemLabelType, Highlight, TextQuoteSelector } from '$lib/types';

const BLOCK_SELECTORS = 'p, h1, h2, h3, h4, h5, h6, blockquote, pre, figure, li';

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

interface HighlightParams {
  contentEl: () => HTMLElement | undefined;
  itemKey: () => string;
  itemType: () => ItemLabelType;
  enabled: () => boolean;
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
  let appliedMarks: HTMLElement[] = [];

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

  function handleDblClick(e: MouseEvent) {
    if (!params.enabled()) return;

    const target = e.target as HTMLElement;
    // Don't intercept link double-clicks
    if (target.closest('a')) return;

    const blockEl = target.closest(BLOCK_SELECTORS) as HTMLElement | null;
    if (!blockEl) return;

    const container = params.contentEl();
    if (!container) return;

    // Check if this paragraph already has a highlight
    const highlights = itemLabelsStore.getHighlights(params.itemKey());
    const paragraphText = blockEl.textContent ?? '';
    const existingHighlight = highlights.find((h) => h.selector.exact === paragraphText);

    if (existingHighlight) {
      // Toggle off: remove the highlight
      itemLabelsStore.removeHighlight(params.itemKey(), existingHighlight.id);
      requestAnimationFrame(applyHighlights);
      return;
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
  }

  function handleMouseUp(e: MouseEvent) {
    if (!params.enabled()) return;
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

  function createHighlightFromPopover() {
    if (!popoverState?.pendingSelector) return;

    const highlight: Highlight = {
      id: generateId(),
      selector: popoverState.pendingSelector,
      createdAt: Date.now(),
    };
    itemLabelsStore.addHighlight(params.itemKey(), params.itemType(), highlight);
    window.getSelection()?.removeAllRanges();
    popoverState = null;
    requestAnimationFrame(applyHighlights);
  }

  function removeHighlightFromPopover() {
    if (!popoverState?.highlightId) return;
    itemLabelsStore.removeHighlight(params.itemKey(), popoverState.highlightId);
    popoverState = null;
    requestAnimationFrame(applyHighlights);
  }

  function closePopover() {
    popoverState = null;
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

    el.addEventListener('dblclick', dblclickHandler);
    el.addEventListener('mouseup', mouseupHandler);
    el.addEventListener('click', clickHandler);

    // Apply existing highlights
    applyHighlights();
  }

  function detach() {
    if (currentEl) {
      if (dblclickHandler) currentEl.removeEventListener('dblclick', dblclickHandler);
      if (mouseupHandler) currentEl.removeEventListener('mouseup', mouseupHandler);
      if (clickHandler) currentEl.removeEventListener('click', clickHandler);
    }
    clearMarks();
    currentEl = null;
    dblclickHandler = null;
    mouseupHandler = null;
    clickHandler = null;
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
    removeHighlightFromPopover,
    closePopover,
    toggleParagraphHighlight,
  };
}
