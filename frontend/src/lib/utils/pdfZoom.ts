/**
 * The Original view of a saved PDF opens at the zoom it was last read at. A
 * per-device convenience, so it lives in localStorage, as one small map from
 * the PDF's key to its zoom (1 = fit the column's width, which isn't stored).
 */

const KEY = 'skyreader-pdf-zoom';
// Enough to cover a library's worth of PDFs without the map growing forever:
// past this, the PDFs zoomed longest ago are forgotten (and open fitted).
const MAX_PDFS = 200;

type Zooms = Record<string, number>;

function readZooms(): Zooms {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const zooms: Zooms = {};
    for (const [pdf, zoom] of Object.entries(parsed)) {
      if (typeof zoom === 'number' && Number.isFinite(zoom) && zoom > 0) zooms[pdf] = zoom;
    }
    return zooms;
  } catch {
    return {};
  }
}

/** The zoom a PDF opens at: the one it was left at, else 1 (fit width). */
export function pdfZoom(pdf: string): number {
  return readZooms()[pdf] ?? 1;
}

/** Remember the zoom one PDF was left at. */
export function setPdfZoom(pdf: string, zoom: number): void {
  const zooms = readZooms();
  // Re-inserted last, so the oldest zooms are the first keys when trimming.
  delete zooms[pdf];
  // Fit width is the default, so it needs no entry.
  if (zoom !== 1) zooms[pdf] = zoom;
  const pdfs = Object.keys(zooms);
  for (const old of pdfs.slice(0, Math.max(0, pdfs.length - MAX_PDFS))) delete zooms[old];
  try {
    localStorage.setItem(KEY, JSON.stringify(zooms));
  } catch {
    // Private mode or storage full: the zoom lasts while the PDF is open.
  }
}

/** Zoom controls for the PDF open in the Original view. */
export interface PdfZoomControls {
  step(direction: 1 | -1): void;
  reset(): void;
}

let openPdf: PdfZoomControls | null = null;

/**
 * While a PDF is open, the font-size shortcuts (Shift +, Shift -, Shift 0) zoom
 * it instead, since its pages have no font size to change. Returns a release.
 */
export function claimPdfZoomShortcuts(controls: PdfZoomControls): () => void {
  openPdf = controls;
  return () => {
    if (openPdf === controls) openPdf = null;
  };
}

/** The open PDF's zoom controls, if one is open. */
export function openPdfZoom(): PdfZoomControls | null {
  return openPdf;
}
