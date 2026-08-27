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
    let low = 0;
    let high = node.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const visible = intersects(characterRect(node, mid, measure), viewport);
      if (visible) {
        found = mid;
        if (fromEnd) low = mid + 1;
        else high = mid - 1;
      } else {
        const rect = characterRect(node, mid, measure);
        if (rect.right <= viewport.left || rect.bottom <= viewport.top) low = mid + 1;
        else high = mid - 1;
      }
    }
    if (found >= 0) return { node, offset: fromEnd ? found + 1 : found };
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
