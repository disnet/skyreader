import type { TextQuoteSelector } from '$lib/types';

const MAX_CONTEXT_LENGTH = 150;
export const MAX_EXACT_LENGTH = 5000;

/**
 * Whether a passage is longer than a selector can carry. `createSelector` keeps
 * the first `MAX_EXACT_LENGTH` characters and computes the suffix around that
 * cut, so an over-long passage yields a *valid* selector for a shorter quote:
 * the reader would get back less text than they selected, with nothing to say
 * so. Callers ask first and refuse the highlight instead.
 *
 * Paged reading is what makes the cap reachable — a selection can now run
 * across page turns, where a scroll-mode drag rarely got near 5 000 characters.
 */
export function exceedsSelectorLimit(text: string): boolean {
  return text.length > MAX_EXACT_LENGTH;
}

/**
 * Marks a subtree the reader draws *into* the article body (the inline gloss
 * that unfolds a note under its paragraph) as not part of the article. Text
 * under it is invisible to selectors, so a gloss can never shift a quote's
 * offsets, leak into a prefix/suffix, or be matched as a passage itself.
 */
export const MARGINALIA_ATTR = 'data-marginalia';

/** A text-node walker over `container` that skips anything under `[data-marginalia]`. */
export function articleTextWalker(container: Node): TreeWalker {
  return document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(`[${MARGINALIA_ATTR}]`)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
}

/** The article text under `el`: its `textContent` minus any `[data-marginalia]`. */
export function articleText(el: Node): string {
  const walker = articleTextWalker(el);
  let text = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    text += node.textContent ?? '';
  }
  return text;
}

/**
 * Build a map of text nodes and their character offsets within a container.
 * Returns { text: concatenated string, nodes: array of { node, start, end } }
 */
function buildTextMap(container: HTMLElement): {
  text: string;
  nodes: Array<{ node: Text; start: number; end: number }>;
} {
  const nodes: Array<{ node: Text; start: number; end: number }> = [];
  const walker = articleTextWalker(container);
  let offset = 0;

  let current = walker.nextNode();
  while (current) {
    const textNode = current as Text;
    const length = textNode.textContent?.length ?? 0;
    if (length > 0) {
      nodes.push({ node: textNode, start: offset, end: offset + length });
      offset += length;
    }
    current = walker.nextNode();
  }

  const text = nodes.map((n) => n.node.textContent).join('');
  return { text, nodes };
}

/**
 * Create a TextQuoteSelector from a DOM Range within a container element.
 */
export function createSelector(range: Range, container: HTMLElement): TextQuoteSelector {
  const exact = range.toString().slice(0, MAX_EXACT_LENGTH);
  const { text, nodes } = buildTextMap(container);

  // Find the start offset of the selection in the concatenated text
  let startOffset = -1;
  for (const nodeInfo of nodes) {
    if (range.startContainer === nodeInfo.node) {
      startOffset = nodeInfo.start + range.startOffset;
      break;
    }
    // Handle case where startContainer is an element containing the text node
    if (
      range.startContainer.nodeType === Node.ELEMENT_NODE &&
      range.startContainer.contains(nodeInfo.node)
    ) {
      // Find the correct child index
      const children = Array.from(range.startContainer.childNodes);
      let childOffset = 0;
      for (let i = 0; i < range.startOffset; i++) {
        const child = children[i];
        if (child instanceof Element && child.hasAttribute(MARGINALIA_ATTR)) continue;
        childOffset += child.textContent?.length ?? 0;
      }
      startOffset = nodeInfo.start + childOffset;
      break;
    }
  }

  if (startOffset < 0) startOffset = 0;

  // Extract prefix and suffix from the full text
  const prefix = text.slice(Math.max(0, startOffset - MAX_CONTEXT_LENGTH), startOffset);
  const suffix = text.slice(
    startOffset + exact.length,
    startOffset + exact.length + MAX_CONTEXT_LENGTH
  );

  return {
    type: 'TextQuoteSelector',
    exact,
    ...(prefix ? { prefix } : {}),
    ...(suffix ? { suffix } : {}),
  };
}

/**
 * Create a TextQuoteSelector for a block-level element (paragraph, heading, etc.)
 */
export function createSelectorForElement(
  element: HTMLElement,
  container: HTMLElement
): TextQuoteSelector {
  // Read through the text map, not `textContent`/`Range.toString()`, so a gloss
  // unfolded inside or around the element stays out of the quote and context.
  const { text, nodes } = buildTextMap(container);
  const inside = nodes.filter((n) => element.contains(n.node));
  const start = inside[0]?.start ?? 0;
  const end = inside.at(-1)?.end ?? 0;
  const exact = text.slice(start, end).slice(0, MAX_EXACT_LENGTH);
  const prefix = text.slice(Math.max(0, start - MAX_CONTEXT_LENGTH), start);
  const suffix = text.slice(end, end + MAX_CONTEXT_LENGTH);

  return {
    type: 'TextQuoteSelector',
    exact,
    ...(prefix ? { prefix } : {}),
    ...(suffix ? { suffix } : {}),
  };
}

/**
 * Find text matching a TextQuoteSelector in a container and return a Range.
 * Uses prefix/suffix for disambiguation when there are multiple matches.
 */
export function findTextInDOM(selector: TextQuoteSelector, container: HTMLElement): Range | null {
  const { text, nodes } = buildTextMap(container);
  return findInTextMap(selector, text, nodes);
}

export function findAllInDOM(
  selectors: TextQuoteSelector[],
  container: HTMLElement
): Array<Range | null> {
  const { text, nodes } = buildTextMap(container);
  return selectors.map((selector) => findInTextMap(selector, text, nodes));
}

function findInTextMap(
  selector: TextQuoteSelector,
  text: string,
  nodes: Array<{ node: Text; start: number; end: number }>
): Range | null {
  if (nodes.length === 0 || !selector.exact) return null;

  const exact = locate(text, selector.exact, selector.prefix, selector.suffix);
  if (exact !== null) return offsetToRange(exact, exact + selector.exact.length, nodes);

  return findIgnoringWhitespace(selector, text, nodes);
}

/**
 * Second pass for a quote whose whitespace no longer matches the document's.
 *
 * A stored `exact` is a verbatim copy of what the DOM read at highlight time, so
 * it pins the highlight to that rendering. Re-render the same body with different
 * block structure and the characters between words change — a plaintext document
 * that used to be one text node with newlines in it now renders as paragraphs and
 * `<br>`s, which contribute no text at all — and `indexOf` finds nothing. The
 * highlight then disappears with no way back.
 *
 * So retry matching on the non-whitespace characters alone and map the hit back to
 * real offsets. Dropping whitespace rather than collapsing it is what covers the
 * `<br>` case, where a newline became nothing at all rather than a space. This only
 * runs once an exact match has already failed, and prefix/suffix still disambiguate
 * repeats, so the looser match costs nothing when the document is unchanged.
 */
function findIgnoringWhitespace(
  selector: TextQuoteSelector,
  text: string,
  nodes: Array<{ node: Text; start: number; end: number }>
): Range | null {
  const needle = stripWhitespace(selector.exact).text;
  if (!needle) return null;

  const { text: bare, offsets } = stripWhitespace(text);
  const hit = locate(
    bare,
    needle,
    selector.prefix ? stripWhitespace(selector.prefix).text : undefined,
    selector.suffix ? stripWhitespace(selector.suffix).text : undefined
  );
  if (hit === null) return null;

  // `offsets` maps each surviving character back to where it sat in `text`; the
  // match runs to just past the last one it covers.
  return offsetToRange(offsets[hit], offsets[hit + needle.length - 1] + 1, nodes);
}

/**
 * The offset of the best match for `needle` in `haystack`, using prefix/suffix
 * context to choose between repeats. Null when the needle doesn't occur.
 */
function locate(
  haystack: string,
  needle: string,
  prefix: string | undefined,
  suffix: string | undefined
): number | null {
  // Find all matches of the exact text
  const matches: number[] = [];
  let searchFrom = 0;
  while (searchFrom < haystack.length) {
    const idx = haystack.indexOf(needle, searchFrom);
    if (idx < 0) break;
    matches.push(idx);
    searchFrom = idx + 1;
  }

  if (matches.length === 0) return null;

  // Score each match based on prefix/suffix context
  let bestMatch = matches[0];
  if (matches.length > 1 && (prefix || suffix)) {
    let bestScore = -1;
    for (const matchIdx of matches) {
      let score = 0;
      if (prefix) {
        const actualPrefix = haystack.slice(Math.max(0, matchIdx - prefix.length), matchIdx);
        score += commonSuffixLength(prefix, actualPrefix);
      }
      if (suffix) {
        const actualSuffix = haystack.slice(
          matchIdx + needle.length,
          matchIdx + needle.length + suffix.length
        );
        score += commonPrefixLength(suffix, actualSuffix);
      }
      if (score > bestScore) {
        bestScore = score;
        bestMatch = matchIdx;
      }
    }
  }

  return bestMatch;
}

/**
 * The string's non-whitespace characters, plus the index each one came from — the
 * offsets are what turn a match in stripped space back into a range over the real
 * text nodes.
 */
function stripWhitespace(text: string): { text: string; offsets: number[] } {
  let bare = '';
  const offsets: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (/\s/.test(char)) continue;
    bare += char;
    offsets.push(i);
  }
  return { text: bare, offsets };
}

/** Find how many chars match at the end of two strings */
function commonSuffixLength(a: string, b: string): number {
  let count = 0;
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i++) {
    if (a[a.length - 1 - i] === b[b.length - 1 - i]) count++;
    else break;
  }
  return count;
}

/** Find how many chars match at the start of two strings */
function commonPrefixLength(a: string, b: string): number {
  let count = 0;
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i++) {
    if (a[i] === b[i]) count++;
    else break;
  }
  return count;
}

/** Convert character offsets in the concatenated text to a DOM Range */
function offsetToRange(
  start: number,
  end: number,
  nodes: Array<{ node: Text; start: number; end: number }>
): Range | null {
  const range = document.createRange();
  let foundStart = false;
  let foundEnd = false;

  for (const nodeInfo of nodes) {
    if (!foundStart && start >= nodeInfo.start && start < nodeInfo.end) {
      range.setStart(nodeInfo.node, start - nodeInfo.start);
      foundStart = true;
    }
    if (!foundEnd && end > nodeInfo.start && end <= nodeInfo.end) {
      range.setEnd(nodeInfo.node, end - nodeInfo.start);
      foundEnd = true;
      break;
    }
  }

  // If end is exactly at the last node boundary
  if (foundStart && !foundEnd && nodes.length > 0) {
    const lastNode = nodes[nodes.length - 1];
    range.setEnd(lastNode.node, lastNode.node.textContent?.length ?? 0);
  }

  return foundStart ? range : null;
}
