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
}

/** The label's props: the place, and when it was left there (merge order). */
export interface PdfPlaceProps extends PdfPlace {
  lastReadAt?: number;
}

export function isPdfPlace(value: unknown): value is PdfPlaceProps {
  if (!value || typeof value !== 'object') return false;
  const { page, at } = value as Record<string, unknown>;
  return (
    typeof page === 'number' &&
    Number.isInteger(page) &&
    page >= 1 &&
    typeof at === 'number' &&
    at >= 0 &&
    at <= 1
  );
}
