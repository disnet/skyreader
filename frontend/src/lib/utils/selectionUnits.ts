import { articleTextWalker } from '$lib/utils/textSelector';

/**
 * Selection steps: a live selection grown (or shrunk back) to whole words, its
 * sentence, or its paragraph, so a highlight doesn't depend on a precise drag.
 *
 * Every step is taken from the selection the reader actually made (its
 * "origin"), not from the previous step, so stepping down from Paragraph lands
 * back on what they picked rather than on some sentence of it.
 */
export type SelectionUnit = 'word' | 'sentence' | 'paragraph';

export const SELECTION_UNITS: readonly SelectionUnit[] = ['word', 'sentence', 'paragraph'];

/** What counts as a paragraph: the same blocks double-click highlights whole. */
export const BLOCK_SELECTORS = 'p, h1, h2, h3, h4, h5, h6, blockquote, pre, figure, li';

interface TextIndex {
  text: string;
  nodes: Array<{ node: Text; start: number; end: number }>;
}

/** The article text of `root` (marginalia left out), with where each text node sits in it. */
function indexText(root: Node): TextIndex {
  const nodes: TextIndex['nodes'] = [];
  const walker = articleTextWalker(root);
  let text = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.textContent ?? '';
    if (!value) continue;
    nodes.push({ node: node as Text, start: text.length, end: text.length + value.length });
    text += value;
  }
  return { text, nodes };
}

/** A range boundary as an offset into `index`'s text. */
function offsetOf(index: TextIndex, container: Node, offset: number): number {
  for (const entry of index.nodes) {
    if (entry.node === container) return entry.start + Math.min(offset, entry.end - entry.start);
  }
  // An element boundary (or one in a text node the index skipped): the first
  // indexed text at or after the point.
  const point = document.createRange();
  point.setStart(container, offset);
  for (const entry of index.nodes) {
    if (point.comparePoint(entry.node, 0) >= 0) return entry.start;
  }
  return index.text.length;
}

/** The DOM point at `offset`. A start sits in the node the text begins in; an end, the one it ends in. */
function pointAt(index: TextIndex, offset: number, edge: 'start' | 'end'): [Text, number] | null {
  for (const entry of index.nodes) {
    const inside =
      edge === 'start'
        ? offset >= entry.start && offset < entry.end
        : offset > entry.start && offset <= entry.end;
    if (inside) return [entry.node, offset - entry.start];
  }
  const last = index.nodes[index.nodes.length - 1];
  if (edge === 'end' && last && offset >= last.end) return [last.node, last.end - last.start];
  const first = index.nodes[0];
  if (edge === 'start' && first && offset <= first.start) return [first.node, 0];
  return null;
}

/** The block (paragraph, heading, list item…) a boundary falls in, kept inside `container`. */
function blockOf(container: Node, offset: number, root: HTMLElement): HTMLElement {
  let node: Node | null = container;
  if (container.nodeType !== Node.TEXT_NODE) node = container.childNodes[offset] ?? container;
  const el = node instanceof Element ? node : node?.parentElement;
  const block = el?.closest(BLOCK_SELECTORS) as HTMLElement | null;
  return block && root.contains(block) ? block : root;
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}_'’]/u;
const isWordChar = (ch: string | undefined) => !!ch && WORD_CHAR.test(ch);
const isSpace = (ch: string | undefined) => !!ch && /\s/.test(ch);

/** Move a start back to the beginning of the word it cuts, and past any leading space. */
function snapStart(text: string, start: number, end: number): number {
  let s = start;
  while (s < end && isSpace(text[s])) s++;
  if (isWordChar(text[s]) && isWordChar(text[s - 1])) {
    while (s > 0 && isWordChar(text[s - 1])) s--;
  }
  return s;
}

/** Move an end on to the end of the word it cuts, and back over any trailing space. */
function snapEnd(text: string, start: number, end: number): number {
  let e = end;
  while (e > start && isSpace(text[e - 1])) e--;
  if (isWordChar(text[e - 1]) && isWordChar(text[e])) {
    while (e < text.length && isWordChar(text[e])) e++;
  }
  return e;
}

function trimStart(text: string, s: number, limit: number): number {
  while (s < limit && isSpace(text[s])) s++;
  return s;
}

function trimEnd(text: string, e: number, limit: number): number {
  while (e > limit && isSpace(text[e - 1])) e--;
  return e;
}

/** The `[start, end)` sentences of `text`. */
export function sentenceBounds(text: string): Array<[number, number]> {
  const bounds: Array<[number, number]> = [];
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const lang =
      typeof document !== 'undefined' ? document.documentElement.lang || undefined : undefined;
    const segmenter = new Intl.Segmenter(lang, { granularity: 'sentence' });
    for (const { index, segment } of segmenter.segment(text)) {
      bounds.push([index, index + segment.length]);
    }
    return bounds;
  }
  // No segmenter: end a sentence at terminal punctuation (and any closing
  // quotes or brackets) followed by space.
  const re = /[.!?…]+["'”’)\]]*\s+/g;
  let start = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    bounds.push([start, m.index + m[0].length]);
    start = m.index + m[0].length;
  }
  if (start < text.length) bounds.push([start, text.length]);
  return bounds;
}

function sentenceAround(text: string, offset: number): [number, number] {
  for (const [s, e] of sentenceBounds(text)) {
    if (offset >= s && offset < e) return [s, e];
  }
  return [0, text.length];
}

/**
 * `origin` grown to `unit`: its words made whole (`word`), the sentences it
 * touches, or the paragraphs it touches. Never reaches outside `root`.
 * Returns null when the selection has no article text to grow from.
 */
export function expandRange(origin: Range, unit: SelectionUnit, root: HTMLElement): Range | null {
  const startBlock = blockOf(origin.startContainer, origin.startOffset, root);
  const endBlock = blockOf(origin.endContainer, origin.endOffset, root);
  const startIndex = indexText(startBlock);
  const endIndex = endBlock === startBlock ? startIndex : indexText(endBlock);

  let s = offsetOf(startIndex, origin.startContainer, origin.startOffset);
  let e = offsetOf(endIndex, origin.endContainer, origin.endOffset);
  const sameBlock = startBlock === endBlock;

  if (unit === 'word') {
    s = snapStart(startIndex.text, s, sameBlock ? e : startIndex.text.length);
    e = snapEnd(endIndex.text, sameBlock ? s : 0, e);
  } else if (unit === 'sentence') {
    // The sentence holding the selection's first character, and the one
    // holding its last.
    const first = sentenceAround(
      startIndex.text,
      trimStart(startIndex.text, s, startIndex.text.length)
    );
    const last = sentenceAround(endIndex.text, Math.max(0, trimEnd(endIndex.text, e, 0) - 1));
    s = trimStart(startIndex.text, first[0], first[1]);
    e = trimEnd(endIndex.text, last[1], last[0]);
  } else {
    s = trimStart(startIndex.text, 0, startIndex.text.length);
    e = trimEnd(endIndex.text, endIndex.text.length, 0);
  }

  if (sameBlock && e <= s) return null;
  // A boundary with no text on its side of it (a drag begun past the end of
  // one paragraph) stays where the reader put it.
  const startPoint: [Node, number] = pointAt(startIndex, s, 'start') ?? [
    origin.startContainer,
    origin.startOffset,
  ];
  const endPoint: [Node, number] = pointAt(endIndex, e, 'end') ?? [
    origin.endContainer,
    origin.endOffset,
  ];
  const range = document.createRange();
  range.setStart(...startPoint);
  range.setEnd(...endPoint);
  return range.collapsed ? null : range;
}
