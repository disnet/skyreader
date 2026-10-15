/**
 * Where a PDF link annotation goes, read from the data PDF.js's
 * `page.getAnnotations()` returns. Pure apart from the two lookups a document
 * answers (a named destination, a page reference's index), so it tests
 * without PDF.js.
 *
 * Internal links carry a destination: an array `[page, {name: kind}, ...args]`
 * (an "explicit" one), or a name to look up first. `page` is a reference to a
 * page object, or (in some writers' output) its 0-based index. The kind says
 * what to show: `XYZ left top zoom` a point, `FitH`/`FitBH top` a line, `FitR
 * left bottom right top` a box, and `Fit`/`FitB`/`FitV` the whole page. Named
 * actions (`NextPage`, ...) move relative to the page the link is on.
 */

export type PdfLinkTarget =
  /** `page` is 0-based; `top` is in PDF user space (y up), null for the page's top. */
  { kind: 'page'; page: number; top: number | null } | { kind: 'url'; href: string };

/** The parts of a `PDFDocumentProxy` a link resolves against. */
export interface PdfLinkDoc {
  numPages: number;
  getDestination(name: string): Promise<unknown[] | null>;
  getPageIndex(ref: { num: number; gen: number }): Promise<number>;
}

/** A link annotation's data, as `getAnnotations()` has it (only what's read here). */
export interface PdfLinkAnnotation {
  subtype?: string;
  rect?: number[];
  url?: string;
  dest?: unknown;
  action?: string;
}

// Web and mail links only: a PDF can carry `javascript:`, `file:` or a launch
// action, none of which a reader should be one tap from.
export function pdfLinkHref(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const { protocol } = new URL(url);
    if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') return url;
  } catch {
    /* relative or malformed: nothing to resolve it against */
  }
  return null;
}

const isRef = (v: unknown): v is { num: number; gen: number } =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as { num?: unknown }).num === 'number' &&
  typeof (v as { gen?: unknown }).gen === 'number';

const num = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null);

/** The y an explicit destination scrolls to, by its kind; null means the page's top. */
export function destinationTop(dest: unknown[]): number | null {
  const kind = (dest[1] as { name?: unknown } | undefined)?.name;
  switch (kind) {
    case 'XYZ':
      return num(dest[3]);
    case 'FitH':
    case 'FitBH':
      return num(dest[2]);
    case 'FitR':
      return num(dest[5]);
    default:
      return null;
  }
}

async function resolveDestination(doc: PdfLinkDoc, dest: unknown): Promise<PdfLinkTarget | null> {
  let explicit = dest;
  if (typeof dest === 'string') explicit = await doc.getDestination(dest);
  if (!Array.isArray(explicit) || explicit.length < 1) return null;
  const [ref] = explicit;
  let page: number | null = null;
  if (isRef(ref)) page = await doc.getPageIndex(ref);
  else if (Number.isInteger(ref)) page = ref as number;
  if (page === null || page < 0 || page >= doc.numPages) return null;
  return { kind: 'page', page, top: destinationTop(explicit) };
}

/** Where a link annotation on page `fromPage` (0-based) goes, or null for nowhere we follow. */
export async function resolvePdfLink(
  doc: PdfLinkDoc,
  annotation: PdfLinkAnnotation,
  fromPage: number
): Promise<PdfLinkTarget | null> {
  if (annotation.subtype !== 'Link') return null;
  const href = pdfLinkHref(annotation.url);
  if (href) return { kind: 'url', href };
  if (annotation.dest != null) {
    try {
      return await resolveDestination(doc, annotation.dest);
    } catch {
      // A dangling reference or a broken name tree: the link just doesn't go.
      return null;
    }
  }
  const page =
    annotation.action === 'NextPage'
      ? fromPage + 1
      : annotation.action === 'PrevPage'
        ? fromPage - 1
        : annotation.action === 'FirstPage'
          ? 0
          : annotation.action === 'LastPage'
            ? doc.numPages - 1
            : null;
  if (page === null || page < 0 || page >= doc.numPages) return null;
  return { kind: 'page', page, top: null };
}
