import { onDestroy } from 'svelte';
import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
import {
  createSelector,
  createSelectorForElement,
  exceedsSelectorLimit,
  findTextInDOM,
} from '$lib/utils/textSelector';
import { toastStore } from '$lib/stores/toast.svelte';
import {
  saveHighlightToMargin as saveToMargin,
  removeHighlightFromMargin,
  updateHighlightNoteOnMargin,
} from '$lib/services/marginHighlights';
import type { ItemLabelType, Highlight, TextQuoteSelector } from '$lib/types';
import { wrapTextRange } from '$lib/utils/wrapTextRange';
import { visibleClientRect } from '$lib/utils/paginatedSelection';

const BLOCK_SELECTORS = 'p, h1, h2, h3, h4, h5, h6, blockquote, pre, figure, li';
const INTERACTIVE_MEDIA_SELECTOR = 'video, audio, iframe, embed, object';

// The inline note marker appended after a highlight that carries a note. A small
// comment glyph (Lucide message-circle), tinted into the highlight gold so it
// reads as part of the highlight rather than new chrome. Injected as raw DOM
// (the marks themselves are too), so the icon is inlined rather than rendered
// via the Icon component. Styled in SavedReader's `.highlight-note-marker`.
const NOTE_MARKER_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" /></svg>';

function canHover(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(hover: hover)').matches;
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

function makeHighlight(selector: TextQuoteSelector, note?: string): Highlight {
  const trimmed = note?.trim();
  return {
    id: generateId(),
    selector,
    createdAt: Date.now(),
    ...(trimmed ? { note: trimmed } : {}),
  };
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
  // State exposed for the component to render the popover. `view` mode is the
  // read-first surface for a highlight's note (note text + Edit/Remove), opened
  // by clicking the inline note marker; `create`/`remove` are the selection and
  // existing-highlight toolbars.
  let popoverState = $state<{
    mode: 'create' | 'adjust' | 'remove' | 'view';
    anchorRect: DOMRect;
    pendingSelector?: TextQuoteSelector;
    highlightId?: string;
    // Live anchors, so the popover can track what it points at while the reader
    // scrolls: the mark/marker element for an existing highlight, or a cloned
    // range for a selection (which outlives the selection being cleared).
    anchorEl?: HTMLElement;
    anchorRange?: Range;
  } | null>(null);

  // Desktop-only hover peek: a read-only preview of a note when the pointer
  // rests on its marker. Never set on touch (gated by `canHover`).
  let notePeek = $state<{ anchorRect: DOMRect; note: string } | null>(null);

  let currentEl: HTMLElement | null = null;
  let dblclickHandler: ((e: MouseEvent) => void) | null = null;
  let mousedownHandler: ((e: MouseEvent) => void) | null = null;
  let pointerdownHandler: ((e: PointerEvent) => void) | null = null;
  let mouseupHandler: ((e: MouseEvent) => void) | null = null;
  let clickHandler: ((e: MouseEvent) => void) | null = null;
  let touchendHandler: ((e: TouchEvent) => void) | null = null;
  let selectionchangeHandler: (() => void) | null = null;
  let keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  let mouseoverHandler: ((e: MouseEvent) => void) | null = null;
  let mouseoutHandler: ((e: MouseEvent) => void) | null = null;
  let appliedMarks: HTMLElement[] = [];
  let appliedNoteMarkers: HTMLElement[] = [];

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
  // A live touch selection that has grown past what a selector can carry. Held
  // until the selection collapses so the reader hears about it once, when they
  // let go, instead of on every `selectionchange` of the drag.
  let touchSelectionTooLong = false;
  // Pointer bookkeeping, recorded on the way down so `mouseup` knows what kind of
  // gesture it is finishing.
  //
  // `pressStartedInContent` separates a drag through the prose (which should
  // offer a popover, even when the pointer is released past the edge of the
  // article — the reason the mouseup listener is on `document`) from a press on
  // the chrome around it. Without it, the mouseup of the *Adjust highlight*
  // button re-opens a toolbar over the selection that button just made
  // programmatically, hiding the adjust bar a few milliseconds after it appears.
  //
  // `lastPointerWasMouse` refines `sawTouch`, which latches on the first touch
  // and never resets: on a hybrid machine (a touchscreen laptop) it stays true
  // for subsequent mouse gestures, so it can't decide on its own whether a
  // collapse came from a touch.
  let pressStartedInContent = false;
  let lastPointerWasMouse = false;
  // Set while the reader is re-bounding an existing highlight. Reactive so the
  // host can show (and offer a way out of) that mode — an invisible mode with no
  // exit would quietly re-bind whatever they selected next.
  let adjustingHighlightId = $state<string | null>(null);

  /**
   * A highlight longer than `MAX_EXACT_LENGTH` can't be stored without quietly
   * dropping its tail, so nothing is written and the reader is told. Paged
   * reading is what made this reachable: a selection now runs across page turns.
   */
  function reportTooLong() {
    toastStore.update(toastStore.add('Selection too long to highlight'), 'error');
  }

  function applyHighlights() {
    clearMarks();
    const el = params.contentEl();
    if (!el) return;

    const highlights = itemLabelsStore.getHighlights(params.itemKey());
    for (const highlight of highlights) {
      const range = findTextInDOM(highlight.selector, el);
      if (!range) continue;
      const before = appliedMarks.length;
      wrapRange(range, highlight.id);
      // A note gets an inline marker after the highlight's final mark.
      if (highlight.note) {
        const lastMark = appliedMarks[appliedMarks.length - 1];
        if (lastMark && appliedMarks.length > before) insertNoteMarker(lastMark, highlight.id);
      }
    }
  }

  /** Append the inline comment-glyph marker immediately after a highlight's last mark. */
  function insertNoteMarker(afterMark: HTMLElement, highlightId: string) {
    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = 'highlight-note-marker';
    marker.dataset.highlightId = highlightId;
    marker.setAttribute('aria-label', 'Show note');
    marker.innerHTML = NOTE_MARKER_SVG;
    afterMark.after(marker);
    appliedNoteMarkers.push(marker);
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
    const container = params.contentEl();
    if (!container) return;
    appliedMarks.push(
      ...wrapTextRange(range, container, () => {
        const mark = document.createElement('mark');
        mark.className = 'highlight';
        mark.dataset.highlightId = highlightId;
        return mark;
      })
    );
  }

  function clearMarks() {
    // Remove note markers first so the subsequent `normalize()` can merge the
    // text nodes the markers were sitting between.
    for (const marker of appliedNoteMarkers) marker.remove();
    appliedNoteMarkers = [];
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
    if (exceedsSelectorLimit(paragraphText)) {
      reportTooLong();
      return true;
    }
    const selector = createSelectorForElement(blockEl, container);
    itemLabelsStore.addHighlight(params.itemKey(), params.itemType(), makeHighlight(selector));
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

    // A touch that ends with text still selected belongs to the selection
    // gesture (a handle drag, or the tap that will dismiss it), never to the
    // first half of a double tap — don't seed a pair it could complete. This
    // runs *after* the double-tap branch on purpose: the second tap of a pair
    // also has a live word selection, and bailing before that branch would kill
    // double-tap-to-highlight-a-paragraph outright.
    const liveSelection = window.getSelection();
    if (liveSelection && !liveSelection.isCollapsed) {
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
    if (!params.enabled()) return;

    // Pointer devices commit from the mouseup popover. In particular, do not
    // cancel an adjustment on the collapsed selectionchange emitted by
    // mousedown: that is also how an ordinary drag starts. Mouseup can tell a
    // click-away (still collapsed) from a completed re-selection. This asks for
    // a touch *gesture*, not merely a touch-capable device: on a hybrid machine
    // the sticky `sawTouch` would otherwise route mouse drags down here, where a
    // mousedown's collapse commits the adjustment before it was ever dragged.
    if (!touchGesture()) return;

    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.rangeCount) {
      const range = selection.getRangeAt(0);
      const container = params.contentEl();
      if (container && container.contains(range.commonAncestorContainer)) {
        const selectedText = range.toString().trim();
        if (selectedText.length >= 3) {
          // Report over-long only once the reader lets go: `selectionchange`
          // fires on every handle movement, and a toast per frame of a drag
          // that is merely passing through 5 000 characters is noise.
          if (exceedsSelectorLimit(range.toString())) {
            pendingTouchSelector = null;
            touchSelectionTooLong = true;
            return;
          }
          touchSelectionTooLong = false;
          pendingTouchSelector = createSelector(range, container);
          return;
        }
      }
      // Selection is outside our content or too short — nothing to highlight.
      pendingTouchSelector = null;
      touchSelectionTooLong = false;
      return;
    }

    // Selection collapsed: realize the pending highlight, if any.
    if (!pendingTouchSelector) {
      if (touchSelectionTooLong) {
        // The reader made a selection we can't store faithfully. Say so, and
        // stay in adjust mode if we were in it — the bounds are untouched and
        // the next drag can be shorter.
        touchSelectionTooLong = false;
        reportTooLong();
        return;
      }
      // Nothing to commit (the selection never got long enough, or left the
      // article). Leave adjust mode rather than letting it wait for a later,
      // unrelated selection to re-bind the highlight onto.
      cancelAdjust();
      return;
    }
    const selector = pendingTouchSelector;
    pendingTouchSelector = null;
    if (adjustingHighlightId) {
      const highlightId = adjustingHighlightId;
      adjustingHighlightId = null;
      void commitSelectorAdjustment(highlightId, selector);
    } else {
      itemLabelsStore.addHighlight(params.itemKey(), params.itemType(), makeHighlight(selector));
    }
    requestAnimationFrame(applyHighlights);
  }

  /** True when the gesture in progress is a touch, not a mouse press. */
  function touchGesture(): boolean {
    return sawTouch && !lastPointerWasMouse;
  }

  /** Remember where (and with what) the pointer went down. See the fields' notes. */
  function handleMouseDown(e: MouseEvent) {
    const container = params.contentEl();
    const target = e.target as Node | null;
    pressStartedInContent = !!container && !!target && container.contains(target);
  }

  function handlePointerDown(e: PointerEvent) {
    lastPointerWasMouse = e.pointerType === 'mouse';
  }

  function handleMouseUp(e: MouseEvent) {
    if (!params.enabled()) return;
    const target = e.target as HTMLElement;
    // Only a press that began in the prose is a selection gesture; one that
    // began on the popover, the adjust bar or the pager is chrome finishing its
    // own click, and must not be answered with a toolbar.
    const fromContent = pressStartedInContent;
    // Small delay to let selection finalize
    setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) {
        // A press in the article that ends with nothing selected is a click
        // away: leave adjust mode rather than letting it wait to re-bind the
        // reader's next, unrelated selection.
        if (fromContent && adjustingHighlightId) cancelAdjust();
        return;
      }

      if (!fromContent) return;
      if (target.closest(INTERACTIVE_MEDIA_SELECTOR)) return;

      const range = selection.getRangeAt(0);
      const container = params.contentEl();
      if (!container || !container.contains(range.commonAncestorContainer)) return;

      const selectedText = range.toString().trim();
      if (!selectedText || selectedText.length < 3) return;
      // Refuse rather than offer a toolbar that would save a quietly shortened
      // quote. Adjust mode stays on, so the reader can drag a smaller range.
      if (exceedsSelectorLimit(range.toString())) {
        reportTooLong();
        return;
      }

      const rect = selectionAnchorRect(range);
      if (!rect) return;
      const selector = createSelector(range, container);

      popoverState = {
        mode: adjustingHighlightId ? 'adjust' : 'create',
        anchorRect: rect,
        pendingSelector: selector,
        highlightId: adjustingHighlightId ?? undefined,
        anchorRange: range.cloneRange(),
      };
    }, 10);
  }

  function handleClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.closest(INTERACTIVE_MEDIA_SELECTOR)) return;

    // The inline note marker opens the read-first note popover.
    const marker = target.closest('.highlight-note-marker') as HTMLElement | null;
    if (marker) {
      const highlightId = marker.dataset.highlightId;
      if (!highlightId) return;
      e.preventDefault();
      e.stopPropagation();
      notePeek = null;
      popoverState = {
        mode: 'view',
        anchorRect: marker.getBoundingClientRect(),
        highlightId,
        anchorEl: marker,
      };
      return;
    }

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
      anchorEl: mark,
    };
  }

  /**
   * Desktop hover peek. Resting the pointer on a note marker shows a read-only
   * preview; the peek carries no controls (so there's no hover-bridge to cross)
   * — clicking the marker opens the actionable popover instead.
   */
  function handleMouseOver(e: MouseEvent) {
    if (!canHover()) return;
    const marker = (e.target as HTMLElement).closest?.(
      '.highlight-note-marker'
    ) as HTMLElement | null;
    if (!marker) return;
    const highlightId = marker.dataset.highlightId;
    const hl = itemLabelsStore.getHighlights(params.itemKey()).find((h) => h.id === highlightId);
    if (!hl?.note) return;
    notePeek = { anchorRect: marker.getBoundingClientRect(), note: hl.note };
  }

  function handleMouseOut(e: MouseEvent) {
    if (!notePeek) return;
    const marker = (e.target as HTMLElement).closest?.('.highlight-note-marker');
    if (!marker) return;
    const related = e.relatedTarget as Node | null;
    if (related && marker.contains(related)) return;
    notePeek = null;
  }

  /** Create a highlight from the current selection, optionally pushing it to Margin. */
  function createHighlightFromPopover(note?: string, toMargin = false) {
    if (!popoverState?.pendingSelector) return;

    // Adjust only ever moves the bounds: the popover hides the note / Margin /
    // quote actions in that mode, so there is no `note` or `toMargin` here to
    // silently drop. Everything else on the highlight is carried through.
    if (popoverState.mode === 'adjust' && popoverState.highlightId) {
      const highlightId = popoverState.highlightId;
      const selector = popoverState.pendingSelector;
      adjustingHighlightId = null;
      pendingTouchSelector = null;
      popoverState = null;
      window.getSelection()?.removeAllRanges();
      void commitSelectorAdjustment(highlightId, selector);
      return;
    }

    const highlight = makeHighlight(popoverState.pendingSelector, note);
    itemLabelsStore.addHighlight(params.itemKey(), params.itemType(), highlight);
    pendingTouchSelector = null;
    window.getSelection()?.removeAllRanges();
    popoverState = null;
    requestAnimationFrame(applyHighlights);
    if (toMargin) void saveHighlightToMargin(highlight);
  }

  async function commitSelectorAdjustment(highlightId: string, selector: TextQuoteSelector) {
    const itemKey = params.itemKey();
    await itemLabelsStore.setHighlightSelector(itemKey, highlightId, selector);
    requestAnimationFrame(applyHighlights);
    const updated = itemLabelsStore.getHighlights(itemKey).find((h) => h.id === highlightId);
    if (updated?.marginRkey) await updateNoteOnMargin(updated);
  }

  function adjustHighlightFromPopover() {
    const highlightId = popoverState?.highlightId;
    const container = params.contentEl();
    const highlight = itemLabelsStore
      .getHighlights(params.itemKey())
      .find((entry) => entry.id === highlightId);
    if (!highlightId || !container || !highlight) return;
    const range = findTextInDOM(highlight.selector, container);
    if (!range) return;
    popoverState = null;
    adjustingHighlightId = highlightId;
    // Seeds the touch commit-on-collapse path with the *current* bounds, so a
    // reader who taps away without dragging anything writes nothing (the union
    // mutation drops an identical selector).
    pendingTouchSelector = highlight.selector;
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  /** Leave adjust mode with the highlight's bounds untouched. */
  function cancelAdjust() {
    if (!adjustingHighlightId) return;
    adjustingHighlightId = null;
    pendingTouchSelector = null;
    if (popoverState?.mode === 'adjust') popoverState = null;
    window.getSelection()?.removeAllRanges();
  }

  function handleKeydown(e: KeyboardEvent) {
    // Escape is the universal way out of adjust mode; the popover handles its
    // own Escape, so only the popover-less "drag the handles" state gets here.
    if (e.key !== 'Escape' || !adjustingHighlightId || popoverState) return;
    e.preventDefault();
    e.stopPropagation();
    cancelAdjust();
  }

  /** Create a highlight from the current selection and push it to Margin. */
  function createHighlightFromPopoverToMargin(note?: string) {
    createHighlightFromPopover(note, true);
  }

  /** Save (or clear) the note on the highlight currently targeted by the popover. */
  function saveNoteFromPopover(note: string) {
    if (!popoverState?.highlightId) return;
    const itemKey = params.itemKey();
    const highlightId = popoverState.highlightId;
    popoverState = null;
    void (async () => {
      await itemLabelsStore.setHighlightNote(itemKey, highlightId, note);
      // Re-apply so the inline note marker appears (note added) or disappears
      // (note cleared) to match the new state.
      requestAnimationFrame(applyHighlights);
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

  /**
   * Dismiss the popover without deciding anything about the highlight — the
   * outside-click and scrolled-away paths. This deliberately leaves adjust mode
   * running: the press that starts a fresh drag through the article is itself an
   * outside click, and dropping the mode there would turn that drag into a
   * second highlight overlapping the one being adjusted. Adjust mode ends only
   * through Cancel, Escape, a click that leaves nothing selected, or a committed
   * adjustment — and while it runs without a popover the adjust bar is up, so it
   * is never invisible.
   */
  function closePopover() {
    popoverState = null;
  }

  function selectionAnchorRect(range: Range): DOMRect | null {
    const container = params.contentEl();
    const viewport = container?.closest('.paged-viewport') as HTMLElement | null;
    if (!viewport) return range.getBoundingClientRect();
    return visibleClientRect(range.getClientRects(), viewport.getBoundingClientRect());
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

  /**
   * Where the open popover's anchor sits *now*. Re-applying the marks replaces
   * the element the popover opened against, so fall back to whichever mark
   * currently carries the highlight; `null` means the passage is gone from the
   * body and the popover has nothing left to point at.
   */
  function popoverAnchorRect(): DOMRect | null {
    const state = popoverState;
    if (!state) return null;
    if (state.anchorRange) {
      const rect = selectionAnchorRect(state.anchorRange);
      // A range whose nodes have been replaced measures as an empty rect.
      return rect && (rect.width || rect.height) ? rect : null;
    }
    const live =
      state.anchorEl?.isConnected === true
        ? state.anchorEl
        : state.highlightId
          ? (params
              .contentEl()
              ?.querySelector<HTMLElement>(
                `mark.highlight[data-highlight-id="${CSS.escape(state.highlightId)}"]`
              ) ?? null)
          : null;
    if (!live) return null;
    const container = params.contentEl();
    const viewport = container?.closest('.paged-viewport') as HTMLElement | null;
    if (!viewport || !state.highlightId) return live.getBoundingClientRect();
    const marks = container?.querySelectorAll<HTMLElement>(
      `mark.highlight[data-highlight-id="${CSS.escape(state.highlightId)}"]`
    );
    return visibleClientRect(
      Array.from(marks ?? [], (mark) => mark.getBoundingClientRect()),
      viewport.getBoundingClientRect()
    );
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
      itemLabelsStore.addHighlight(params.itemKey(), params.itemType(), makeHighlight(selector));
    }
    requestAnimationFrame(applyHighlights);
  }

  function attach() {
    const el = params.contentEl();
    if (!el || el === currentEl) return;
    detach();
    currentEl = el;

    dblclickHandler = handleDblClick;
    mousedownHandler = handleMouseDown;
    pointerdownHandler = handlePointerDown;
    mouseupHandler = handleMouseUp;
    clickHandler = handleClick;
    touchendHandler = handleTouchEnd;
    selectionchangeHandler = handleSelectionChange;
    keydownHandler = handleKeydown;
    mouseoverHandler = handleMouseOver;
    mouseoutHandler = handleMouseOut;

    el.addEventListener('dblclick', dblclickHandler);
    // Listen on document so we catch mouseup even when the user
    // drag-selects past the edge of the content element, and the matching
    // mousedown so that mouseup knows whether the press began in the article.
    // Capture, because the popover stops mousedown propagating.
    document.addEventListener('mousedown', mousedownHandler, true);
    document.addEventListener('pointerdown', pointerdownHandler, true);
    document.addEventListener('mouseup', mouseupHandler);
    el.addEventListener('click', clickHandler);
    el.addEventListener('mouseover', mouseoverHandler);
    el.addEventListener('mouseout', mouseoutHandler);
    // Touch: synthesize double-tap (paragraph) since mobile browsers don't fire
    // dblclick. Non-passive so we can suppress the default double-tap gesture.
    el.addEventListener('touchend', touchendHandler, { passive: false });
    // Touch selections are realized into highlights when the user clears them.
    document.addEventListener('selectionchange', selectionchangeHandler);
    // Escape leaves adjust mode (capture, so the reader's own Escape doesn't
    // close out from under it).
    document.addEventListener('keydown', keydownHandler, true);

    // Apply existing highlights
    applyHighlights();
  }

  function detach() {
    if (currentEl) {
      if (dblclickHandler) currentEl.removeEventListener('dblclick', dblclickHandler);
      if (mousedownHandler) document.removeEventListener('mousedown', mousedownHandler, true);
      if (pointerdownHandler) document.removeEventListener('pointerdown', pointerdownHandler, true);
      if (mouseupHandler) document.removeEventListener('mouseup', mouseupHandler);
      if (clickHandler) currentEl.removeEventListener('click', clickHandler);
      if (touchendHandler) currentEl.removeEventListener('touchend', touchendHandler);
      if (mouseoverHandler) currentEl.removeEventListener('mouseover', mouseoverHandler);
      if (mouseoutHandler) currentEl.removeEventListener('mouseout', mouseoutHandler);
    }
    if (selectionchangeHandler)
      document.removeEventListener('selectionchange', selectionchangeHandler);
    if (keydownHandler) document.removeEventListener('keydown', keydownHandler, true);
    clearMarks();
    currentEl = null;
    dblclickHandler = null;
    mousedownHandler = null;
    pointerdownHandler = null;
    mouseupHandler = null;
    clickHandler = null;
    touchendHandler = null;
    selectionchangeHandler = null;
    keydownHandler = null;
    mouseoverHandler = null;
    mouseoutHandler = null;
    pendingTouchSelector = null;
    touchSelectionTooLong = false;
    adjustingHighlightId = null;
    popoverState = null;
    notePeek = null;
    pressStartedInContent = false;
    lastPointerWasMouse = false;
  }

  onDestroy(detach);

  return {
    get popoverState() {
      return popoverState;
    },
    get notePeek() {
      return notePeek;
    },
    closeNotePeek() {
      notePeek = null;
    },
    attach,
    detach,
    applyHighlights,
    popoverAnchorRect,
    createHighlightFromPopover,
    createHighlightFromPopoverToMargin,
    saveNoteFromPopover,
    removeHighlightFromPopover,
    adjustHighlightFromPopover,
    cancelAdjust,
    get adjusting() {
      return adjustingHighlightId !== null;
    },
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
