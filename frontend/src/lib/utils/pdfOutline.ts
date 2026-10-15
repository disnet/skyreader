/**
 * A PDF's outline (its bookmarks: the table of contents a PDF viewer shows in
 * its sidebar), flattened for the reader's contents list. Each entry's
 * destination is resolved up front, the way a link's is (`utils/pdfLinks.ts`),
 * so the list can mark the section in view and a tap only has to scroll.
 */
import { resolvePdfLink, type PdfLinkDoc } from './pdfLinks';
import { tocText, TOC_MAX_LEVEL } from './readerToc';

/** An outline node as `PDFDocumentProxy.getOutline()` returns it (only what's read here). */
export interface PdfOutlineNode {
  title?: string;
  dest?: unknown;
  items?: PdfOutlineNode[];
}

export interface PdfOutlineEntry {
  title: string;
  /** 1 is the top level. */
  level: number;
  /** 0-based. */
  page: number;
  /** In PDF user space (y up); null for the page's top. */
  top: number | null;
}

// A generated outline can list every figure; past this it's no longer a TOC.
const MAX_ENTRIES = 1000;

export async function flattenPdfOutline(
  doc: PdfLinkDoc,
  outline: readonly PdfOutlineNode[] | null | undefined
): Promise<PdfOutlineEntry[]> {
  const pending: { title: string; level: number; dest: unknown }[] = [];
  const walk = (nodes: readonly PdfOutlineNode[], level: number) => {
    for (const node of nodes) {
      if (pending.length >= MAX_ENTRIES) return;
      const title = tocText(node.title);
      // A node with no destination (a URL, a JavaScript action) isn't listed,
      // but the nodes under it still are, at their own depth.
      if (title && node.dest != null) pending.push({ title, level, dest: node.dest });
      if (node.items?.length && level < TOC_MAX_LEVEL) walk(node.items, level + 1);
    }
  };
  walk(outline ?? [], 1);
  const resolved = await Promise.all(
    pending.map(async ({ title, level, dest }) => {
      const target = await resolvePdfLink(doc, { subtype: 'Link', dest }, 0);
      return target?.kind === 'page' ? { title, level, page: target.page, top: target.top } : null;
    })
  );
  return resolved.filter((e): e is PdfOutlineEntry => e !== null);
}
