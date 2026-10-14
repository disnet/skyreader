// EPUB → reader HTML, for uploaded EPUBs and EPUBs saved by link.
//
// An EPUB is a zip of XHTML chapters plus a package document (the OPF) that
// lists them in reading order (the spine). Unlike a PDF there is no layout to
// infer: the text is already marked up, so this unzips the spine's chapters,
// strips them down to plain reading markup and joins them, one
// `<section data-epub-chapter="N">` per chapter. That is cheap enough to run in
// the API Worker itself, so there's no extractor service to call (PDFs go to
// pdf-extractor/ because pdf.js is CPU-bound).
//
// The result is ordinary HTML, so the reader, TextQuoteSelector highlights and
// full-text search work on a book unchanged. The frontend sanitizes it again on
// render (DOMPurify); this pass is about reading, not trust: drop the
// publisher's styles, scripts, images and ids, and keep text structure.
//
// Not carried: images (they'd need serving out of the stored original), and
// internal links (footnote refs, a chapter's own TOC), which are unwrapped to
// their text since the reader opens every link in a new tab.

export interface EpubExtraction {
  title: string | null;
  author: string | null;
  description: string | null;
  content: string | null;
  published: string | null;
  wordCount: number;
  /** Chapters in the spine with text. */
  chapterCount: number;
  /** Chapters in `content`; less than chapterCount when the size cap cut it short. */
  chaptersKept: number;
}

/** The book, not the service: not a zip, no package document, DRM, too big. */
export class EpubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EpubError';
  }
}

// The save is one D1 row, which has a hard limit in bytes; same cap as a PDF's
// reflowed text (pdf-extractor MAX_PDF_CONTENT_BYTES).
export const MAX_EPUB_CONTENT_BYTES = 1_000_000;
// Zip-bomb guards: what one chapter, and the whole book, may inflate to.
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_INFLATED_BYTES = 64 * 1024 * 1024;
const MAX_SPINE_ITEMS = 2000;

// ---------------------------------------------------------------------------
// Sniffing

const ZIP_LOCAL_SIG = 0x04034b50;

/**
 * An EPUB's first zip entry is an uncompressed `mimetype` file holding
 * `application/epub+zip` (OCF 3.0 §4.3), so its first 58 bytes say what it is.
 * Not every generator gets this right; `looksLikeZip` is the looser check.
 */
export function looksLikeEpub(bytes: Uint8Array): boolean {
  if (!looksLikeZip(bytes) || bytes.length < 58) return false;
  const head = new TextDecoder('latin1').decode(bytes.subarray(30, 58));
  return head === 'mimetypeapplication/epub+zip';
}

export function looksLikeZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) ===
      ZIP_LOCAL_SIG
  );
}

// ---------------------------------------------------------------------------
// Zip

interface ZipEntry {
  name: string;
  method: number;
  encrypted: boolean;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;

function readCentralDirectory(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record is 22 bytes plus a comment of up to 64 KiB.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new EpubError("This file isn't an EPUB.");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (offset === 0xffffffff || count === 0xffff) {
    throw new EpubError("Skyreader can't read this EPUB (Zip64).");
  }

  const decoder = new TextDecoder();
  const entries = new Map<string, ZipEntry>();
  for (let n = 0; n < count; n++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== CENTRAL_SIG) {
      throw new EpubError("This EPUB's file list is damaged.");
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    entries.set(name, {
      name,
      method,
      encrypted: (flags & 1) === 1,
      compressedSize,
      size,
      localOffset,
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

class Inflater {
  private total = 0;
  constructor(private readonly bytes: Uint8Array) {}

  async read(entry: ZipEntry): Promise<Uint8Array> {
    if (entry.encrypted) throw new EpubError('This EPUB is password-protected.');
    if (entry.size > MAX_ENTRY_BYTES) throw new EpubError('This EPUB is too large to read.');
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    const at = entry.localOffset;
    if (at + 30 > this.bytes.length || view.getUint32(at, true) !== ZIP_LOCAL_SIG) {
      throw new EpubError('This EPUB is damaged.');
    }
    const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
    const data = this.bytes.subarray(start, start + entry.compressedSize);
    if (data.length < entry.compressedSize) throw new EpubError('This EPUB is damaged.');

    if (entry.method === 0) return this.count(data);
    if (entry.method !== 8) throw new EpubError("Skyreader can't read this EPUB's compression.");

    // Inflate as a stream so a lying size field can't make us hold more than
    // the cap: past it the read is abandoned.
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_ENTRY_BYTES) throw new EpubError('This EPUB is too large to read.');
        this.count(value);
        chunks.push(value);
      }
    } catch (err) {
      await reader.cancel().catch(() => {});
      if (err instanceof EpubError) throw err;
      throw new EpubError('This EPUB is damaged.');
    }
    const out = new Uint8Array(size);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.byteLength;
    }
    return out;
  }

  private count(chunk: Uint8Array): Uint8Array {
    this.total += chunk.byteLength;
    if (this.total > MAX_TOTAL_INFLATED_BYTES) {
      throw new EpubError('This EPUB is too large to read.');
    }
    return chunk;
  }
}

function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// Package document (OPF)
//
// Read with patterns rather than an XML parser (the Worker has none). OPF is
// regular enough for that: flat <item>/<itemref> elements and a few dc: fields.

function attrs(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of source.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[m[1].replace(/^.*:/, '')] = decodeEntities(m[2] ?? m[3] ?? '');
  }
  return out;
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, e: string) => {
    const lower = e.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    if (lower === 'nbsp') return ' ';
    const code = lower.startsWith('#x')
      ? parseInt(lower.slice(2), 16)
      : parseInt(lower.slice(1), 10);
    try {
      return String.fromCodePoint(code);
    } catch {
      return all;
    }
  });
}

/** The text of every `<dc:NAME>` in the metadata, tags stripped. */
function dcValues(opf: string, name: string): string[] {
  const re = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'gi');
  return [...opf.matchAll(re)]
    .map((m) => plainText(decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'))))
    .filter(Boolean);
}

function plainText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Resolve a manifest or link href against the directory of `base`. */
function resolvePath(base: string, href: string): string {
  let path = href.split('#')[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    // A malformed escape: use it raw.
  }
  const parts = base.split('/').slice(0, -1);
  for (const seg of path.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

interface Package {
  title: string | null;
  authors: string[];
  description: string | null;
  date: string | null;
  /** Spine chapter paths, in reading order, inside the zip. */
  chapters: string[];
}

function readPackage(opfPath: string, opf: string): Package {
  const manifest = new Map<string, { path: string; type: string; props: string }>();
  for (const m of opf.matchAll(/<(?:[\w-]+:)?item\b([^>]*)>/gi)) {
    const a = attrs(m[1]);
    if (a.id && a.href) {
      manifest.set(a.id, {
        path: resolvePath(opfPath, a.href),
        type: (a['media-type'] ?? '').toLowerCase(),
        props: a.properties ?? '',
      });
    }
  }

  const chapters: string[] = [];
  for (const m of opf.matchAll(/<(?:[\w-]+:)?itemref\b([^>]*)>/gi)) {
    const a = attrs(m[1]);
    // Non-linear items (pop-up notes, answer keys) sit outside the reading order.
    if (a.linear === 'no') continue;
    const item = a.idref ? manifest.get(a.idref) : undefined;
    if (!item || !/html/.test(item.type)) continue;
    // The EPUB 3 navigation document is a TOC whose links we can't keep.
    if (/\bnav\b/.test(item.props)) continue;
    chapters.push(item.path);
    if (chapters.length >= MAX_SPINE_ITEMS) break;
  }

  const metadata =
    opf.match(/<(?:[\w-]+:)?metadata\b[\s\S]*?<\/(?:[\w-]+:)?metadata>/i)?.[0] ?? opf;
  return {
    title: dcValues(metadata, 'title')[0] ?? null,
    authors: dcValues(metadata, 'creator'),
    description: dcValues(metadata, 'description')[0] ?? null,
    date: dcValues(metadata, 'date')[0] ?? null,
    chapters,
  };
}

// ---------------------------------------------------------------------------
// Chapters

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

// Gone with everything inside them.
const DROPPED = [
  'head',
  'script',
  'style',
  'link',
  'meta',
  'title',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'svg',
  'math',
  'img',
  'image',
  'picture',
  'video',
  'audio',
  'source',
  'canvas',
  'nav',
];

const KEPT_ATTRIBUTES = new Set(['href', 'colspan', 'rowspan', 'lang', 'dir', 'start', 'reversed']);

/**
 * XHTML written for an HTML parser: `<a id="x"/>` is a complete element in XML
 * but an unclosed `<a>` to HTML, which would swallow the rest of the chapter.
 */
function xhtmlToHtml(xhtml: string): string {
  return xhtml
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<([a-zA-Z][\w:-]*)(\s[^<>]*?)?\s*\/>/g, (all, tag: string, rest = '') =>
      VOID_ELEMENTS.has(tag.toLowerCase()) ? all : `<${tag}${rest}></${tag}>`
    );
}

async function cleanChapter(xhtml: string): Promise<string> {
  let rewriter = new HTMLRewriter();
  for (const tag of DROPPED) {
    rewriter = rewriter.on(tag, {
      element(el) {
        el.remove();
      },
    });
  }
  rewriter = rewriter
    .on('html, body, span, font, small, big', {
      element(el) {
        el.removeAndKeepContent();
      },
    })
    .on('*', {
      element(el) {
        // Page-break markers carry the print edition's page number as text.
        const semantic = `${el.getAttribute('epub:type') ?? ''} ${el.getAttribute('role') ?? ''}`;
        if (/pagebreak/.test(semantic)) {
          el.remove();
          return;
        }
        const names = [...el.attributes].map(([name]) => name);
        for (const name of names) {
          if (!KEPT_ATTRIBUTES.has(name.toLowerCase())) el.removeAttribute(name);
        }
      },
    })
    .on('a', {
      element(el) {
        const href = el.getAttribute('href') ?? '';
        if (!/^(https?:|mailto:)/i.test(href)) el.removeAndKeepContent();
      },
    });
  const html = await rewriter.transform(new Response(xhtmlToHtml(xhtml))).text();
  // Blank lines left where the head and dropped elements were.
  return html.replace(/\n\s*\n+/g, '\n').trim();
}

function countWords(html: string): number {
  return plainText(html).split(/\s+/).filter(Boolean).length;
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

/** The longest prefix of `html` under `maxBytes` that ends after a block. */
function cutAtBlock(html: string, maxBytes: number): string {
  let cut = '';
  for (const m of html.matchAll(/<\/(?:p|h[1-6]|blockquote|li|ul|ol|div|pre|table)>/gi)) {
    const end = m.index! + m[0].length;
    const candidate = html.slice(0, end);
    if (byteLength(candidate) > maxBytes) break;
    cut = candidate;
  }
  return cut;
}

function isoDate(raw: string | null): string | null {
  if (!raw) return null;
  // dc:date is W3CDTF: a bare year or year-month is common.
  const normalized = /^\d{4}$/.test(raw)
    ? `${raw}-01-01`
    : /^\d{4}-\d{2}$/.test(raw)
      ? `${raw}-01`
      : raw;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function shorten(text: string, max = 300): string {
  return text.length > max ? text.slice(0, max - 3).replace(/\s+\S*$/, '') + '…' : text;
}

// ---------------------------------------------------------------------------
// Fetching (EPUBs saved by link)

/** The size cap for a linked EPUB when no reader's plan says otherwise. */
export const MAX_LINKED_EPUB_BYTES = 30 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

/**
 * An EPUB from its URL, for a save by link. The feed proxy recognises one and
 * hands it back (it reads web pages, not books); the Worker's fetch reaches only
 * the public internet (global_fetch_strictly_public).
 */
export async function fetchEpub(url: string, maxBytes: number): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: 'application/epub+zip,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (compatible; Skyreader/1.0; +https://skyreader.app)',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new EpubError("Couldn't fetch the EPUB from its site.");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new EpubError("Couldn't fetch the EPUB from its site.");
  }
  const tooLarge = `EPUBs up to ${Math.round(maxBytes / (1024 * 1024))} MB can be saved.`;
  const declared = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new EpubError(tooLarge);
  }
  if (!response.body) throw new EpubError("Couldn't fetch the EPUB from its site.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new EpubError(tooLarge);
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof EpubError) throw err;
    throw new EpubError("Couldn't fetch the EPUB from its site.");
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// ---------------------------------------------------------------------------

export async function parseEpub(
  input: ArrayBuffer | Uint8Array,
  opts: { maxContentBytes?: number } = {}
): Promise<EpubExtraction> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const maxBytes = opts.maxContentBytes ?? MAX_EPUB_CONTENT_BYTES;
  if (!looksLikeZip(bytes)) throw new EpubError("This file isn't an EPUB.");

  const entries = readCentralDirectory(bytes);
  const inflater = new Inflater(bytes);
  const readEntry = async (path: string): Promise<string | null> => {
    const entry = entries.get(path);
    return entry ? decodeText(await inflater.read(entry)) : null;
  };

  const container = await readEntry('META-INF/container.xml');
  const opfPath = container?.match(
    /<(?:[\w-]+:)?rootfile\b[^>]*full-path\s*=\s*["']([^"']+)["']/i
  )?.[1];
  const opf = opfPath ? await readEntry(decodeEntities(opfPath)) : null;
  if (!opfPath || !opf) throw new EpubError("This file isn't an EPUB.");
  const pkg = readPackage(decodeEntities(opfPath), opf);

  // Font obfuscation also lives in encryption.xml and is harmless; a chapter
  // listed there is DRM.
  const encryption = await readEntry('META-INF/encryption.xml');
  if (encryption) {
    const encrypted = new Set(
      [
        ...encryption.matchAll(/<(?:[\w-]+:)?CipherReference\b[^>]*URI\s*=\s*["']([^"']+)["']/gi),
      ].map((m) => resolvePath('', decodeEntities(m[1])))
    );
    if (pkg.chapters.some((c) => encrypted.has(c))) {
      throw new EpubError('This EPUB is DRM-protected, so Skyreader can’t read it.');
    }
  }

  const chapters: string[] = [];
  for (const path of pkg.chapters) {
    const xhtml = await readEntry(path);
    if (!xhtml) continue;
    const html = await cleanChapter(xhtml);
    // Covers, title pages that are only an image, blank separators.
    if (countWords(html) > 0) chapters.push(html);
  }

  const render = (n: number, html: string) =>
    `<section data-epub-chapter="${n}">\n${html}\n</section>`;
  const sections: string[] = [];
  let size = 0;
  let chaptersKept = 0;
  let wordCount = 0;
  let firstChapterCut = false;
  for (const [i, html] of chapters.entries()) {
    let kept = html;
    let section = render(i + 1, kept);
    let sectionBytes = byteLength(section);
    if (size + sectionBytes > maxBytes) {
      if (sections.length) break;
      // One chapter over the cap on its own: keep the blocks that fit.
      kept = cutAtBlock(html, maxBytes - byteLength(render(i + 1, '')) - 200);
      firstChapterCut = true;
      section = render(i + 1, kept);
      sectionBytes = byteLength(section);
    }
    sections.push(section);
    size += sectionBytes;
    chaptersKept = i + 1;
    wordCount += countWords(kept);
    if (firstChapterCut) break;
  }
  const chapterCount = chapters.length;
  if (firstChapterCut) {
    sections.push(
      `<p><em>This copy holds part of chapter 1 of ${chapterCount}: the book is longer than Skyreader can keep in one save.</em></p>`
    );
  } else if (chaptersKept < chapterCount) {
    sections.push(
      `<p><em>This copy holds the first ${chaptersKept} of ${chapterCount} chapters: the book is longer than Skyreader can keep in one save.</em></p>`
    );
  }

  let description = pkg.description;
  if (!description) {
    const firstLong = sections
      .join('\n')
      .match(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)
      ?.map(plainText)
      .find((t) => t.length >= 100);
    description = firstLong ?? null;
  }

  return {
    title: pkg.title ? shorten(pkg.title, 500) : null,
    author: pkg.authors.length ? pkg.authors.slice(0, 3).join(', ') : null,
    description: description ? shorten(description) : null,
    content: wordCount > 0 ? sections.join('\n') : null,
    published: isoDate(pkg.date),
    wordCount,
    chapterCount,
    chaptersKept,
  };
}
