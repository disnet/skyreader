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

// The caps end the parse early and keep what was read rather than failing the
// save. There is no time budget: a Worker's clock stands still while it computes
// (it only moves across I/O), so one could never fire. Time is bounded instead by
// the Worker's CPU limit (wrangler.toml) and the proxy's request timeout.
export const MAX_PDF_PAGES = 300;
// The proxy refuses to fetch more than this, so anything bigger didn't come from it.
export const MAX_PDF_BYTES = 50 * 1024 * 1024;
// Reflowed HTML is stored inline on the save's D1 row, whose values cap at 2 MB
// of bytes, not characters: CJK or Cyrillic text runs 2-3 bytes a character.
// Stop at whole pages well under it; 1 MB is a long book's worth.
export const MAX_PDF_CONTENT_BYTES = 1_000_000;

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
}

export class PdfPasswordError extends Error {
  constructor() {
    super('This PDF is password-protected');
    this.name = 'PdfPasswordError';
  }
}

/** pdf.js could not open the bytes as a PDF at all. */
export class PdfUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfUnreadableError';
  }
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
  /** The top of its first line, in PDF user space (y up). */
  top: number;
  /** Outline entries that land here, in outline order. */
  toc?: TocMark[];
}

interface TocMark {
  title: string;
  level: number;
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

const utf8 = new TextEncoder();
const byteLength = (s: string) => utf8.encode(s).length;

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

// A well-formed roman numeral, for front-matter page numbers ("iv").
const ROMAN = /^m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/;

function isPageNumber(text: string): boolean {
  if (/^(page\s*)?\d+(\s*(of|\/)\s*\d+)?$/i.test(text) || /^[-–—]\s*\d+\s*[-–—]$/.test(text))
    return true;
  // Roman numbers are set lowercase; requiring that and a well-formed numeral
  // keeps a closing "I" or a word like "civil" or "ill".
  const m = text.match(/^(?:page\s*)?([ivxlcdm]+)$/i);
  return !!m && m[1] === m[1].toLowerCase() && ROMAN.test(m[1]);
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
  return (line, i, page) => {
    const isEdge = i === 0 || i === page.length - 1;
    if (!isEdge) return true;
    if (isPageNumber(line.text)) return false;
    return (counts.get(norm(line.text)) ?? 0) < threshold;
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

// A short numbered line in body type ("3.1 Encoder Stacks"): a subsection a
// paper set in bold, not larger.
function isNumberedSubsection(text: string): boolean {
  return text.length <= 80 && /^\d+(\.\d+)+\.?\s+\p{Lu}/u.test(text) && !/[.:,;]$/.test(text);
}

function blocksOf(lines: Line[], bodySize: number): Block[] {
  const blocks: Block[] = [];
  let cur: (Block & { last: Line; maxEndX: number; minX: number; heading: boolean }) | null = null;
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
      // `kind` is only settled once the block is complete, so judge a heading
      // by the line that opened the block.
      const headingEnds = cur.heading;
      if (
        sizeChanged ||
        gapBreak ||
        indentBreak ||
        shortEnd ||
        (headingEnds && drop > lineHeight * 1.4)
      ) {
        blocks.push({ kind: cur.kind, text: cur.text, size: cur.size, top: cur.top });
        cur = null;
      }
    }
    if (!cur) {
      cur = {
        kind: 'p',
        text: line.text,
        size: line.size,
        top: line.y + line.size,
        last: line,
        maxEndX: line.endX,
        minX: line.x,
        heading: line.size >= bodySize * 1.15 || isNumberedSubsection(line.text),
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
  if (cur) blocks.push({ kind: cur.kind, text: cur.text, size: cur.size, top: cur.top });
  return blocks.map((b) => ({ ...b, kind: kindFor(b.size, b.text) }));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const tocAttributes = (m: TocMark) =>
  ` data-toc-title="${escapeHtml(m.title)}" data-toc-level="${m.level}"`;

// A block's markup. Outline entries ride it as `data-toc-*` (read by the
// reader's contents list): the last on the block itself, any before it as empty
// markers ahead of it, so document order stays outline order.
function blockHtml(b: Block): string {
  const marks = b.toc ?? [];
  const before = marks
    .slice(0, -1)
    .map((m) => `<div${tocAttributes(m)}></div>\n`)
    .join('');
  const own = marks.length ? tocAttributes(marks[marks.length - 1]) : '';
  return `${before}<${b.kind}${own}>${escapeHtml(b.text)}</${b.kind}>`;
}

// The leading blocks whose markup fits in `budget` bytes. When not even the first
// fits, it is cut to fit, at a word where there is one.
function fitBlocks(blocks: Block[], budget: number): Block[] {
  const blockBytes = (b: Block) => byteLength(`${blockHtml(b)}\n`);
  const kept: Block[] = [];
  let used = 0;
  for (const b of blocks) {
    const n = blockBytes(b);
    if (used + n > budget) break;
    kept.push(b);
    used += n;
  }
  if (kept.length || !blocks.length) return kept;
  const first = { ...blocks[0] };
  // Escaping can grow the text, so cut by the overshoot until it fits.
  for (let over = blockBytes(first) - budget; over > 0; over = blockBytes(first) - budget) {
    const raw = utf8.encode(first.text);
    first.text = new TextDecoder()
      .decode(raw.subarray(0, Math.max(0, raw.length - over)))
      .replace(/\uFFFD$/, '')
      .replace(/\s+\S*$/, '');
    if (!first.text) return [];
  }
  return [first];
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

// ---------------------------------------------------------------------------
// Outline
//
// A PDF's outline (its bookmarks) is the author's table of contents. Each entry
// is placed on the block it points at, so the reader's contents list can jump
// into the reflowed text as well as the original pages.

interface OutlineNode {
  title?: unknown;
  dest?: unknown;
  items?: OutlineNode[];
}

interface OutlineEntry extends TocMark {
  /** 0-based. */
  page: number;
  /** In PDF user space (y up); null for the page's top. */
  top: number | null;
}

interface OutlineDoc {
  numPages: number;
  getOutline(): Promise<OutlineNode[] | null>;
  getDestination(name: string): Promise<unknown[] | null>;
  getPageIndex(ref: { num: number; gen: number }): Promise<number>;
}

const OUTLINE_MAX_LEVEL = 3;
const OUTLINE_MAX_ENTRIES = 1000;
const OUTLINE_MAX_TITLE = 200;

const finite = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null);

/** The y an explicit destination shows, by its kind; null for the page's top. */
function destinationTop(dest: unknown[]): number | null {
  switch ((dest[1] as { name?: unknown } | undefined)?.name) {
    case 'XYZ':
      return finite(dest[3]);
    case 'FitH':
    case 'FitBH':
      return finite(dest[2]);
    case 'FitR':
      return finite(dest[5]);
    default:
      return null;
  }
}

async function resolveDestination(
  pdf: OutlineDoc,
  dest: unknown
): Promise<{ page: number; top: number | null } | null> {
  try {
    const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || !explicit.length) return null;
    const ref = explicit[0] as { num?: unknown; gen?: unknown } | number;
    const page =
      typeof ref === 'number'
        ? ref
        : typeof ref?.num === 'number' && typeof ref.gen === 'number'
          ? await pdf.getPageIndex(ref as { num: number; gen: number })
          : null;
    if (page === null || !Number.isInteger(page) || page < 0 || page >= pdf.numPages) return null;
    return { page, top: destinationTop(explicit) };
  } catch {
    // A dangling reference or a broken name tree: the entry just isn't listed.
    return null;
  }
}

/** The outline, flattened in order, three levels deep. Empty when there is none. */
export async function readOutline(pdf: OutlineDoc): Promise<OutlineEntry[]> {
  const outline = await pdf.getOutline().catch(() => null);
  const pending: { title: string; level: number; dest: unknown }[] = [];
  const walk = (nodes: OutlineNode[], level: number) => {
    for (const node of nodes) {
      if (pending.length >= OUTLINE_MAX_ENTRIES) return;
      let title = typeof node.title === 'string' ? node.title.replace(/\s+/g, ' ').trim() : '';
      if (title.length > OUTLINE_MAX_TITLE)
        title = `${title.slice(0, OUTLINE_MAX_TITLE - 1).trimEnd()}…`;
      if (title && node.dest != null) pending.push({ title, level, dest: node.dest });
      if (node.items?.length && level < OUTLINE_MAX_LEVEL) walk(node.items, level + 1);
    }
  };
  walk(outline ?? [], 1);
  const placed = await Promise.all(
    pending.map(async ({ title, level, dest }) => {
      const target = await resolveDestination(pdf, dest);
      return target ? { title, level, ...target } : null;
    })
  );
  return placed.filter((e): e is OutlineEntry => e !== null);
}

const matchKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Hang each outline entry on the block it points at: a block on its page whose
 * text is the entry's title (the heading it names), else the first block at or
 * below the point it scrolls to, else the page's first block. An entry on a
 * page left with no text goes to the next block after it.
 */
function placeOutline(pageBlocks: Block[][], outline: OutlineEntry[]): void {
  for (const entry of outline) {
    const key = matchKey(entry.title);
    let target: Block | undefined;
    const blocks = pageBlocks[entry.page] ?? [];
    if (key.length >= 3) {
      target = blocks.find((b) => {
        const text = matchKey(b.text);
        return (
          text === key ||
          (b.kind !== 'p' && (text.startsWith(key) || key.startsWith(text)) && text.length >= 3)
        );
      });
    }
    // A little slack above the point: a destination usually sits just over its line.
    if (!target && entry.top !== null) target = blocks.find((b) => b.top <= entry.top! + 2);
    target ??= blocks[0];
    for (let p = entry.page + 1; !target && p < pageBlocks.length; p++) target = pageBlocks[p][0];
    if (target) (target.toc ??= []).push({ title: entry.title, level: entry.level });
  }
}

export async function extractPdf(
  bytes: Uint8Array,
  opts: {
    maxPages?: number;
    maxBytes?: number;
    /** The caller is done with `bytes`; pdf.js may have them without a copy. */
    ownsBytes?: boolean;
  } = {}
): Promise<PdfExtraction> {
  const maxPages = opts.maxPages ?? MAX_PDF_PAGES;
  const maxBytes = opts.maxBytes ?? MAX_PDF_CONTENT_BYTES;

  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // pdf.js may detach the buffer it is given; unless the caller is done with
    // it, hand it a copy.
    pdf = await getDocumentProxy(opts.ownsBytes ? bytes : new Uint8Array(bytes), {
      verbosity: 0,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'PasswordException') throw new PdfPasswordError();
    throw new PdfUnreadableError(err instanceof Error ? err.message : String(err));
  }

  try {
    const meta = await pdf.getMetadata().catch(() => null);
    const info = (meta?.info ?? {}) as Record<string, unknown>;

    const pageCount = pdf.numPages;
    const pageLines: Line[][] = [];
    for (let n = 1; n <= Math.min(pageCount, maxPages); n++) {
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
    // figure labelling, not structure; a numbered subsection in body type is a
    // heading all the same.
    const headingCounts = new Map<string, number>();
    for (const b of pageBlocks.flat())
      if (b.kind !== 'p') headingCounts.set(b.text, (headingCounts.get(b.text) ?? 0) + 1);
    for (const b of pageBlocks.flat()) {
      if (b.kind !== 'p' && (headingCounts.get(b.text) ?? 0) > 2) b.kind = 'p';
      else if (b.kind === 'p' && isNumberedSubsection(b.text)) b.kind = 'h4';
    }

    // A paragraph cut by a page break continues on the next page: fold the
    // continuation back so the sentence isn't split in two. The tail is the last
    // block on any earlier page, so a paragraph runs on past a page left empty
    // (blank, or wholly folded into the one before). The joined paragraph keeps
    // the page it started on.
    let tail = pageBlocks[0]?.[pageBlocks[0].length - 1];
    for (let i = 1; i < pageBlocks.length; i++) {
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
      if (pageBlocks[i].length) tail = pageBlocks[i][pageBlocks[i].length - 1];
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

    placeOutline(pageBlocks, await readOutline(pdf));

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

    // Whole pages until the size cap; the save is one D1 row, which has a hard
    // limit in bytes. The first page with text, if over the cap alone, keeps the
    // blocks that fit.
    const render = (i: number, blocks: Block[]) =>
      `<section data-pdf-page="${i + 1}">\n${blocks.map(blockHtml).join('\n')}\n</section>`;
    const sections: string[] = [];
    let size = 0;
    let pagesKept = 0;
    let firstPageCut = false;
    let wordCount = 0;
    for (const [i, blocks] of pageBlocks.entries()) {
      let kept = blocks;
      let section = blocks.length ? render(i, blocks) : '';
      let bytes = byteLength(section);
      if (size + bytes > maxBytes) {
        if (sections.length) break;
        kept = fitBlocks(blocks, maxBytes - byteLength(render(i, [])));
        firstPageCut = true;
        section = kept.length ? render(i, kept) : '';
        bytes = byteLength(section);
      }
      if (section) sections.push(section);
      size += bytes;
      pagesKept = i + 1;
      for (const b of kept) wordCount += b.text.split(/\s+/).filter(Boolean).length;
      if (firstPageCut) break;
    }

    if (firstPageCut) {
      sections.push(
        `<p><em>Text from part of page ${pagesKept} of ${pageCount}. Open the original PDF for the rest.</em></p>`
      );
    } else if (pagesKept < pageCount) {
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
    };
  } finally {
    // Release the parsed document. This pdf.js build has no PDFDocumentProxy.destroy();
    // the loading task owns the document and tears it down.
    await pdf.loadingTask.destroy().catch(() => {});
  }
}
