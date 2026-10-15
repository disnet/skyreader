/**
 * The Original view of a saved PDF opens where it was last read. A per-device
 * convenience, like the zoom (see `pdfZoom.ts`), so it lives in localStorage as
 * one small map from the PDF's key to its place: the page in the middle of the
 * view, and how far down that page the middle sits (0-1). Kept relative to the
 * page, not as a scroll offset, so it holds at any zoom or window width. The
 * top of the first page is the default, so it isn't stored.
 */

const KEY = 'skyreader-pdf-place';
// As for zooms: past this, the PDFs read longest ago are forgotten (and open at the top).
const MAX_PDFS = 200;

export interface PdfPlace {
  /** 1-based page number. */
  page: number;
  /** How far down that page, 0 (its top) to 1 (its bottom). */
  at: number;
}

type Places = Record<string, PdfPlace>;

function isPlace(value: unknown): value is PdfPlace {
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

function readPlaces(): Places {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const places: Places = {};
    for (const [pdf, place] of Object.entries(parsed)) {
      if (isPlace(place)) places[pdf] = { page: place.page, at: place.at };
    }
    return places;
  } catch {
    return {};
  }
}

/** Where a PDF was left, or null to open at its top. */
export function pdfPlace(pdf: string): PdfPlace | null {
  return readPlaces()[pdf] ?? null;
}

/** Remember where one PDF was left. */
export function setPdfPlace(pdf: string, place: PdfPlace): void {
  if (!isPlace(place)) return;
  const places = readPlaces();
  // Re-inserted last, so the oldest places are the first keys when trimming.
  delete places[pdf];
  // The top of the first page is where a PDF opens anyway.
  if (place.page > 1 || place.at > 0) {
    places[pdf] = { page: place.page, at: Math.round(place.at * 1000) / 1000 };
  }
  const pdfs = Object.keys(places);
  for (const old of pdfs.slice(0, Math.max(0, pdfs.length - MAX_PDFS))) delete places[old];
  try {
    localStorage.setItem(KEY, JSON.stringify(places));
  } catch {
    // Private mode or storage full: the place lasts while the PDF is open.
  }
}
