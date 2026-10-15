/**
 * Paged mode never scrolls, so the browser's own lazy loading can't tell which
 * pictures are near: every page but the current one is translated out of a
 * clipped viewport. Loading them all up front works, but a long book with
 * pictures pulls every one of them the moment it opens.
 *
 * Instead the paginator loads pictures in reading order, up to a couple of pages
 * past the one being read. Everything before the reader stays loaded, so a
 * picture arriving never moves the text under them — only pages still ahead
 * reflow, and a jump forward (a link, a restored position) is pinned to its
 * element through the reflow anyway.
 */

/** Pages past the current one whose pictures load before they're reached. */
export const IMAGES_AHEAD_PAGES = 2;

/**
 * Let the browser fetch every picture from `from` onward that starts on or
 * before `lastPage`, in document order (so in page order: a later picture never
 * sits on an earlier page). Returns the index of the first picture still held
 * back, which is where the next call starts.
 */
export function loadImagesThrough(
  images: readonly HTMLImageElement[],
  from: number,
  lastPage: number,
  pageOf: (img: HTMLImageElement) => number
): number {
  let i = from;
  while (i < images.length && pageOf(images[i]) <= lastPage) {
    if (images[i].loading === 'lazy') images[i].loading = 'eager';
    i++;
  }
  return i;
}
