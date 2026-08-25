import type { TextQuoteSelector } from '$lib/types';

const MAX_CONTEXT_LENGTH = 150;
const MAX_EXACT_LENGTH = 5000;

/**
 * Build a map of text nodes and their character offsets within a container.
 * Returns { text: concatenated string, nodes: array of { node, start, end } }
 */
function buildTextMap(container: HTMLElement): {
  text: string;
  nodes: Array<{ node: Text; start: number; end: number }>;
} {
  const nodes: Array<{ node: Text; start: number; end: number }> = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
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
  const exact = (element.textContent ?? '').slice(0, MAX_EXACT_LENGTH);
  const { text } = buildTextMap(container);

  // Find the element's text offset in the container
  const beforeRange = document.createRange();
  beforeRange.setStartBefore(container.firstChild || container);
  beforeRange.setEndBefore(element);
  const prefix = beforeRange.toString().slice(-MAX_CONTEXT_LENGTH);

  // Find suffix: text after this element
  const afterRange = document.createRange();
  if (element.nextSibling) {
    afterRange.setStartAfter(element);
  } else {
    afterRange.setStart(element, element.childNodes.length);
  }
  afterRange.setEndAfter(container.lastChild || container);
  const suffix = afterRange.toString().slice(0, MAX_CONTEXT_LENGTH);

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

  // Find all matches of the exact text
  const matches: number[] = [];
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const idx = text.indexOf(selector.exact, searchFrom);
    if (idx < 0) break;
    matches.push(idx);
    searchFrom = idx + 1;
  }

  if (matches.length === 0) return null;

  // Score each match based on prefix/suffix context
  let bestMatch = matches[0];
  if (matches.length > 1 && (selector.prefix || selector.suffix)) {
    let bestScore = -1;
    for (const matchIdx of matches) {
      let score = 0;
      if (selector.prefix) {
        const actualPrefix = text.slice(Math.max(0, matchIdx - selector.prefix.length), matchIdx);
        score += commonSuffixLength(selector.prefix, actualPrefix);
      }
      if (selector.suffix) {
        const actualSuffix = text.slice(
          matchIdx + selector.exact.length,
          matchIdx + selector.exact.length + selector.suffix.length
        );
        score += commonPrefixLength(selector.suffix, actualSuffix);
      }
      if (score > bestScore) {
        bestScore = score;
        bestMatch = matchIdx;
      }
    }
  }

  // Convert the character offset back to a DOM Range
  return offsetToRange(bestMatch, bestMatch + selector.exact.length, nodes);
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
