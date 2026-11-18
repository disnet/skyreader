import { MARGINALIA_ATTR, articleTextWalker } from '$lib/utils/textSelector';

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

// A step's paragraph: those blocks, and the others prose turns up in (a table
// cell, a caption, a definition, a bare div), so that text outside a <p> grows
// to its own box rather than to the whole article.
const STEP_BLOCKS = `${BLOCK_SELECTORS}, figcaption, td, th, dt, dd, div`;

interface TextIndex {
  text: string;
  nodes: Array<{ node: Text; start: number; end: number }>;
}

const MARGINALIA_SELECTOR = `[${MARGINALIA_ATTR}]`;

/**
 * The article text of `root` (marginalia left out), with where each text node
 * sits in it. A <br> reads as a line break, so the words either side of it stay
 * two words and a line of verse can end a sentence.
 */
function indexText(root: Node): TextIndex {
  const nodes: TextIndex['nodes'] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) =>
      (node instanceof Element ? node : node.parentElement)?.closest(MARGINALIA_SELECTOR)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  let text = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType !== Node.TEXT_NODE) {
      if ((node as Element).tagName === 'BR') text += '\n';
      continue;
    }
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

/**
 * The DOM point at `offset`. A start sits in the first node with text at or
 * after it; an end, in the last node with text before it (so neither lands on
 * the far side of a <br> or an empty node).
 */
function pointAt(index: TextIndex, offset: number, edge: 'start' | 'end'): [Text, number] | null {
  if (edge === 'start') {
    const entry = index.nodes.find((n) => n.end > offset);
    return entry ? [entry.node, Math.max(0, offset - entry.start)] : null;
  }
  const entry = index.nodes.findLast((n) => n.start < offset);
  return entry ? [entry.node, Math.min(entry.end, offset) - entry.start] : null;
}

/**
 * Pull a range's ends onto the article text they bound. A triple-click, or a
 * drag that stops on the edge of the next paragraph, ends at the very start of
 * that paragraph (and one begun past a paragraph's last letter starts at its
 * very end): read as written, a step would grow into a paragraph the reader
 * never touched.
 */
function tighten(origin: Range, root: HTMLElement): [Node, number, Node, number] {
  let start: [Node, number] = [origin.startContainer, origin.startOffset];
  let end: [Node, number] = [origin.endContainer, origin.endOffset];
  const startInText =
    start[0].nodeType === Node.TEXT_NODE && start[1] < (start[0].textContent?.length ?? 0);
  const endInText = end[0].nodeType === Node.TEXT_NODE && end[1] > 0;
  if (startInText && endInText) return [...start, ...end];

  const texts: Text[] = [];
  const walker = articleTextWalker(root);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent) texts.push(node as Text);
  }
  const point = document.createRange();
  if (!startInText) {
    point.setStart(...start);
    // The first text that begins after the point (a start at a node's very end
    // belongs to the next one).
    const next = texts.find(
      (t) => t !== start[0] && point.comparePoint(t, 0) >= 0 && origin.comparePoint(t, 0) <= 0
    );
    if (next) start = [next, 0];
  }
  if (!endInText) {
    point.setStart(...end);
    const prev = texts.findLast(
      (t) =>
        t !== end[0] &&
        point.comparePoint(t, t.length) <= 0 &&
        origin.comparePoint(t, t.length) >= 0
    );
    if (prev) end = [prev, prev.length];
  }
  return [...start, ...end];
}

/** The block (paragraph, heading, list item…) a boundary falls in, kept inside `root`. */
function blockOf(container: Node, offset: number, root: HTMLElement): HTMLElement {
  let node: Node | null = container;
  if (container.nodeType !== Node.TEXT_NODE) node = container.childNodes[offset] ?? container;
  const el = node instanceof Element ? node : node?.parentElement;
  const block = el?.closest(STEP_BLOCKS) as HTMLElement | null;
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

let segmenter: { lang: string | undefined; instance: Intl.Segmenter } | null = null;

function sentenceSegmenter(): Intl.Segmenter | null {
  if (typeof Intl === 'undefined' || !('Segmenter' in Intl)) return null;
  const lang =
    typeof document !== 'undefined' ? document.documentElement.lang || undefined : undefined;
  if (!segmenter || segmenter.lang !== lang) {
    segmenter = { lang, instance: new Intl.Segmenter(lang, { granularity: 'sentence' }) };
  }
  return segmenter.instance;
}

/** The `[start, end)` sentences of `text`. */
export function sentenceBounds(text: string): Array<[number, number]> {
  const bounds: Array<[number, number]> = [];
  const segmenter = sentenceSegmenter();
  if (segmenter) {
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

/** The sentence holding the character at `offset` (the last one, past the end). */
function sentenceAround(bounds: Array<[number, number]>, offset: number): [number, number] {
  for (const [s, e] of bounds) {
    if (offset >= s && offset < e) return [s, e];
  }
  return bounds[bounds.length - 1] ?? [0, 0];
}

/**
 * `origin` grown to `unit`: its words made whole (`word`), the sentences it
 * touches, or the paragraphs it touches. Never reaches outside `root`.
 * Returns null when the selection has no article text to grow from.
 */
export function expandRange(origin: Range, unit: SelectionUnit, root: HTMLElement): Range | null {
  const [startNode, startOffset, endNode, endOffset] = tighten(origin, root);
  const startBlock = blockOf(startNode, startOffset, root);
  const endBlock = blockOf(endNode, endOffset, root);
  const startIndex = indexText(startBlock);
  const endIndex = endBlock === startBlock ? startIndex : indexText(endBlock);

  let s = offsetOf(startIndex, startNode, startOffset);
  let e = offsetOf(endIndex, endNode, endOffset);
  const sameBlock = startBlock === endBlock;

  if (unit === 'word') {
    s = snapStart(startIndex.text, s, sameBlock ? e : startIndex.text.length);
    e = snapEnd(endIndex.text, sameBlock ? s : 0, e);
  } else if (unit === 'sentence') {
    // The sentence holding the selection's first character, and the one
    // holding its last.
    const startBounds = sentenceBounds(startIndex.text);
    const endBounds = sameBlock ? startBounds : sentenceBounds(endIndex.text);
    const first = sentenceAround(
      startBounds,
      trimStart(startIndex.text, s, startIndex.text.length)
    );
    const last = sentenceAround(endBounds, Math.max(0, trimEnd(endIndex.text, e, 0) - 1));
    s = trimStart(startIndex.text, first[0], first[1]);
    e = trimEnd(endIndex.text, last[1], last[0]);
  } else {
    s = trimStart(startIndex.text, 0, startIndex.text.length);
    e = trimEnd(endIndex.text, endIndex.text.length, 0);
  }

  if (sameBlock && e <= s) return null;
  // A boundary with no text on its side of it (a drag begun past the end of
  // one paragraph) stays where the reader put it.
  const startPoint: [Node, number] = pointAt(startIndex, s, 'start') ?? [startNode, startOffset];
  const endPoint: [Node, number] = pointAt(endIndex, e, 'end') ?? [endNode, endOffset];
  const range = document.createRange();
  range.setStart(...startPoint);
  range.setEnd(...endPoint);
  return range.collapsed ? null : range;
}
