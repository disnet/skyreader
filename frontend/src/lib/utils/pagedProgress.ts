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

/**
 * The paragraphs a page turn measures against, kept per body: a long book has
 * thousands, and finding them inside every turn held the page still. Pictures
 * loading or a reflow move them but don't change which they are. A body drawn
 * again (same text, new elements) finds them afresh, since a removed paragraph
 * measures as roughly the page on screen and would win the search.
 */
export function paragraphCache() {
  let cache: { root: Element; body: string; paras: HTMLElement[] } | null = null;
  return (
    root: Element | null | undefined,
    body: string,
    find: () => HTMLElement[]
  ): HTMLElement[] => {
    if (!root) return [];
    if (cache?.root !== root || cache.body !== body || !stillLaidOut(cache.paras)) {
      cache = { root, body, paras: find() };
    }
    return cache.paras;
  };
}

/**
 * A place write that waits out a short debounce, so a run of page turns writes
 * once, and can be written at once when the reader closes or the page is hidden.
 */
export function debouncedWrite(delayMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: (() => void) | null = null;
  return {
    /** Replaces any write still waiting. */
    schedule(write: () => void) {
      if (timer) clearTimeout(timer);
      pending = () => {
        pending = null;
        timer = undefined;
        write();
      };
      timer = setTimeout(pending, delayMs);
    },
    /** Writes what's waiting now; false when nothing was. */
    flush(): boolean {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (!pending) return false;
      pending();
      return true;
    },
  };
}
