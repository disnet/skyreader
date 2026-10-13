import { getDocumentProxy } from 'unpdf';

// PDF → reader HTML. A saved PDF is reflowed into ordinary paragraphs so it rides
// the same reader, highlight (TextQuoteSelector), and search paths as an article:
// nothing downstream has to know a PDF was involved beyond `contentType`.
//
// pdf.js hands back positioned text runs, not structure, so the structure here is
// inferred from geometry: runs on one baseline make a line; a vertical gap, a
// first-line indent, a short sentence-final line, or a change of type size ends
// a paragraph; type noticeably larger than the body is a heading. Each page is a
// `<section data-pdf-page="N">`, which keeps the page number recoverable for
// citations and for a later page-faithful viewer.

// Parsing runs inside /extract's budget (see idleTimeout in index.ts): permit
// wait + fetch + this must stay under it. The budget and the caps end the parse
// early and keep what was read rather than failing the save. The budget is only
// checked between pages, so PDF_PARSE_HARD_TIMEOUT_MS backs it: past that, the
// worker running the parse is terminated and the extraction fails as a timeout.
export const PDF_PARSE_BUDGET_MS = 10 * 1000;
export const PDF_PARSE_HARD_TIMEOUT_MS = 15 * 1000;
export const MAX_PDF_PAGES = 300;
// Reflowed HTML is stored inline on the save's D1 row, whose values cap at 2 MB.
// Stop at whole pages well under it; 1M characters is a long book's worth.
export const MAX_PDF_CONTENT_CHARS = 1_000_000;

export interface PdfExtraction {
  title: string | null;
  author: string | null;
  description: string | null;
  content: string | null;
  published: string | null;
  wordCount: number;
  pageCount: number;
  /** Pages in `content`; less than pageCount when a cap cut it short. */
  pagesKept: number;
  /**
   * The time budget, not a page or size cap, cut the parse short. Unlike the
   * caps this depends on how busy the machine was, so the result is not the
   * PDF's answer and must not be cached as one.
   */
  budgetExceeded: boolean;
}

export class PdfPasswordError extends Error {
  constructor() {
    super('This PDF is password-protected');
    this.name = 'PdfPasswordError';
  }
}

/**
 * True when the response is a PDF. A PDF type is trusted; a text type is too,
 * the other way (an article about PDFs can mention `%PDF-` near its top). Only
 * a missing or generic type (octet-stream and friends) is settled by sniffing.
 */
export function isPdf(bytes: Uint8Array, contentType: string | null): boolean {
  if (contentType && /^application\/(x-)?pdf\b/i.test(contentType)) return true;
  if (contentType && /^text\/|html|xml|json/i.test(contentType)) return false;
  // The header may follow a little junk; the spec lets readers look in the first 1 KB.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}

interface Line {
  text: string;
  x: number;
  y: number;
  endX: number;
  size: number;
}

interface Block {
  kind: 'p' | 'h2' | 'h3' | 'h4';
  text: string;
  size: number;
}

interface TextRun {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
}

function isTextRun(item: unknown): item is TextRun {
  return typeof item === 'object' && item !== null && 'str' in item && 'transform' in item;
}

const roundSize = (n: number) => Math.round(n * 2) / 2;

// Group a page's runs into visual lines. pdf.js emits runs in content-stream
// order, which for typeset text (LaTeX two-column included) is reading order.
function linesOf(items: unknown[]): Line[] {
  const lines: Line[] = [];
  let cur: Line | null = null;
  const flush = () => {
    if (cur && cur.text.trim()) {
      cur.text = cur.text.replace(/\s+/g, ' ').trim();
      lines.push(cur);
    }
    cur = null;
  };
  for (const item of items) {
    if (!isTextRun(item)) continue;
    // Rotated text is margin furniture (arXiv's sidebar stamp, a watermark),
    // never the body; left in, it would also win the largest-type title guess.
    // Rotation tilts the baseline (b); a slant alone (c) is a synthetic italic,
    // which is body text and stays.
    const [a, b] = item.transform;
    if (Math.abs(b) > Math.abs(a) * 0.05) {
      if (item.hasEOL) flush();
      continue;
    }
    const x = item.transform[4];
    const y = item.transform[5];
    const size = Math.abs(item.height) || Math.abs(item.transform[3]);
    if (item.str) {
      // A run on another baseline starts a new line even without an EOL mark.
      // Superscripts sit a little above; only a shift of most of a line counts.
      if (cur && Math.abs(y - cur.y) > Math.max(size, cur.size) * 0.6) flush();
      if (!cur) {
        cur = { text: item.str, x, y, endX: x + item.width, size };
      } else {
        const gap = x - cur.endX;
        const needsSpace =
          gap > Math.max(size, cur.size) * 0.15 && !/\s$/.test(cur.text) && !/^\s/.test(item.str);
        cur.text += (needsSpace ? ' ' : '') + item.str;
        cur.endX = Math.max(cur.endX, x + item.width);
        // A superscript marker shouldn't shrink the line's size.
        if (item.str.trim().length > 1 || size > cur.size) cur.size = Math.max(cur.size, size);
      }
    }
    if (item.hasEOL) flush();
  }
  flush();
  return lines;
}

// Running headers/footers and page numbers: a first or last line that recurs
// (digits ignored) across most pages, or a bare page number on any page.
function boilerplateFilter(pages: Line[][]): (line: Line, i: number, page: Line[]) => boolean {
  const norm = (t: string) => t.replace(/\d+/g, '#').toLowerCase();
  const counts = new Map<string, number>();
  for (const page of pages) {
    const edges = new Set(
      [page[0], page[page.length - 1]].filter(Boolean).map((l) => norm(l.text))
    );
    for (const e of edges) counts.set(e, (counts.get(e) ?? 0) + 1);
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.5));
  const pageNumber = /^(page\s*)?[#ivxlc]+(\s*(of|\/)\s*#)?$/i;
  return (line, i, page) => {
    const isEdge = i === 0 || i === page.length - 1;
    if (!isEdge) return true;
    const n = norm(line.text);
    if (pageNumber.test(n) || /^[-–—]\s*#\s*[-–—]$/.test(n)) return false;
    return (counts.get(n) ?? 0) < threshold;
  };
}

// The size most of the text is set in, by character count.
function bodySizeOf(pages: Line[][]): number {
  const weight = new Map<number, number>();
  for (const page of pages)
    for (const l of page)
      weight.set(roundSize(l.size), (weight.get(roundSize(l.size)) ?? 0) + l.text.length);
  let best = 0;
  let bestWeight = -1;
  for (const [size, w] of weight)
    if (w > bestWeight) {
      best = size;
      bestWeight = w;
    }
  return best || 10;
}

function joinLine(text: string, next: string): string {
  // "inter-" + "national" → "international"; keep the hyphen before a capital
  // or digit, where it is far more likely to be real ("Jean-" + "Paul").
  if (/[a-z]-$/.test(text) && /^[a-z]/.test(next)) return text.slice(0, -1) + next;
  return `${text} ${next}`;
}

const SENTENCE_END = /[.?!:;"”’)\]]$/;

function blocksOf(lines: Line[], bodySize: number): Block[] {
  const blocks: Block[] = [];
  let cur: (Block & { last: Line; maxEndX: number; minX: number }) | null = null;
  const kindFor = (size: number, text: string): Block['kind'] => {
    if (text.length > 200) return 'p';
    if (size >= bodySize * 1.5) return 'h2';
    if (size >= bodySize * 1.15) return 'h3';
    return 'p';
  };
  for (const line of lines) {
    if (cur) {
      const prev = cur.last;
      const sizeChanged = Math.abs(line.size - cur.size) > Math.max(line.size, cur.size) * 0.12;
      const drop = prev.y - line.y;
      const lineHeight = Math.max(line.size, prev.size);
      // drop < 0: the text moved up the page — a new column, which continues the flow.
      const gapBreak = drop > lineHeight * 1.75;
      const indentBreak =
        drop > 0 && line.x > cur.minX + lineHeight * 0.8 && line.x - prev.x > lineHeight * 0.8;
      const shortEnd = SENTENCE_END.test(prev.text) && prev.endX < cur.maxEndX - lineHeight * 3;
      const headingEnds = cur.kind !== 'p';
      if (
        sizeChanged ||
        gapBreak ||
        indentBreak ||
        shortEnd ||
        (headingEnds && drop > lineHeight * 1.4)
      ) {
        blocks.push({ kind: cur.kind, text: cur.text, size: cur.size });
        cur = null;
      }
    }
    if (!cur) {
      cur = {
        kind: 'p',
        text: line.text,
        size: line.size,
        last: line,
        maxEndX: line.endX,
        minX: line.x,
      };
    } else {
      // A new column restarts the left edge and line width the indent and
      // short-line tests measure against.
      const newColumn = line.y > cur.last.y;
      cur.text = joinLine(cur.text, line.text);
      cur.minX = newColumn ? line.x : Math.min(cur.minX, line.x);
      cur.maxEndX = newColumn ? line.endX : Math.max(cur.maxEndX, line.endX);
      cur.last = line;
    }
  }
  if (cur) blocks.push({ kind: cur.kind, text: cur.text, size: cur.size });
  return blocks.map((b) => ({ ...b, kind: kindFor(b.size, b.text) }));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// A metadata title that is really a filename or an authoring-tool default.
function usableTitle(t: unknown): string | null {
  if (typeof t !== 'string') return null;
  const s = t.replace(/\s+/g, ' ').trim();
  if (s.length < 4) return null;
  if (/^(untitled|microsoft word\s*-|document\d*$)/i.test(s)) return null;
  if (/\.(pdf|docx?|tex|dvi|indd|pptx?|odt|rtf)$/i.test(s)) return null;
  return s;
}

// PDF date strings: D:YYYYMMDDHHmmSS[Z|±HH'mm'].
export function parsePdfDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = value.match(
    /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(Z|[+-]\d{2}'?\d{2}'?)?/
  );
  if (!m) return null;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00', tz] = m;
  let zone = 'Z';
  if (tz && tz !== 'Z') zone = `${tz.slice(0, 3)}:${tz.slice(3).replace(/'/g, '') || '00'}`;
  const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}${zone}`);
  // Same bounds the article path applies: nothing before 1990 or in the future.
  if (isNaN(ms) || ms < 631152000000 || ms > Date.now() + 86400000) return null;
  return new Date(ms).toISOString();
}

export async function extractPdf(
  bytes: Uint8Array,
  opts: { budgetMs?: number; maxPages?: number; maxChars?: number; now?: () => number } = {}
): Promise<PdfExtraction> {
  const budgetMs = opts.budgetMs ?? PDF_PARSE_BUDGET_MS;
  const maxPages = opts.maxPages ?? MAX_PDF_PAGES;
  const maxChars = opts.maxChars ?? MAX_PDF_CONTENT_CHARS;
  const now = opts.now ?? Date.now;
  const started = now();

  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // pdf.js may detach the buffer it is given; hand it a copy.
    pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  } catch (err) {
    if (err instanceof Error && err.name === 'PasswordException') throw new PdfPasswordError();
    throw err;
  }

  try {
    const meta = await pdf.getMetadata().catch(() => null);
    const info = (meta?.info ?? {}) as Record<string, unknown>;

    const pageCount = pdf.numPages;
    const pageLines: Line[][] = [];
    let budgetExceeded = false;
    for (let n = 1; n <= Math.min(pageCount, maxPages); n++) {
      if (n > 1 && now() - started > budgetMs) {
        budgetExceeded = true;
        break;
      }
      const page = await pdf.getPage(n);
      const text = await page.getTextContent();
      pageLines.push(linesOf(text.items));
      page.cleanup();
    }

    const keep = boilerplateFilter(pageLines);
    const pages = pageLines.map((lines) => lines.filter((l, i) => keep(l, i, lines)));
    const bodySize = bodySizeOf(pages);
    const pageBlocks = pages.map((lines) => blocksOf(lines, bodySize));

    // Heading cleanup that needs the whole document: large type that repeats is
    // figure labelling, not structure; a short numbered line in body type
    // ("3.1 Encoder Stacks") is a subsection a paper set in bold, not larger.
    const headingCounts = new Map<string, number>();
    for (const b of pageBlocks.flat())
      if (b.kind !== 'p') headingCounts.set(b.text, (headingCounts.get(b.text) ?? 0) + 1);
    for (const b of pageBlocks.flat()) {
      if (b.kind !== 'p' && (headingCounts.get(b.text) ?? 0) > 2) b.kind = 'p';
      else if (
        b.kind === 'p' &&
        b.text.length <= 80 &&
        /^\d+(\.\d+)+\.?\s+\p{Lu}/u.test(b.text) &&
        !/[.:,;]$/.test(b.text)
      )
        b.kind = 'h4';
    }

    // A paragraph cut by a page break continues on the next page: fold the
    // continuation back so the sentence isn't split in two.
    for (let i = 1; i < pageBlocks.length; i++) {
      const prevPage = pageBlocks[i - 1];
      const tail = prevPage[prevPage.length - 1];
      const head = pageBlocks[i][0];
      if (
        tail?.kind === 'p' &&
        head?.kind === 'p' &&
        !SENTENCE_END.test(tail.text) &&
        Math.abs(tail.size - head.size) <= Math.max(tail.size, head.size) * 0.12
      ) {
        tail.text = joinLine(tail.text, head.text);
        pageBlocks[i].shift();
      }
    }

    // Title: the metadata's when it is real, else the largest type on page one.
    let title = usableTitle(info.Title);
    if (!title && pageBlocks[0]?.length) {
      // A block longer than a title could be is a paragraph, however large its type.
      const candidates = pageBlocks[0].filter((b) => b.text.length <= 300);
      const largest = candidates.reduce<Block | null>(
        (a, b) => (!a || b.size > a.size ? b : a),
        null
      );
      if (largest && largest.size > bodySize * 1.15 && largest.text.length >= 4)
        title = largest.text;
    }
    // The reader shows the title above the body; don't repeat it as a heading.
    if (title && pageBlocks[0]) {
      const idx = pageBlocks[0].findIndex((b) => b.kind !== 'p' && b.text === title);
      if (idx >= 0) pageBlocks[0].splice(idx, 1);
    }

    const allBlocks = pageBlocks.flat();
    let description: string | null = null;
    const abstractIdx = allBlocks.findIndex((b) => /^abstract\b/i.test(b.text));
    if (abstractIdx >= 0) {
      const own = allBlocks[abstractIdx].text.replace(/^abstract[\s.:—–-]*/i, '');
      description = own.length > 40 ? own : (allBlocks[abstractIdx + 1]?.text ?? null);
    } else {
      description = allBlocks.find((b) => b.kind === 'p' && b.text.length >= 100)?.text ?? null;
    }
    if (description && description.length > 300) {
      description = description.slice(0, 297).replace(/\s+\S*$/, '') + '…';
    }

    // Whole pages until the size cap; the save is one D1 row, which has a hard limit.
    const sections: string[] = [];
    let size = 0;
    let pagesKept = 0;
    let wordCount = 0;
    for (const [i, blocks] of pageBlocks.entries()) {
      const body = blocks.map((b) => `<${b.kind}>${escapeHtml(b.text)}</${b.kind}>`).join('\n');
      const section = blocks.length
        ? `<section data-pdf-page="${i + 1}">\n${body}\n</section>`
        : '';
      if (pagesKept > 0 && size + section.length > maxChars) break;
      if (section) sections.push(section);
      size += section.length;
      pagesKept = i + 1;
      for (const b of blocks) wordCount += b.text.split(/\s+/).filter(Boolean).length;
    }

    if (pagesKept < pageCount) {
      sections.push(
        `<p><em>Text from the first ${pagesKept} of ${pageCount} pages. Open the original PDF for the rest.</em></p>`
      );
    }

    const author =
      typeof info.Author === 'string' && info.Author.trim() ? info.Author.trim() : null;

    return {
      title,
      author,
      description,
      // A PDF with no text layer (a scan) has nothing to reflow.
      content: wordCount > 0 ? sections.join('\n') : null,
      published: parsePdfDate(info.CreationDate),
      wordCount,
      pageCount,
      pagesKept,
      budgetExceeded,
    };
  } finally {
    // Release the parsed document. This pdf.js build has no PDFDocumentProxy.destroy();
    // the loading task owns the document and tears it down.
    await pdf.loadingTask.destroy().catch(() => {});
  }
}

/**
 * extractPdf on a worker thread. pdf.js parses synchronously on whatever thread
 * it runs on, and on the proxy's one thread a parse would stall every crawl,
 * batch and health check until it finished. A worker also gives the budget a
 * hard edge: one slow page can overrun PDF_PARSE_BUDGET_MS, but past
 * PDF_PARSE_HARD_TIMEOUT_MS the worker is terminated and this rejects with a
 * TimeoutError. Takes ownership of `bytes` (its buffer is transferred).
 */
export function extractPdfInWorker(
  bytes: Uint8Array,
  opts: { budgetMs?: number; hardTimeoutMs?: number } = {}
): Promise<PdfExtraction> {
  const hardTimeoutMs = opts.hardTimeoutMs ?? PDF_PARSE_HARD_TIMEOUT_MS;
  const worker = new Worker(new URL('./pdf-worker.ts', import.meta.url).href);
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<PdfExtraction>((resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`PDF parse exceeded ${hardTimeoutMs}ms`);
      err.name = 'TimeoutError';
      reject(err);
    }, hardTimeoutMs);
    worker.onmessage = (event: MessageEvent<PdfWorkerReply>) => {
      const reply = event.data;
      if (reply.ok) resolve(reply.result);
      else
        reject(
          reply.name === 'PdfPasswordError' ? new PdfPasswordError() : new Error(reply.message)
        );
    };
    worker.onerror = (event) => reject(new Error(event.message || 'PDF worker failed'));
    const request: PdfWorkerRequest = { bytes, budgetMs: opts.budgetMs };
    worker.postMessage(request, [bytes.buffer]);
  }).finally(() => {
    clearTimeout(timer);
    worker.terminate();
  });
}

export interface PdfWorkerRequest {
  bytes: Uint8Array;
  budgetMs?: number;
}

export type PdfWorkerReply =
  { ok: true; result: PdfExtraction } | { ok: false; name: string; message: string };
