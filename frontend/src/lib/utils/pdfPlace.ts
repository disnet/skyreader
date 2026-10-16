/**
 * Where a saved PDF's Original view was left: the page in the middle of the
 * view, and how far down that page the middle sits (0-1). Kept relative to the
 * page, not as a scroll offset, so it holds at any zoom or window width, on any
 * device. Synced as the `pdfPlace` item label (see `stores/itemLabels`).
 */
export interface PdfPlace {
  /** 1-based page number. */
  page: number;
  /** How far down that page, 0 (its top) to 1 (its bottom). */
  at: number;
  /**
   * How many pages the PDF has, so the place also says how far through it is.
   * Absent on places saved before it was recorded; those still count as
   * reading activity, just without progress.
   */
  pages?: number;
}

/** The label's props: the place, and when it was left there (merge order). */
export interface PdfPlaceProps extends PdfPlace {
  lastReadAt?: number;
}

export function isPdfPlace(value: unknown): value is PdfPlaceProps {
  if (!value || typeof value !== 'object') return false;
  const { page, at, pages } = value as Record<string, unknown>;
  return (
    typeof page === 'number' &&
    Number.isInteger(page) &&
    page >= 1 &&
    typeof at === 'number' &&
    at >= 0 &&
    at <= 1 &&
    (pages === undefined || (typeof pages === 'number' && Number.isInteger(pages) && pages >= page))
  );
}

/**
 * A place as reading progress, in the `readProgress` shape the "Continue
 * reading" lanes already understand (`utils/shelf.ts`'s `progressFraction`):
 * tenths of a page, so opening page 1 is a sliver of progress and the bottom
 * of the last page is the whole document. Null without a page count.
 */
export function pdfPlaceProgress(
  place: PdfPlace
): { paragraphIndex: number; totalParagraphs: number } | null {
  if (!place.pages) return null;
  const totalParagraphs = place.pages * 10;
  const reached = Math.round((place.page - 1 + place.at) * 10);
  return {
    paragraphIndex: Math.min(totalParagraphs - 1, Math.max(0, reached - 1)),
    totalParagraphs,
  };
}
