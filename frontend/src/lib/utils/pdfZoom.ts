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

/** How far the pages zoom out and in; the buttons step through these stops. */
export const PDF_ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const MIN_ZOOM = PDF_ZOOM_STEPS[0];
const MAX_ZOOM = PDF_ZOOM_STEPS[PDF_ZOOM_STEPS.length - 1];
// A pinch that ends this close to fit width is fit width.
const FIT_SNAP = 0.05;

/** A zoom the pages can take: in range, to the percent, near-fit snapped to fit. */
export function clampPdfZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
  if (Math.abs(clamped - 1) < FIT_SNAP) return 1;
  return Math.round(clamped * 100) / 100;
}

/** The next stop past `zoom` in `direction`, from anywhere a pinch left it. */
export function stepPdfZoom(zoom: number, direction: 1 | -1): number {
  const stops = direction === 1 ? PDF_ZOOM_STEPS : [...PDF_ZOOM_STEPS].reverse();
  return stops.find((stop) => (stop - zoom) * direction > 0.001) ?? stops[stops.length - 1];
}

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
  return clampPdfZoom(readZooms()[pdf] ?? 1);
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
