import type { ReaderViewMode } from '$lib/stores/preferences.svelte';

/**
 * A saved EPUB opens in pages, whatever the reader's scroll/pages preference for
 * articles; switching modes while reading a book is remembered for that book
 * alone. A per-device convenience, so it lives in localStorage, as one small map
 * from the book's key to the mode chosen for it.
 */

const KEY = 'skyreader-epub-view';
// Enough to cover a library's worth of books without the map growing forever:
// past this, the books chosen for longest ago are forgotten (and open paged).
const MAX_BOOKS = 200;

type Choices = Record<string, ReaderViewMode>;

function readChoices(): Choices {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const choices: Choices = {};
    for (const [book, mode] of Object.entries(parsed)) {
      if (mode === 'scroll' || mode === 'paged') choices[book] = mode;
    }
    return choices;
  } catch {
    return {};
  }
}

/** The mode a book opens in: the one chosen for it, else pages. */
export function epubViewMode(book: string): ReaderViewMode {
  return readChoices()[book] ?? 'paged';
}

/** Remember the mode chosen for one book. */
export function setEpubViewMode(book: string, mode: ReaderViewMode): void {
  const choices = readChoices();
  // Re-inserted last, so the oldest choices are the first keys when trimming.
  delete choices[book];
  choices[book] = mode;
  const books = Object.keys(choices);
  for (const old of books.slice(0, Math.max(0, books.length - MAX_BOOKS))) delete choices[old];
  try {
    localStorage.setItem(KEY, JSON.stringify(choices));
  } catch {
    // Private mode or storage full: the choice lasts while the book is open.
  }
}
