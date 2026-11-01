/** The elements the reader steps through, highlights by paragraph and files
 *  reading position against. */
export const READING_BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, blockquote, pre, figure, li';
const MIN_TEXT_LENGTH = 20;

/**
 * The article's reading blocks, in document order: each block with enough text
 * to read, minus any block that holds another one (a blockquote of paragraphs, a
 * list item with a nested list). Keeping only the innermost means a step never
 * lands on a whole container and then backs up to its first child.
 *
 * Every caller that maps a paragraph index to an element (stepping, `h`, saved
 * and paged position) must use this so the indices agree.
 */
export function readingBlocks(
  container: ParentNode,
  textOf: (el: HTMLElement) => string = (el) => el.textContent ?? ''
): HTMLElement[] {
  const blocks = (
    Array.from(container.querySelectorAll(READING_BLOCK_SELECTOR)) as HTMLElement[]
  ).filter((el) => textOf(el).trim().length >= MIN_TEXT_LENGTH);
  // Document order puts a block's descendants straight after it, so a block
  // holds another kept block exactly when it holds the next one.
  return blocks.filter((el, i) => !(i + 1 < blocks.length && el.contains(blocks[i + 1])));
}
