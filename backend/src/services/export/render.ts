// Markdown and BibTeX renderings of a reader's saves, highlights and notes.
//
// Both are pure functions of an ExportSource list (services/export/collect.ts
// builds one from the archive records). Markdown is for reading and for note
// tools like Obsidian; BibTeX is for reference managers (Zotero, JabRef) and
// LaTeX, with each source's highlights and notes in `annote`, which reference
// managers import as a note.

export interface ExportHighlight {
  text: string;
  note?: string;
  /** ISO datetime. */
  createdAt?: string;
}

export interface ExportSource {
  /** A save, or a page that was highlighted without being saved. */
  kind: 'save' | 'highlighted';
  title?: string;
  /** Absent for an uploaded file. */
  url?: string;
  author?: string;
  domain?: string;
  /** ISO datetimes. */
  publishedAt?: string;
  savedAt?: string;
  /** The original file's name, for an upload. */
  filename?: string;
  contentType?: string;
  doi?: string;
  arxivId?: string;
  highlights: ExportHighlight[];
}

export interface ExportDocument {
  sources: ExportSource[];
  /** When the export was made, as an ISO datetime. */
  exportedAt: string;
  /** Rows that couldn't be read as records and are left out. Nearly always 0. */
  skipped: number;
}

// ─── Shared ───────────────────────────────────────────────────────────────────

const day = (iso: string | undefined) => iso?.slice(0, 10);

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

function displayTitle(source: ExportSource): string {
  return source.title?.trim() || source.filename || hostOf(source.url) || source.url || 'Untitled';
}

/**
 * The people in an author string, as best it can tell. "A; B" and "A and B"
 * are lists; "A, B" is a list only when every part is a whole name, since
 * "Doe, Jane" is one person written surname first.
 */
export function splitAuthors(raw: string | undefined): string[] {
  const text = raw?.replace(/\s+/g, ' ').trim();
  if (!text) return [];
  if (text.includes(';'))
    return text
      .split(';')
      .map((a) => a.trim())
      .filter(Boolean);
  const parts = text
    .split(/,|\band\b|&/)
    .map((a) => a.trim())
    .filter(Boolean);
  if (parts.length > 1 && parts.every((p) => p.includes(' '))) return parts;
  if (/ and | & /.test(text)) {
    return text
      .split(/ and | & /)
      .map((a) => a.trim())
      .filter(Boolean);
  }
  return [text];
}

function surname(author: string): string {
  return author.includes(',') ? author.split(',')[0] : (author.split(' ').at(-1) ?? author);
}

// Letters NFKD leaves whole, which a key would otherwise drop.
const LATIN_EXTRAS: Record<string, string> = {
  ø: 'o',
  æ: 'ae',
  œ: 'oe',
  ß: 'ss',
  ł: 'l',
  đ: 'd',
  þ: 'th',
  ð: 'd',
};

const asciiWord = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[øæœßłđþð]/g, (c) => LATIN_EXTRAS[c])
    .replace(/[^a-z0-9]/g, '');

// Words a citation key skips when it takes a title's first word, as Google
// Scholar's and Zotero's keys do.
const TITLE_STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'on',
  'of',
  'in',
  'for',
  'to',
  'and',
  'is',
  'are',
  'how',
  'why',
  'what',
  'with',
]);

function baseCitationKey(source: ExportSource): string {
  const [first] = splitAuthors(source.author);
  const who = first ? asciiWord(surname(first)) : '';
  const year = source.publishedAt?.slice(0, 4) ?? '';
  const word =
    displayTitle(source)
      .split(/\s+/)
      .map(asciiWord)
      .find((w) => w.length > 0 && !TITLE_STOPWORDS.has(w)) ?? '';
  const key = `${who}${year}${word}`;
  return key || 'skyreader';
}

/**
 * One citation key per source, in order: surname, year, first title word
 * (vaswani2017attention), with a, b, … after a key already taken. The same
 * export always gives the same keys.
 */
export function citationKeys(sources: ExportSource[]): string[] {
  const taken = new Set<string>();
  return sources.map((source) => {
    const base = baseCitationKey(source);
    let key = base;
    for (let n = 0; taken.has(key); n++) key = base + suffix(n);
    taken.add(key);
    return key;
  });
}

// a … z, then aa, ab, …
function suffix(n: number): string {
  return n < 26 ? String.fromCharCode(97 + n) : suffix(Math.floor(n / 26) - 1) + suffix(n % 26);
}

const doiUrl = (doi: string) =>
  `https://doi.org/${encodeURI(doi).replace(/[#?]/g, encodeURIComponent)}`;
const arxivUrl = (id: string) => `https://arxiv.org/abs/${id}`;

// ─── Markdown ─────────────────────────────────────────────────────────────────

// Escapes what would change the text's structure, plus `#` (an Obsidian tag)
// and `$` (math in most note tools).
function mdText(text: string): string {
  return text
    .replace(/[\\`*_[\]<>#$|~]/g, '\\$&')
    .replace(
      /^(\s*)([-+=]|\d+[.)])(?=\s|$)/gm,
      (_, space: string, mark: string) =>
        `${space}${mark.replace(/^(\d+)([.)])$/, '$1\\$2').replace(/^[-+=]$/, '\\$&')}`
    );
}

// For a heading or list item: one line, whatever the text held.
const mdLine = (text: string) => mdText(text.replace(/\s+/g, ' ').trim());

// The angle-bracket form takes any URL; only a bracket or newline in it needs escaping.
function mdUrl(url: string): string {
  return `<${url.replace(/[<>\s]/g, encodeURIComponent)}>`;
}

const mdLink = (text: string, url: string) => `[${mdLine(text)}](${mdUrl(url)})`;

function mdBlockquote(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => (line.trim() ? `> ${mdText(line.trim())}` : '>'))
    .join('\n');
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function renderMarkdown(doc: ExportDocument): string {
  const keys = citationKeys(doc.sources);
  const saves = doc.sources.filter((s) => s.kind === 'save').length;
  const others = doc.sources.length - saves;
  const highlights = doc.sources.reduce((n, s) => n + s.highlights.length, 0);
  const notes = doc.sources.reduce((n, s) => n + s.highlights.filter((h) => h.note).length, 0);

  const summary = [plural(saves, 'save')];
  if (others > 0) summary.push(`${plural(others, 'other page')} you highlighted`);
  const out: string[] = [
    '# Skyreader export',
    '',
    `Exported ${day(doc.exportedAt)}: ${summary.join(' and ')}, with ${plural(highlights, 'highlight')} and ${plural(notes, 'note')}.`,
  ];
  if (doc.skipped > 0) {
    out.push(
      '',
      `${plural(doc.skipped, 'item')} couldn't be read and ${doc.skipped === 1 ? 'is' : 'are'} left out.`
    );
  }

  doc.sources.forEach((source, i) => {
    out.push('', '---', '', `## ${mdLine(displayTitle(source))}`, '');
    const meta: string[] = [];
    if (source.author) meta.push(`Author: ${mdLine(source.author)}`);
    if (source.url) meta.push(`Link: ${mdLink(hostOf(source.url) ?? source.url, source.url)}`);
    else if (source.filename) meta.push(`File: ${mdLine(source.filename)}`);
    if (source.doi) meta.push(`DOI: ${mdLink(source.doi, doiUrl(source.doi))}`);
    if (source.arxivId) meta.push(`arXiv: ${mdLink(source.arxivId, arxivUrl(source.arxivId))}`);
    if (source.publishedAt) meta.push(`Published: ${day(source.publishedAt)}`);
    if (source.savedAt) meta.push(`Saved: ${day(source.savedAt)}`);
    meta.push(`Cite as: \`${keys[i]}\``);
    out.push(...meta.map((line) => `- ${line}`));

    if (source.highlights.length > 0) out.push('', '### Highlights');
    for (const highlight of source.highlights) {
      out.push('', highlight.text.trim() ? mdBlockquote(highlight.text) : '> …');
      if (highlight.note?.trim()) {
        const [first, ...rest] = highlight.note.trim().split('\n');
        out.push('', `**Note:** ${mdText(first)}`, ...rest.map((line) => mdText(line)));
      }
    }
  });
  return out.join('\n') + '\n';
}

// ─── BibTeX ───────────────────────────────────────────────────────────────────

const BIBTEX_ESCAPES: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  '%': '\\%',
  '&': '\\&',
  $: '\\$',
  '#': '\\#',
  _: '\\_',
  '^': '\\^{}',
  '~': '\\~{}',
};

// A text field's value: LaTeX specials escaped, whitespace (newlines included)
// folded so an entry stays one field per line.
function bibText(text: string): string {
  return text
    .replace(/[\\{}%&$#_^~]/g, (c) => BIBTEX_ESCAPES[c])
    .replace(/\s+/g, ' ')
    .trim();
}

// A verbatim field (url, doi, eprint): no escaping, but braces and whitespace
// can't appear raw, so they're percent-encoded as a URL would have them.
function bibVerbatim(text: string): string {
  return text.replace(/[{}\\\s]/g, encodeURIComponent);
}

// Highlights and notes, one per paragraph, as a reference manager's note.
function annote(source: ExportSource): string | undefined {
  const parts = source.highlights
    .map((h) => {
      const quote = h.text.trim() ? `“${h.text.trim()}”` : '';
      const note = h.note?.trim() ? `Note: ${h.note.trim()}` : '';
      return bibText([quote, note].filter(Boolean).join(' '));
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join(' \\par ') : undefined;
}

export function renderBibtex(doc: ExportDocument): string {
  const keys = citationKeys(doc.sources);
  const entries = doc.sources.map((source, i) => {
    const fields: [string, string][] = [];
    const text = (name: string, value: string | undefined) => {
      if (value?.trim()) fields.push([name, bibText(value)]);
    };
    const verbatim = (name: string, value: string | undefined) => {
      if (value) fields.push([name, bibVerbatim(value)]);
    };
    // Double braces keep a reference style from re-casing the title.
    const title = displayTitle(source);
    fields.push(['title', `{${bibText(title)}}`]);
    const authors = splitAuthors(source.author);
    if (authors.length > 0) fields.push(['author', authors.map(bibText).join(' and ')]);
    text('year', source.publishedAt?.slice(0, 4));
    text('date', day(source.publishedAt));
    verbatim('doi', source.doi);
    if (source.arxivId) {
      verbatim('eprint', source.arxivId);
      fields.push(['archivePrefix', 'arXiv'], ['eprinttype', 'arxiv']);
    }
    verbatim('url', source.url);
    // When the reader saved it, which is when it was "accessed" for a citation.
    text('urldate', source.url ? day(source.savedAt) : undefined);
    if (!source.arxivId && !source.doi) text('howpublished', hostOf(source.url));
    const notes = annote(source);
    if (notes) fields.push(['annote', notes]);
    const body = fields.map(([name, value]) => `  ${name} = {${value}}`).join(',\n');
    return `@misc{${keys[i]},\n${body}\n}`;
  });
  const header = `% Skyreader export, ${day(doc.exportedAt)}. ${plural(doc.sources.length, 'entry', 'entries')}.`;
  const skipped =
    doc.skipped > 0
      ? `\n% ${plural(doc.skipped, 'item')} couldn't be read and ${doc.skipped === 1 ? 'is' : 'are'} left out.`
      : '';
  return [header + skipped, ...entries].join('\n\n') + '\n';
}
