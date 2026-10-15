/**
 * The reader's table of contents, read off the rendered article.
 *
 * Two sources, best first:
 *
 * - **Marked entries.** A saved PDF or EPUB carries its own table of contents
 *   (the PDF's outline, the book's nav or NCX), which the pdf-extractor and the
 *   backend's EPUB conversion turn into `data-toc-title` / `data-toc-level` on
 *   the element each entry lands on (an empty marker where it lands on no
 *   element). The author's TOC beats anything inferred, so when any are present
 *   they are the whole TOC. Only honoured for content Skyreader converted itself
 *   (`markers`): a web page's own `data-toc-*` means nothing to us.
 * - **Headings.** Otherwise the article's h1–h6, ranked by the levels actually
 *   used (an article that starts at h2 gets h2 as its top level), three deep.
 *
 * Entries hold the element itself, not an id: nothing in the article is
 * mutated, and a jump goes through `scrollIntoView` or the paged view's
 * `goToElement`, both of which take an element.
 */

export interface TocEntry {
  title: string;
  /** 1 is the top level. */
  level: number;
  el: HTMLElement;
}

export const TOC_MAX_LEVEL = 3;
const MAX_TITLE = 200;

// Headings inside these are part of a quote, an embed or a figure, not the
// article's structure.
const NOT_STRUCTURE = 'blockquote, aside, figure, table, nav, li, details, header, footer';

export function tocText(raw: string | null | undefined): string {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim();
  return text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE - 1).trimEnd()}…` : text;
}

function markedEntries(root: ParentNode): TocEntry[] {
  const entries: TocEntry[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('[data-toc-title]')) {
    const title = tocText(el.getAttribute('data-toc-title'));
    if (!title) continue;
    const raw = parseInt(el.getAttribute('data-toc-level') ?? '', 10);
    const level = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), TOC_MAX_LEVEL) : 1;
    entries.push({ title, level, el });
  }
  return entries;
}

function headingEntries(root: ParentNode, articleTitle?: string): TocEntry[] {
  const found: { title: string; tag: number; el: HTMLElement }[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')) {
    if (el.parentElement?.closest(NOT_STRUCTURE)) continue;
    const title = tocText(el.textContent);
    if (!title) continue;
    found.push({ title, tag: Number(el.tagName[1]), el });
  }
  // A body that repeats the title as its first heading: the reader already
  // shows the title above it.
  if (articleTitle && found.length && found[0].title === tocText(articleTitle)) found.shift();
  const ranks = [...new Set(found.map((h) => h.tag))].sort((a, b) => a - b);
  return found
    .map(({ title, tag, el }) => ({ title, level: ranks.indexOf(tag) + 1, el }))
    .filter((e) => e.level <= TOC_MAX_LEVEL);
}

export function buildReaderToc(
  root: ParentNode,
  opts: { markers?: boolean; articleTitle?: string } = {}
): TocEntry[] {
  if (opts.markers) {
    const marked = markedEntries(root);
    if (marked.length) return marked;
  }
  return headingEntries(root, opts.articleTitle);
}

/**
 * The entry the reader is in: the last one already reached, by `reached`
 * (entries are in reading order). -1 before the first.
 */
export function currentTocIndex<T>(entries: readonly T[], reached: (entry: T) => boolean): number {
  let current = -1;
  for (let i = 0; i < entries.length; i++) {
    if (!reached(entries[i])) break;
    current = i;
  }
  return current;
}
