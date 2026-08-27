export interface TextPoint {
  node: Text;
  offset: number;
}

export type RangeMeasurer = (range: Range) => DOMRect;

const defaultMeasure: RangeMeasurer = (range) => range.getBoundingClientRect();

function intersects(a: DOMRect, b: DOMRect): boolean {
  return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
}

function textNodes(root: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.textContent?.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  return nodes;
}

function characterRect(node: Text, offset: number, measure: RangeMeasurer): DOMRect {
  const range = document.createRange();
  range.setStart(node, offset);
  range.setEnd(node, Math.min(offset + 1, node.length));
  return measure(range);
}

function nodeRect(node: Text, measure: RangeMeasurer): DOMRect {
  const range = document.createRange();
  range.selectNodeContents(node);
  return measure(range);
}

/**
 * The viewport window the reader ends up looking at once a page turn's transform
 * transition has settled — expressed in the *current* client-rect frame, so it
 * can be compared against rects measured right now.
 *
 * A committed turn animates `.paged-content` for ~340ms, so every live rect
 * (the content's and every character's) is mid-flight. Rather than waiting the
 * animation out, we ask where the viewport will sit *relative to the content*:
 * at rest the content's origin is the viewport's left edge minus the page
 * offset, so the settled window starts at `content.left + page * pageStride` in
 * whatever frame the content is currently drawn in. At rest this is exactly the
 * live viewport rect.
 */
export function settledViewportRect(
  viewport: DOMRect,
  content: DOMRect,
  page: number,
  pageStride: number
): DOMRect {
  if (!(pageStride > 0)) return viewport;
  return new DOMRect(
    content.left + page * pageStride,
    viewport.top,
    viewport.width,
    viewport.height
  );
}

export function selectionFocusRect(
  selection: Selection,
  measure: RangeMeasurer = defaultMeasure
): DOMRect | null {
  const node = selection.focusNode;
  if (!node) return null;
  const range = document.createRange();
  try {
    range.setStart(node, selection.focusOffset);
    range.collapse(true);
    let rect = measure(range);
    if (!rect.width && !rect.height && node.nodeType === Node.TEXT_NODE) {
      const text = node as Text;
      const offset = Math.max(0, Math.min(selection.focusOffset - 1, text.length - 1));
      rect = characterRect(text, offset, measure);
    }
    return rect;
  } catch {
    return null;
  }
}

function visibleTextPoint(
  root: HTMLElement,
  viewport: DOMRect,
  fromEnd: boolean,
  measure: RangeMeasurer
): TextPoint | null {
  const nodes = textNodes(root);
  if (fromEnd) nodes.reverse();
  for (const node of nodes) {
    // Reject whole nodes with a single measurement first. In a paginated flow
    // all but a handful of the article's text nodes sit pages away, and binary
    // searching each of them costs a forced layout per probe — this runs on the
    // page-turn frame, so the scan has to stay cheap.
    if (!intersects(nodeRect(node, measure), viewport)) continue;
    let low = 0;
    let high = node.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const rect = characterRect(node, mid, measure);
      if (intersects(rect, viewport)) {
        found = mid;
        if (fromEnd) low = mid + 1;
        else high = mid - 1;
      } else if (rect.right <= viewport.left || rect.bottom <= viewport.top) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    // Put the focus strictly inside the visible page in both directions. A
    // forward point at `found` sits before the first visible character; when
    // that character begins a new column Chromium resolves the zero-width
    // caret to the preceding page, leaving the native selection handle stuck
    // off-screen. The position after the character is unambiguously on the
    // page the reader just turned to.
    if (found >= 0) return { node, offset: found + 1 };
  }
  return null;
}

export function firstVisibleTextPoint(
  root: HTMLElement,
  viewport: DOMRect,
  measure: RangeMeasurer = defaultMeasure
): TextPoint | null {
  return visibleTextPoint(root, viewport, false, measure);
}

export function lastVisibleTextPoint(
  root: HTMLElement,
  viewport: DOMRect,
  measure: RangeMeasurer = defaultMeasure
): TextPoint | null {
  return visibleTextPoint(root, viewport, true, measure);
}

export function visibleClientRect(rects: Iterable<DOMRect>, viewport: DOMRect): DOMRect | null {
  const visible = Array.from(rects).filter((rect) => intersects(rect, viewport));
  return visible.at(-1) ?? null;
}
