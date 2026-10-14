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
// Pictures and the book's own links are kept, rewritten for the joined text:
// an `<img>` carries `data-epub-src` (its path in the zip), which the reader
// turns into GET /api/saved/<rkey>/asset?path=… served out of the kept
// original; ids and internal hrefs are scoped by spine position
// (`#epub-c3-note12`, epubAnchorId), and the reader jumps to them in place.

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

export interface ZipEntry {
  name: string;
  method: number;
  encrypted: boolean;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
/** The end-of-central-directory record is 22 bytes plus a comment of up to 64 KiB. */
export const EOCD_SEARCH_BYTES = 22 + 0xffff;

export interface CentralDirectoryLocation {
  count: number;
  offset: number;
  size: number;
}

/** Where the central directory is, from the file's tail (at least its last EOCD_SEARCH_BYTES). */
export function locateCentralDirectory(tail: Uint8Array): CentralDirectoryLocation {
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= Math.max(0, tail.length - EOCD_SEARCH_BYTES); i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new EpubError("This file isn't an EPUB.");
  const count = view.getUint16(eocd + 10, true);
  const size = view.getUint32(eocd + 12, true);
  const offset = view.getUint32(eocd + 16, true);
  if (offset === 0xffffffff || count === 0xffff) {
    throw new EpubError("Skyreader can't read this EPUB (Zip64).");
  }
  return { count, offset, size };
}

/** The entries of a central directory, given its bytes alone. */
export function parseCentralDirectory(cd: Uint8Array, count: number): Map<string, ZipEntry> {
  const view = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const decoder = new TextDecoder();
  const entries = new Map<string, ZipEntry>();
  let offset = 0;
  for (let n = 0; n < count; n++) {
    if (offset + 46 > cd.length || view.getUint32(offset, true) !== CENTRAL_SIG) {
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
    const name = decoder.decode(cd.subarray(offset + 46, offset + 46 + nameLen));
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

function readCentralDirectory(bytes: Uint8Array): Map<string, ZipEntry> {
  const loc = locateCentralDirectory(bytes.subarray(Math.max(0, bytes.length - EOCD_SEARCH_BYTES)));
  return parseCentralDirectory(bytes.subarray(loc.offset, loc.offset + loc.size), loc.count);
}

export const LOCAL_HEADER_BYTES = 30;

/** Where an entry's data starts, given its local header's first 30 bytes. */
export function entryDataOffset(entry: ZipEntry, localHeader: Uint8Array): number {
  const view = new DataView(localHeader.buffer, localHeader.byteOffset, localHeader.byteLength);
  if (localHeader.length < LOCAL_HEADER_BYTES || view.getUint32(0, true) !== ZIP_LOCAL_SIG) {
    throw new EpubError('This EPUB is damaged.');
  }
  return (
    entry.localOffset + LOCAL_HEADER_BYTES + view.getUint16(26, true) + view.getUint16(28, true)
  );
}

/**
 * An entry's uncompressed bytes from its stored data. Inflated as a stream so a
 * lying size field can't make us hold more than `maxBytes`: past it the read is
 * abandoned. `onChunk` sees every chunk (the parser's whole-book budget).
 */
export async function inflateEntry(
  entry: ZipEntry,
  data: Uint8Array,
  maxBytes: number,
  onChunk: (chunk: Uint8Array) => void = () => {}
): Promise<Uint8Array> {
  if (entry.encrypted) throw new EpubError('This EPUB is password-protected.');
  if (entry.size > maxBytes) throw new EpubError('This EPUB is too large to read.');
  if (data.length < entry.compressedSize) throw new EpubError('This EPUB is damaged.');
  if (entry.method === 0) {
    onChunk(data);
    return data;
  }
  if (entry.method !== 8) throw new EpubError("Skyreader can't read this EPUB's compression.");

  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new EpubError('This EPUB is too large to read.');
      onChunk(value);
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

class Inflater {
  private total = 0;
  constructor(private readonly bytes: Uint8Array) {}

  async read(entry: ZipEntry): Promise<Uint8Array> {
    const at = entry.localOffset;
    const start = entryDataOffset(entry, this.bytes.subarray(at, at + LOCAL_HEADER_BYTES));
    const data = this.bytes.subarray(start, start + entry.compressedSize);
    return inflateEntry(entry, data, MAX_ENTRY_BYTES, (chunk) => {
      this.total += chunk.byteLength;
      if (this.total > MAX_TOTAL_INFLATED_BYTES) {
        throw new EpubError('This EPUB is too large to read.');
      }
    });
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
  'image',
  'picture',
  'video',
  'audio',
  'source',
  'canvas',
  'nav',
];

const KEPT_ATTRIBUTES = new Set(['colspan', 'rowspan', 'lang', 'dir', 'start', 'reversed']);

/** Image types a book's pictures come in, and the reader can show. */
export const EPUB_IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};

/** The MIME type of an image entry in a book, by its extension; null for anything else. */
export function epubImageType(path: string): string | null {
  return EPUB_IMAGE_TYPES[path.split('.').pop()?.toLowerCase() ?? ''] ?? null;
}

/**
 * The id a chapter's element gets in the joined book: scoped by the chapter's
 * spine position, so two chapters' `#note1` stay apart, and the reader can tell
 * a book's own anchors (`#epub-…`) from a page's.
 */
export function epubAnchorId(chapter: number, id?: string): string {
  return id ? `epub-c${chapter}-${id.replace(/[^\w-]/g, '_')}` : `epub-c${chapter}`;
}

/** What a chapter's cleanup needs to know about the rest of the book. */
interface ChapterContext {
  /** The chapter's path in the zip, which its links and images are relative to. */
  path: string;
  /** Its 1-based position in the spine. */
  index: number;
  /** Every spine chapter's path → its position, for links between chapters. */
  spine: Map<string, number>;
  entries: Map<string, ZipEntry>;
}

/**
 * XHTML written for an HTML parser: `<a id="x"/>` is a complete element in XML
 * but an unclosed `<a>` to HTML, which would swallow the rest of the chapter.
 * A picture wrapped in SVG (the usual cover page) becomes a plain `<img>`.
 */
function xhtmlToHtml(xhtml: string): string {
  return xhtml
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(
      /<svg\b[^>]*>(?:(?!<\/svg>)[\s\S])*?<image\b[^>]*?\s(?:xlink:)?href\s*=\s*["']([^"']+)["'][\s\S]*?<\/svg>/gi,
      (_all, href: string) => `<img src="${href}" alt="">`
    )
    .replace(/<([a-zA-Z][\w:-]*)(\s[^<>]*?)?\s*\/>/g, (all, tag: string, rest = '') =>
      VOID_ELEMENTS.has(tag.toLowerCase()) ? all : `<${tag}${rest}></${tag}>`
    );
}

function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

// A URL with a scheme (http:, data:, javascript:…), as opposed to a path in the book.
const HAS_SCHEME = /^[a-z][\w+.-]*:/i;

/**
 * A link inside the book, as an anchor in the joined text: `#epub-c3` for a
 * chapter, `#epub-c3-note12` for a place in one. Null when it points outside
 * the reading order (a non-linear notes file, the stylesheet).
 */
function internalHref(ctx: ChapterContext, href: string): string | null {
  const hash = href.indexOf('#');
  const pathPart = hash < 0 ? href : href.slice(0, hash);
  const fragment = hash < 0 ? '' : decodeFragment(href.slice(hash + 1));
  const target = pathPart ? ctx.spine.get(resolvePath(ctx.path, pathPart)) : ctx.index;
  if (!target) return null;
  return `#${epubAnchorId(target, fragment || undefined)}`;
}

async function cleanChapter(xhtml: string, ctx: ChapterContext): Promise<string> {
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
        // A span carrying an id is a landing place for the book's links (page
        // markers, note targets): unwrapping it would leave those links dead.
        const tag = el.tagName.toLowerCase();
        if (tag !== 'html' && tag !== 'body' && el.getAttribute('id')) return;
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
        const tag = el.tagName.toLowerCase();
        const id = el.getAttribute('id') ?? (tag === 'a' ? el.getAttribute('name') : null);
        const href = tag === 'a' ? (el.getAttribute('href') ?? '').trim() : '';
        const src = tag === 'img' ? (el.getAttribute('src') ?? '').trim() : '';
        const alt = tag === 'img' ? (el.getAttribute('alt') ?? '') : '';

        const names = [...el.attributes].map(([name]) => name);
        for (const name of names) {
          if (!KEPT_ATTRIBUTES.has(name.toLowerCase())) el.removeAttribute(name);
        }
        // Kept, scoped to the chapter, so the book's own links can land on it.
        if (id) el.setAttribute('id', epubAnchorId(ctx.index, id));

        if (tag === 'img') {
          // A picture in the book is served from the kept original
          // (GET /api/saved/<rkey>/asset); the reader fills in its src.
          const path = src && !HAS_SCHEME.test(src) ? resolvePath(ctx.path, src) : '';
          if (!path || !ctx.entries.has(path) || !epubImageType(path)) {
            el.remove();
            return;
          }
          el.setAttribute('data-epub-src', path);
          el.setAttribute('alt', alt);
          return;
        }

        if (tag === 'a') {
          const target = /^(https?:|mailto:)/i.test(href)
            ? href
            : href && !HAS_SCHEME.test(href)
              ? internalHref(ctx, href)
              : null;
          if (target) el.setAttribute('href', target);
          // A link to nowhere we keep is just its text; an anchor with an id
          // stays as a landing place.
          else if (!id) el.removeAndKeepContent();
        }
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
  const ends = [...html.matchAll(/<\/(?:p|h[1-6]|blockquote|li|ul|ol|div|pre|table)>/gi)].map(
    (m) => m.index! + m[0].length
  );
  // Byte length only grows with the prefix, so binary-search the last block end
  // that fits rather than re-encoding a growing prefix at every block.
  let lo = 0;
  let hi = ends.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (byteLength(html.slice(0, ends[mid])) <= maxBytes) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? '' : html.slice(0, ends[lo - 1]);
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
// One entry out of a kept original (the reader's pictures)

/** The largest picture served out of a book. */
export const MAX_EPUB_ASSET_BYTES = 20 * 1024 * 1024;

async function readRange(
  bucket: R2Bucket,
  key: string,
  offset: number,
  length: number
): Promise<Uint8Array> {
  if (length === 0) return new Uint8Array(0);
  const object = await bucket.get(key, { range: { offset, length } });
  if (!object) throw new EpubError('This EPUB is damaged.');
  return new Uint8Array(await object.arrayBuffer());
}

/**
 * One file inside a book kept in R2, without reading the whole book: its tail
 * (the central directory's location), the directory, the entry's local header,
 * then its data — four ranged reads. Null when the book has no such entry.
 */
export async function readStoredEpubEntry(
  bucket: R2Bucket,
  key: string,
  path: string,
  maxBytes = MAX_EPUB_ASSET_BYTES
): Promise<Uint8Array | null> {
  const head = await bucket.head(key);
  if (!head) return null;
  const tailLength = Math.min(head.size, EOCD_SEARCH_BYTES);
  const tail = await readRange(bucket, key, head.size - tailLength, tailLength);
  const loc = locateCentralDirectory(tail);
  if (loc.offset + loc.size > head.size) throw new EpubError("This EPUB's file list is damaged.");
  const entries = parseCentralDirectory(
    await readRange(bucket, key, loc.offset, loc.size),
    loc.count
  );
  const entry = entries.get(path);
  if (!entry) return null;
  if (entry.compressedSize > maxBytes) throw new EpubError('This picture is too large.');
  const local = await readRange(bucket, key, entry.localOffset, LOCAL_HEADER_BYTES);
  const data = await readRange(bucket, key, entryDataOffset(entry, local), entry.compressedSize);
  return inflateEntry(entry, data, maxBytes);
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

  const spine = new Map(pkg.chapters.map((path, i) => [path, i + 1]));
  // `data-epub-chapter` counts the chapters kept; the id is the spine position
  // the book's links were scoped by.
  const sectionFor = (n: number, spineIndex: number, html: string) =>
    `<section data-epub-chapter="${n}" id="${epubAnchorId(spineIndex)}">\n${html}\n</section>`;
  const sections: string[] = [];
  let size = 0;
  let chaptersKept = 0;
  let wordCount = 0;
  let firstChapterCut = false;
  let stoppedEarly = false;
  // Chapters are cleaned one at a time and the walk stops at the first one that
  // would pass the cap, so a long book never pays for the chapters it drops.
  for (const [i, path] of pkg.chapters.entries()) {
    const xhtml = await readEntry(path);
    if (!xhtml) continue;
    const html = await cleanChapter(xhtml, { path, index: i + 1, spine, entries });
    // Blank separators go; a cover or a plate is only a picture, and stays.
    if (countWords(html) === 0 && !html.includes('data-epub-src=')) continue;
    const n = chaptersKept + 1;
    const render = (h: string) => sectionFor(n, i + 1, h);
    let kept = html;
    let section = render(kept);
    let sectionBytes = byteLength(section);
    if (size + sectionBytes > maxBytes) {
      if (sections.length) {
        stoppedEarly = true;
        break;
      }
      // One chapter over the cap on its own: keep the blocks that fit.
      kept = cutAtBlock(html, maxBytes - byteLength(render('')) - 200);
      firstChapterCut = true;
      section = render(kept);
      sectionBytes = byteLength(section);
    }
    sections.push(section);
    size += sectionBytes;
    chaptersKept = n;
    wordCount += countWords(kept);
    if (firstChapterCut) break;
  }
  // A book read to the end counts the chapters it kept. One cut short never
  // opens the rest, so its total is the spine's length (blank separators and all).
  const chapterCount = stoppedEarly || firstChapterCut ? pkg.chapters.length : chaptersKept;
  if (firstChapterCut) {
    sections.push(
      `<p><em>This copy holds part of chapter 1 of ${chapterCount}: the book is longer than Skyreader can keep in one save.</em></p>`
    );
  } else if (stoppedEarly) {
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
