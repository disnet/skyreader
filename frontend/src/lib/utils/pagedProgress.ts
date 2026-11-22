/**
 * The index of the last element that starts on or before `page`, or 0 when
 * none does. `elements` are in document order, so their pages never decrease
 * and a binary search finds it in O(log n) rect reads — a long book has
 * thousands of paragraphs, and measuring every one on each page turn made
 * turning visibly slow.
 */
export function lastIndexOnOrBefore<T>(
  elements: readonly T[],
  page: number,
  pageOf: (el: T) => number
): number {
  let lo = 0;
  let hi = elements.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pageOf(elements[mid]) <= page) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * Whether a cached paragraph list still belongs to the page: non-empty, and
 * every element still in the document. A body drawn again, or one block in it
 * replaced (a rendered equation, an embed), leaves elements detached, and a
 * detached element measures as roughly the page on screen, so it can win a
 * search and save a place far ahead. Reading `isConnected` costs no layout.
 */
export function stillLaidOut(elements: readonly Element[]): boolean {
  return elements.length > 0 && elements.every((el) => el.isConnected);
}
