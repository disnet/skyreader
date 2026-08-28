<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';

  /**
   * Grab handles on the highlight the reader has tapped: a knob at each end of
   * the passage that re-bounds it by direct manipulation.
   *
   * This replaces an "Adjust highlight" button that re-selected the passage and
   * handed the reader back to the browser's own selection handles. That mode was
   * invisible, easy to fall out of, and on desktop it had no handles at all —
   * the reader had to re-drag the whole passage from scratch. Handles are the
   * affordance people already know from every text field, and they belong to the
   * highlight rather than to a mode.
   *
   * Nothing in the article is mutated while a handle is being dragged: the
   * highlight's own marks are dimmed in place with an inline style and the new
   * bounds are painted as an overlay. That keeps every DOM position the drag
   * depends on — the pivot boundary, the caret hit-testing — valid for the whole
   * gesture. The real marks are only re-drawn once, from the committed range.
   */

  interface Props {
    /** The highlight wearing the handles. */
    highlightId: string;
    /** The article body the highlight lives in. */
    contentEl: () => HTMLElement | undefined;
    /** New bounds, on release. Called with a live range inside `contentEl`. */
    onAdjust: (range: Range) => void;
  }

  let { highlightId, contentEl, onAdjust }: Props = $props();

  type Side = 'start' | 'end';
  /** A handle's vertical bar: the line box edge the boundary sits on. */
  interface Band {
    x: number;
    top: number;
    height: number;
  }
  interface Box {
    left: number;
    top: number;
    width: number;
    height: number;
  }

  let startBand = $state<Band | null>(null);
  let endBand = $state<Band | null>(null);
  // The dragged bounds, painted while a handle is held. Empty at rest, when the
  // marks in the article are showing the highlight themselves.
  let previewBoxes = $state<Box[]>([]);
  let adjusting = $state<Side | null>(null);

  // The end that stays put for the duration of the gesture.
  let pivot: { node: Node; offset: number } | null = null;
  let previewRange: Range | null = null;
  // Where the finger sat relative to the boundary when it grabbed the knob, so
  // the boundary tracks the same spot under the finger instead of jumping to it.
  let grabDx = 0;
  let grabDy = 0;
  let viaPointer = false;
  let dimmed: HTMLElement[] = [];
  let frame: number | null = null;

  function marks(): HTMLElement[] {
    const el = contentEl();
    if (!el) return [];
    return Array.from(
      el.querySelectorAll<HTMLElement>(
        `mark.highlight[data-highlight-id="${CSS.escape(highlightId)}"]`
      )
    );
  }

  /** The page window in paged reading — nothing outside it is on screen. */
  function pageRect(): DOMRect | null {
    const viewport = contentEl()?.closest('.paged-viewport');
    return viewport ? viewport.getBoundingClientRect() : null;
  }

  function onPage(rect: DOMRect, page: DOMRect | null): boolean {
    if (!page) return true;
    return (
      rect.right > page.left &&
      rect.left < page.right &&
      rect.bottom > page.top &&
      rect.top < page.bottom
    );
  }

  /** Line boxes of what the handles currently bracket: the drag, or the marks. */
  function bracketedRects(): DOMRect[] {
    const rects: DOMRect[] = [];
    const source = previewRange
      ? previewRange.getClientRects()
      : marks().flatMap((mark) => Array.from(mark.getClientRects()));
    for (const rect of source) if (rect.width > 0 || rect.height > 0) rects.push(rect);
    return rects;
  }

  function sameBand(a: Band | null, b: Band | null): boolean {
    if (!a || !b) return a === b;
    return (
      Math.abs(a.x - b.x) < 0.5 &&
      Math.abs(a.top - b.top) < 0.5 &&
      Math.abs(a.height - b.height) < 0.5
    );
  }

  function sameBoxes(a: Box[], b: Box[]): boolean {
    if (a.length !== b.length) return false;
    return a.every(
      (box, i) =>
        Math.abs(box.left - b[i].left) < 0.5 &&
        Math.abs(box.top - b[i].top) < 0.5 &&
        Math.abs(box.width - b[i].width) < 0.5 &&
        Math.abs(box.height - b[i].height) < 0.5
    );
  }

  /**
   * Re-read the geometry. Runs every frame while the handles are up: the text
   * under them moves for reasons that emit no event we could listen for — a page
   * turn animates a transform, a font-size change reflows, a commit replaces the
   * marks outright — and a handle parked at a stale spot is worse than none.
   */
  function measure() {
    const rects = bracketedRects();
    const page = pageRect();
    if (!rects.length) {
      if (startBand) startBand = null;
      if (endBand) endBand = null;
      if (previewBoxes.length) previewBoxes = [];
      return;
    }
    const first = rects[0];
    const last = rects[rects.length - 1];
    // A handle is only drawn when its own end of the passage is on the page the
    // reader is looking at; the other end may be pages away.
    const nextStart = onPage(first, page)
      ? { x: first.left, top: first.top, height: first.height }
      : null;
    const nextEnd = onPage(last, page)
      ? { x: last.right, top: last.top, height: last.height }
      : null;
    if (!sameBand(startBand, nextStart)) startBand = nextStart;
    if (!sameBand(endBand, nextEnd)) endBand = nextEnd;

    const boxes = adjusting
      ? rects
          .filter((rect) => onPage(rect, page))
          .map((rect) => ({
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          }))
      : [];
    if (!sameBoxes(previewBoxes, boxes)) previewBoxes = boxes;
  }

  function tick() {
    measure();
    frame = requestAnimationFrame(tick);
  }

  // --- Text positions ---

  function textNodes(root: HTMLElement): Text[] {
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.textContent?.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    return nodes;
  }

  /** The highlight's current bounds, read back off the marks on the page. */
  function markRange(): Range | null {
    const list = marks();
    if (!list.length) return null;
    const first = textNodes(list[0])[0];
    const tail = textNodes(list[list.length - 1]);
    const last = tail[tail.length - 1];
    if (!first || !last) return null;
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(last, last.length);
    return range;
  }

  function pointFromClient(x: number, y: number): { node: Node; offset: number } | null {
    const doc = document as Document & {
      caretPositionFromPoint?: (
        x: number,
        y: number
      ) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const position = doc.caretPositionFromPoint?.(x, y);
    if (position) return { node: position.offsetNode, offset: position.offset };
    const range = doc.caretRangeFromPoint?.(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }

  /** Move a boundary one character along the article's text. */
  function stepPoint(
    point: { node: Node; offset: number },
    delta: number
  ): { node: Node; offset: number } | null {
    const container = contentEl();
    if (!container || point.node.nodeType !== Node.TEXT_NODE) return null;
    const nodes = textNodes(container);
    let index = nodes.indexOf(point.node as Text);
    if (index < 0) return null;
    let offset = point.offset + delta;
    while (offset < 0) {
      index -= 1;
      if (index < 0) return null;
      offset += nodes[index].length;
    }
    while (offset > nodes[index].length) {
      offset -= nodes[index].length;
      index += 1;
      if (index >= nodes.length) return null;
    }
    return { node: nodes[index], offset };
  }

  /**
   * The range from the untouched end to `point`, or null when the point isn't a
   * usable boundary — outside the article, or past the end it's pivoting on
   * (dragging the start handle beyond the end would invert the highlight).
   */
  function rangeTo(side: Side, point: { node: Node; offset: number } | null): Range | null {
    const container = contentEl();
    if (!point || !pivot || !container) return null;
    if (point.node.nodeType !== Node.TEXT_NODE || !container.contains(point.node)) return null;
    const probe = document.createRange();
    try {
      probe.setStart(pivot.node, pivot.offset);
      probe.collapse(true);
      const relation = probe.comparePoint(point.node, point.offset);
      if (side === 'start' ? relation !== -1 : relation !== 1) return null;
    } catch {
      return null;
    }
    const range = document.createRange();
    if (side === 'start') {
      range.setStart(point.node, point.offset);
      range.setEnd(pivot.node, pivot.offset);
    } else {
      range.setStart(pivot.node, pivot.offset);
      range.setEnd(point.node, point.offset);
    }
    return range.toString().trim().length ? range : null;
  }

  // --- Adjusting ---

  function dimMarks() {
    dimmed = marks();
    // Inline, not a class: the marks' own background is set by each reader's
    // scoped stylesheet, and an inline value wins that without either side
    // having to know about the other.
    for (const mark of dimmed) mark.style.backgroundColor = 'transparent';
  }

  function restoreMarks() {
    for (const mark of dimmed) mark.style.backgroundColor = '';
    dimmed = [];
  }

  /** Begin an adjustment of `side`, pivoting on the opposite boundary. */
  function begin(side: Side): Range | null {
    const base = previewRange ?? markRange();
    if (!base) return null;
    if (!adjusting) {
      pivot =
        side === 'start'
          ? { node: base.endContainer, offset: base.endOffset }
          : { node: base.startContainer, offset: base.startOffset };
      previewRange = base;
      adjusting = side;
      dimMarks();
    }
    return base;
  }

  function handlePointerDown(e: PointerEvent, side: Side) {
    if (!begin(side)) return;
    e.preventDefault();
    e.stopPropagation();
    viaPointer = true;
    const band = side === 'start' ? startBand : endBand;
    grabDx = band ? e.clientX - band.x : 0;
    grabDy = band ? e.clientY - (band.top + band.height / 2) : 0;
    // A live text selection under the handles would both fight the drag and
    // leave the reader a "highlight this" toolbar for text they didn't select.
    window.getSelection()?.removeAllRanges();
    document.body.style.userSelect = 'none';
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // Capture is a nicety; the window listeners below carry the drag anyway.
    }
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', commit);
    window.addEventListener('pointercancel', cancel);
    measure();
  }

  function handlePointerMove(e: PointerEvent) {
    if (!adjusting) return;
    e.preventDefault();
    const next = rangeTo(adjusting, pointFromClient(e.clientX - grabDx, e.clientY - grabDy));
    if (next) previewRange = next;
  }

  function handleKeydown(e: KeyboardEvent, side: Side) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const base = begin(side);
      if (!base) return;
      e.preventDefault();
      e.stopPropagation();
      const edge =
        side === 'start'
          ? { node: base.startContainer, offset: base.startOffset }
          : { node: base.endContainer, offset: base.endOffset };
      const stepped = stepPoint(edge, e.key === 'ArrowLeft' ? -1 : 1);
      const next = rangeTo(side, stepped);
      if (next) previewRange = next;
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      if (!adjusting) return;
      e.preventDefault();
      e.stopPropagation();
      commit();
      return;
    }
    if (e.key === 'Escape' && adjusting) {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  }

  /** Keyboard adjustments are open-ended; leaving the handle settles them. */
  function handleBlur() {
    if (adjusting && !viaPointer) commit();
  }

  function stop() {
    adjusting = null;
    pivot = null;
    previewRange = null;
    viaPointer = false;
    restoreMarks();
    previewBoxes = [];
    document.body.style.userSelect = '';
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', commit);
    window.removeEventListener('pointercancel', cancel);
  }

  function commit() {
    const adjusted = previewRange;
    const wasAdjusting = adjusting !== null;
    stop();
    // Hand back the marks before the new bounds land, so the article is never
    // showing a dimmed highlight and a fresh one at the same time.
    if (wasAdjusting && adjusted) onAdjust(adjusted);
  }

  function cancel() {
    stop();
  }

  // A different highlight means a different passage; drop anything half-dragged.
  $effect(() => {
    void highlightId;
    untrack(() => {
      if (adjusting) stop();
    });
  });

  onMount(() => {
    measure();
    frame = requestAnimationFrame(tick);
  });

  onDestroy(() => {
    if (frame !== null) cancelAnimationFrame(frame);
    stop();
  });
</script>

<div class="highlight-handles">
  {#each previewBoxes as box, i (i)}
    <div
      class="preview"
      style="left: {box.left}px; top: {box.top}px; width: {box.width}px; height: {box.height}px"
    ></div>
  {/each}

  {#if startBand}
    <div
      class="handle start"
      class:active={adjusting === 'start'}
      style="left: {startBand.x}px; top: {startBand.top}px; height: {startBand.height}px"
    >
      <span class="stem"></span>
      <button
        class="knob"
        type="button"
        aria-label="Adjust where the highlight starts"
        onpointerdown={(e) => handlePointerDown(e, 'start')}
        onkeydown={(e) => handleKeydown(e, 'start')}
        onblur={handleBlur}
      ></button>
    </div>
  {/if}

  {#if endBand}
    <div
      class="handle end"
      class:active={adjusting === 'end'}
      style="left: {endBand.x}px; top: {endBand.top}px; height: {endBand.height}px"
    >
      <span class="stem"></span>
      <button
        class="knob"
        type="button"
        aria-label="Adjust where the highlight ends"
        onpointerdown={(e) => handlePointerDown(e, 'end')}
        onkeydown={(e) => handleKeydown(e, 'end')}
        onblur={handleBlur}
      ></button>
    </div>
  {/if}
</div>

<style>
  /* A pass-through layer: only the knobs themselves take the pointer, so the
     article underneath stays readable, scrollable and hit-testable — the drag
     asks the document what character is under the finger, and a live overlay
     would answer for it. */
  .highlight-handles {
    position: fixed;
    inset: 0;
    z-index: 198;
    pointer-events: none;
  }

  .preview {
    position: fixed;
    background-color: color-mix(in srgb, #f5c518 32%, transparent);
    border-radius: 1px;
  }

  .handle {
    position: fixed;
    width: 2px;
  }

  .stem {
    position: absolute;
    inset: 0;
    border-radius: 1px;
    background: var(--color-primary);
  }

  .knob {
    position: absolute;
    left: 50%;
    /* Generous, invisible target around a small dot: the dot has to stay out of
       the way of the words it brackets, the target has to survive a fingertip.
       The height is what the highlight's toolbar has to clear (see the `gap` in
       HighlightPopover) — grow it and the toolbar starts eating the press. */
    width: 2.25rem;
    height: 1.875rem;
    margin-left: -1.125rem;
    padding: 0;
    border: 0;
    background: none;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: auto;
    /* The knob owns the whole gesture: no panning, no long-press selection or
       callout underneath it. */
    touch-action: none;
    user-select: none;
    -webkit-touch-callout: none;
    cursor: grab;
  }

  .knob::before {
    content: '';
    width: 0.8125rem;
    height: 0.8125rem;
    border-radius: 50%;
    background: var(--color-primary);
    /* Floating tier — the knob sits above the page it's dragging across. */
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
    transition: transform 0.12s ease;
  }

  .knob:focus-visible {
    outline: none;
  }

  .knob:focus-visible::before {
    box-shadow:
      0 1px 3px rgba(0, 0, 0, 0.25),
      0 0 0 3px rgba(0, 102, 204, 0.28);
  }

  .active .knob::before,
  .knob:active::before {
    transform: scale(1.25);
  }

  .active .knob {
    cursor: grabbing;
  }

  /* The knobs sit just off the ends of the passage — start above the first
     line, end below the last — so neither covers the words it brackets. Each
     target reaches 6px into the line and 24px away from it. */
  .start .knob {
    bottom: calc(100% - 6px);
  }

  .end .knob {
    top: calc(100% - 6px);
  }

  @media (prefers-reduced-motion: reduce) {
    .knob::before {
      transition: none;
    }
  }
</style>
