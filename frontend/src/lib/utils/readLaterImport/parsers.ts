/**
 * A reader's library from another read-later app, read from its export.
 *
 * Every app exports differently: Pocket a CSV (or, before 2024, an HTML page)
 * plus a JSON of highlights, Omnivore a zip of JSON metadata and a Markdown file
 * of highlights per article, Instapaper a CSV or HTML page, Readwise Reader a
 * CSV of documents (its highlights are a separate Readwise CSV), Matter a zip
 * around one CSV, and Wallabag one JSON array with each entry's annotations. Each file is recognised by its shape, not its name, and
 * everything comes out as ImportedSave: one per URL, with when it was saved,
 * whether it was archived, its tags and any highlights.
 *
 * Kept free of the DOM so it runs (and is tested) anywhere.
 */

import { parseCsv } from './csv';
import { isZip, readZip } from './zip';
import { decodeEntities } from '$lib/utils/entities';

export type ImportSource =
  'pocket' | 'omnivore' | 'instapaper' | 'readwise' | 'matter' | 'wallabag';

export const IMPORT_SOURCE_NAMES: Record<ImportSource, string> = {
  pocket: 'Pocket',
  omnivore: 'Omnivore',
  instapaper: 'Instapaper',
  readwise: 'Readwise Reader',
  matter: 'Matter',
  wallabag: 'Wallabag',
};

export interface ImportedHighlight {
  text: string;
  note?: string;
  /** Epoch ms. */
  createdAt?: number;
}

export interface ImportedSave {
  source: ImportSource;
  url: string;
  title?: string;
  author?: string;
  description?: string;
  /** When it was saved in the other app, epoch ms. */
  savedAt?: number;
  archived: boolean;
  tags: string[];
  highlights: ImportedHighlight[];
}

export interface ParsedLibrary {
  saves: ImportedSave[];
  /** Things the reader should know: files not recognised, highlights with no save. */
  warnings: string[];
}

export interface ImportFile {
  name: string;
  bytes: Uint8Array;
}

// ─── Small helpers ────────────────────────────────────────────────────────────

const clean = (value: string | undefined | null): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

function webUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** A date as an export writes it: unix seconds, unix ms, or a date string. */
export function toEpochMs(value: unknown): number | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return toEpochMs(Number(trimmed));
  // Readwise writes Python's "2023-08-11 15:45:05.519000+00:00": a space for
  // the T and microseconds, which not every Date parser takes.
  const iso = trimmed.replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, '$1T$2').replace(/(\.\d{3})\d+/, '$1');
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Readwise's "['a', 'b']" (a Python list), or JSON, or nothing. */
function listOfStrings(value: string | undefined): string[] {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === '[]') return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed))
      return parsed
        .map(String)
        .map((s) => s.trim())
        .filter(Boolean);
  } catch {
    // Not JSON; read it as a Python list below.
  }
  const items = trimmed.replace(/^\[|\]$/g, '').match(/'((?:\\'|[^'])*)'|"((?:\\"|[^"])*)"/g);
  return (items ?? [])
    .map((item) =>
      item
        .slice(1, -1)
        .replace(/\\(['"])/g, '$1')
        .trim()
    )
    .filter(Boolean);
}

const has = (row: Record<string, string>, ...columns: string[]) =>
  columns.every((c) => Object.hasOwn(row, c));

// ─── Pocket ───────────────────────────────────────────────────────────────────

// The CSV Pocket sent from 2024: title,url,time_added,tags,status.
function pocketCsv(rows: Record<string, string>[]): ImportedSave[] {
  return rows.flatMap((row) => {
    const url = webUrl(row.url);
    if (!url) return [];
    return [
      {
        source: 'pocket' as const,
        url,
        title: clean(row.title),
        savedAt: toEpochMs(row.time_added),
        archived: row.status?.trim() === 'archive',
        tags: (row.tags ?? '')
          .split('|')
          .map((t) => t.trim())
          .filter(Boolean),
        highlights: [],
      },
    ];
  });
}

// The annotations JSON in the same zip: [{ url, title, highlights: [{ quote, created_at }] }].
function pocketAnnotations(json: unknown[]): ImportedSave[] {
  return json.flatMap((entry) => {
    const item = entry as { url?: string; title?: string; highlights?: unknown };
    const url = webUrl(item.url);
    if (!url || !Array.isArray(item.highlights)) return [];
    const highlights = item.highlights.flatMap((h) => {
      const text = clean((h as { quote?: string }).quote);
      return text
        ? [{ text, createdAt: toEpochMs((h as { created_at?: unknown }).created_at) }]
        : [];
    });
    return [
      {
        source: 'pocket' as const,
        url,
        title: clean(item.title),
        archived: false,
        tags: [],
        highlights,
      },
    ];
  });
}

// ─── Pocket's and Instapaper's HTML exports ──────────────────────────────────

/** Each link under each <h1> section: Pocket's ril_export.html and Instapaper's HTML export. */
function htmlSections(html: string): { section: string; attrs: string; title: string }[] {
  const links: { section: string; attrs: string; title: string }[] = [];
  let section = '';
  const token = /<h1[^>]*>([\s\S]*?)<\/h1>|<a\s([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(token)) {
    if (match[1] !== undefined) section = decodeEntities(match[1].replace(/<[^>]+>/g, '')).trim();
    else
      links.push({
        section,
        attrs: match[2],
        title: decodeEntities(match[3].replace(/<[^>]+>/g, '')),
      });
  }
  return links;
}

function attr(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  return match ? decodeEntities(match[1] ?? match[2]) : undefined;
}

function pocketHtml(html: string): ImportedSave[] {
  return htmlSections(html).flatMap(({ section, attrs, title }) => {
    const url = webUrl(attr(attrs, 'href'));
    if (!url) return [];
    return [
      {
        source: 'pocket' as const,
        url,
        title: clean(title),
        savedAt: toEpochMs(attr(attrs, 'time_added')),
        archived: /archive/i.test(section),
        tags: (attr(attrs, 'tags') ?? '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        highlights: [],
      },
    ];
  });
}

// ─── Instapaper ───────────────────────────────────────────────────────────────

/** Instapaper's one folder per article: Unread and Archive are states, any other is a tag. */
function instapaperFolder(folder: string | undefined): { archived: boolean; tag?: string } {
  const name = folder?.trim() ?? '';
  if (!name || name === 'Unread') return { archived: false };
  if (name === 'Archive') return { archived: true };
  return { archived: false, tag: name };
}

// URL,Title,Selection,Folder,Timestamp (and, since 2024, Tags as a JSON list).
function instapaperCsv(rows: Record<string, string>[]): ImportedSave[] {
  return rows.flatMap((row) => {
    const url = webUrl(row.URL);
    if (!url) return [];
    const folder = instapaperFolder(row.Folder);
    const tags = listOfStrings(row.Tags);
    if (folder.tag && !tags.includes(folder.tag)) tags.push(folder.tag);
    return [
      {
        source: 'instapaper' as const,
        url,
        title: clean(row.Title),
        description: clean(row.Selection),
        savedAt: toEpochMs(row.Timestamp),
        archived: folder.archived,
        tags,
        highlights: [],
      },
    ];
  });
}

function instapaperHtml(html: string): ImportedSave[] {
  return htmlSections(html).flatMap(({ section, attrs, title }) => {
    const url = webUrl(attr(attrs, 'href'));
    if (!url) return [];
    const folder = instapaperFolder(section);
    return [
      {
        source: 'instapaper' as const,
        url,
        title: clean(title),
        archived: folder.archived,
        tags: folder.tag ? [folder.tag] : [],
        highlights: [],
      },
    ];
  });
}

// ─── Readwise Reader ──────────────────────────────────────────────────────────

// Title,URL,ID,Document tags,Saved date,Reading progress,Location,Seen. Feed
// items are Reader's RSS inbox, not saves, so they stay behind.
function readwiseCsv(rows: Record<string, string>[]): ImportedSave[] {
  return rows.flatMap((row) => {
    const url = webUrl(row.URL);
    const location = row.Location?.trim().toLowerCase();
    if (!url || location === 'feed') return [];
    return [
      {
        source: 'readwise' as const,
        url,
        title: clean(row.Title),
        savedAt: toEpochMs(row['Saved date']),
        archived: location === 'archive',
        tags: listOfStrings(row['Document tags']),
        highlights: [],
      },
    ];
  });
}

interface LooseHighlight extends ImportedHighlight {
  title?: string;
  url?: string;
}

// Readwise's highlights CSV: Highlight,Book Title,Book Author,…,Note,…,Highlighted at.
// It names the article by title, so highlights are matched to saves that way.
function readwiseHighlightsCsv(rows: Record<string, string>[]): LooseHighlight[] {
  return rows.flatMap((row) => {
    const text = clean(row.Highlight);
    if (!text) return [];
    return [
      {
        text,
        note: clean(row.Note),
        createdAt: toEpochMs(row['Highlighted at']),
        title: clean(row['Book Title']),
        url: webUrl(row.URL ?? row['Source URL']),
      },
    ];
  });
}

// ─── Matter ───────────────────────────────────────────────────────────────────

// _matter_history.csv: Title,Author,Publisher,URL,Tags,Word Count,In Queue,
// Favorited,Read,Highlight_Count,Last Interaction Date,File Id. Out of the
// queue is Matter's archive.
function matterCsv(rows: Record<string, string>[]): ImportedSave[] {
  return rows.flatMap((row) => {
    const url = webUrl(row.URL);
    if (!url) return [];
    return [
      {
        source: 'matter' as const,
        url,
        title: clean(row.Title),
        author: clean(row.Author),
        savedAt: toEpochMs(row['Last Interaction Date']),
        archived: row['In Queue']?.trim().toLowerCase() === 'false',
        tags: (row.Tags ?? '')
          .split(';')
          .map((t) => t.trim())
          .filter(Boolean),
        highlights: [],
      },
    ];
  });
}

// ─── Wallabag ─────────────────────────────────────────────────────────────────

interface WallabagEntry {
  url?: string | null;
  given_url?: string | null;
  title?: string | null;
  published_by?: unknown;
  created_at?: string;
  is_archived?: unknown;
  tags?: unknown;
  annotations?: unknown;
}

// The JSON export: [{ url, title, is_archived: 0|1, tags: [..], created_at,
// published_by: [..], annotations: [{ quote, text }], content, … }]. An
// annotation's quote is the highlight and its text the note. The export also
// carries each article's text, which stays behind like every other app's.
function wallabagJson(json: unknown[]): ImportedSave[] {
  return json.flatMap((entry) => {
    const item = entry as WallabagEntry;
    const url = webUrl(item.url ?? undefined) ?? webUrl(item.given_url ?? undefined);
    if (!url) return [];
    const strings = (value: unknown) =>
      Array.isArray(value)
        ? value.filter((v): v is string => typeof v === 'string' && !!v.trim()).map((v) => v.trim())
        : [];
    const highlights = Array.isArray(item.annotations)
      ? item.annotations.flatMap((a) => {
          const { quote, text } = (a ?? {}) as { quote?: unknown; text?: unknown };
          const highlight = typeof quote === 'string' ? clean(quote) : undefined;
          if (!highlight) return [];
          const note = typeof text === 'string' ? clean(text) : undefined;
          return [{ text: highlight, ...(note ? { note } : {}) }];
        })
      : [];
    const archived = item.is_archived;
    return [
      {
        source: 'wallabag' as const,
        url,
        title: clean(item.title),
        author: clean(strings(item.published_by).join(', ')),
        savedAt: toEpochMs(item.created_at),
        archived: archived === 1 || archived === true || archived === '1',
        tags: strings(item.tags),
        highlights,
      },
    ];
  });
}

// ─── Omnivore ─────────────────────────────────────────────────────────────────

interface OmnivoreItem {
  slug?: string;
  url?: string;
  title?: string;
  author?: string;
  description?: string;
  state?: string;
  labels?: unknown;
  savedAt?: string;
}

function omnivoreMetadata(json: unknown[]): { save: ImportedSave; slug?: string }[] {
  return json.flatMap((entry) => {
    const item = entry as OmnivoreItem;
    const url = webUrl(item.url);
    if (!url) return [];
    const labels = Array.isArray(item.labels)
      ? item.labels
          .map((l) => (typeof l === 'string' ? l : (l as { name?: string })?.name))
          .filter((l): l is string => typeof l === 'string' && !!l.trim())
          .map((l) => l.trim())
      : [];
    return [
      {
        slug: item.slug,
        save: {
          source: 'omnivore' as const,
          url,
          title: clean(item.title),
          author: clean(item.author),
          description: clean(item.description),
          savedAt: toEpochMs(item.savedAt),
          archived: /archived/i.test(item.state ?? ''),
          tags: labels,
          highlights: [],
        },
      },
    ];
  });
}

/**
 * highlights/<slug>.md: each highlight a blockquote, then its labels (#a #b)
 * and note as following paragraphs. A paragraph break inside a quote is a
 * lone "> " line, so a quote never spans a blank line.
 */
export function omnivoreHighlights(markdown: string): ImportedHighlight[] {
  const highlights: ImportedHighlight[] = [];
  let current: ImportedHighlight | null = null;
  // Omnivore writes a highlight's labels as the paragraph right after its quote.
  let labelsNext = false;
  for (const block of markdown.replace(/\r\n/g, '\n').split(/\n\s*\n/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('>')) {
      const text = trimmed
        .split('\n')
        .map((line) => line.replace(/^>\s?/, ''))
        .join('\n')
        .replace(/\n\s*\n/g, '\n\n')
        .trim();
      current = text ? { text } : null;
      if (current) highlights.push(current);
      labelsNext = true;
    } else if (labelsNext && trimmed.startsWith('#')) {
      labelsNext = false;
    } else if (current) {
      labelsNext = false;
      current.note = current.note ? `${current.note}\n\n${trimmed}` : trimmed;
    }
  }
  return highlights;
}

// ─── Recognising files ────────────────────────────────────────────────────────

type Recognised =
  | { kind: 'saves'; saves: ImportedSave[] }
  | { kind: 'omnivore'; items: { save: ImportedSave; slug?: string }[] }
  | { kind: 'omnivoreHighlights'; slug: string; highlights: ImportedHighlight[] }
  | { kind: 'looseHighlights'; highlights: LooseHighlight[] }
  | { kind: 'unknown' }
  | { kind: 'ignored' };

const baseName = (name: string) => name.split('/').pop() ?? name;

function recognise(name: string, text: string): Recognised {
  const lower = name.toLowerCase();
  if (lower.endsWith('.md')) {
    if (/(^|\/)highlights\//.test(lower)) {
      return {
        kind: 'omnivoreHighlights',
        slug: baseName(name).replace(/\.md$/i, ''),
        highlights: omnivoreHighlights(text),
      };
    }
    return { kind: 'unknown' };
  }
  if (lower.endsWith('.csv')) {
    const rows = parseCsv(text);
    const first = rows[0];
    if (!first) return { kind: 'ignored' };
    if (has(first, 'url', 'time_added')) return { kind: 'saves', saves: pocketCsv(rows) };
    if (has(first, 'URL', 'Folder', 'Timestamp'))
      return { kind: 'saves', saves: instapaperCsv(rows) };
    if (
      has(first, 'URL', 'Location') &&
      (has(first, 'Saved date') || has(first, 'Document tags'))
    ) {
      return { kind: 'saves', saves: readwiseCsv(rows) };
    }
    if (has(first, 'Highlight', 'Book Title')) {
      return { kind: 'looseHighlights', highlights: readwiseHighlightsCsv(rows) };
    }
    if (has(first, 'URL', 'In Queue')) return { kind: 'saves', saves: matterCsv(rows) };
    return { kind: 'unknown' };
  }
  if (lower.endsWith('.json')) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { kind: 'unknown' };
    }
    if (!Array.isArray(json)) return { kind: 'unknown' };
    if (json.length === 0) return { kind: 'ignored' };
    const first = json[0] as Record<string, unknown>;
    if (Array.isArray(first?.highlights) && 'url' in first) {
      return { kind: 'saves', saves: pocketAnnotations(json) };
    }
    if ('url' in first && 'is_archived' in first) {
      return { kind: 'saves', saves: wallabagJson(json) };
    }
    if ('url' in first && ('savedAt' in first || 'slug' in first)) {
      return { kind: 'omnivore', items: omnivoreMetadata(json) };
    }
    return { kind: 'unknown' };
  }
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    // Omnivore's archive carries each article's text as content/<slug>.html.
    if (/(^|\/)content\//.test(lower)) return { kind: 'ignored' };
    if (/time_added\s*=/i.test(text) || /<title>\s*Pocket Export/i.test(text)) {
      return { kind: 'saves', saves: pocketHtml(text) };
    }
    if (/<title>\s*Instapaper/i.test(text) || /<h1[^>]*>\s*(Unread|Archive)\s*<\/h1>/i.test(text)) {
      return { kind: 'saves', saves: instapaperHtml(text) };
    }
    return { kind: 'unknown' };
  }
  // Matter's archive keeps a copy of each article under its File Id; an
  // Omnivore archive may hold PDFs. Neither is anything to import.
  return { kind: 'ignored' };
}

/** Every file the reader chose, with any zip opened up. */
async function expand(files: ImportFile[]): Promise<{ name: string; bytes: Uint8Array }[]> {
  const out: { name: string; bytes: Uint8Array }[] = [];
  for (const file of files) {
    if (isZip(file.bytes)) {
      for (const entry of readZip(file.bytes)) {
        const lower = entry.name.toLowerCase();
        // Only what recognise() reads: skipping article bodies keeps a large
        // archive from being inflated in full.
        if (/(^|\/)(__macosx|content)\//.test(lower)) continue;
        if (!/\.(csv|json|md|html?)$/.test(lower)) continue;
        out.push({ name: entry.name, bytes: await entry.read() });
      }
    } else {
      out.push(file);
    }
  }
  return out;
}

const normalizedTitle = (title: string | undefined) =>
  title?.toLowerCase().replace(/\s+/g, ' ').trim() || undefined;

/**
 * Read the chosen export files into one list of saves. Files from more than one
 * app are fine (each save remembers where it came from); the same URL twice is
 * one save, with both entries' tags and highlights.
 */
export async function parseExportFiles(files: ImportFile[]): Promise<ParsedLibrary> {
  const warnings: string[] = [];
  const decoder = new TextDecoder();
  const saves: ImportedSave[] = [];
  const omnivoreBySlug = new Map<string, ImportedSave>();
  const omnivoreHighlightsBySlug = new Map<string, ImportedHighlight[]>();
  const loose: LooseHighlight[] = [];
  const unknown: string[] = [];

  let entries: { name: string; bytes: Uint8Array }[];
  try {
    entries = await expand(files);
  } catch (err) {
    return { saves: [], warnings: [`Couldn't open the zip file: ${(err as Error).message}`] };
  }

  for (const { name, bytes } of entries) {
    const found = recognise(name, decoder.decode(bytes));
    switch (found.kind) {
      case 'saves':
        saves.push(...found.saves);
        break;
      case 'omnivore':
        for (const { save, slug } of found.items) {
          saves.push(save);
          if (slug) omnivoreBySlug.set(slug, save);
        }
        break;
      case 'omnivoreHighlights':
        omnivoreHighlightsBySlug.set(found.slug, found.highlights);
        break;
      case 'looseHighlights':
        loose.push(...found.highlights);
        break;
      case 'unknown':
        unknown.push(baseName(name));
        break;
    }
  }

  for (const [slug, highlights] of omnivoreHighlightsBySlug) {
    omnivoreBySlug.get(slug)?.highlights.push(...highlights);
  }

  // One save per URL. The first entry keeps its fields; later ones fill gaps and add theirs.
  const byUrl = new Map<string, ImportedSave>();
  for (const save of saves) {
    const kept = byUrl.get(save.url);
    if (!kept) {
      byUrl.set(save.url, { ...save, tags: [...save.tags], highlights: [...save.highlights] });
      continue;
    }
    kept.title ??= save.title;
    kept.author ??= save.author;
    kept.description ??= save.description;
    kept.savedAt ??= save.savedAt;
    // Pocket's highlights file says nothing about archiving: only a yes counts.
    kept.archived ||= save.archived;
    for (const tag of save.tags) if (!kept.tags.includes(tag)) kept.tags.push(tag);
    for (const h of save.highlights) {
      if (!kept.highlights.some((k) => k.text === h.text)) kept.highlights.push(h);
    }
  }
  const merged = [...byUrl.values()];

  if (loose.length > 0) {
    const byTitle = new Map<string, ImportedSave>();
    for (const save of merged) {
      const key = normalizedTitle(save.title);
      if (key && !byTitle.has(key)) byTitle.set(key, save);
    }
    let unmatched = 0;
    for (const { title, url, ...highlight } of loose) {
      const save = (url && byUrl.get(url)) || byTitle.get(normalizedTitle(title) ?? '');
      if (save) save.highlights.push(highlight);
      else unmatched++;
    }
    if (unmatched > 0) {
      warnings.push(
        `${unmatched} highlight${unmatched === 1 ? '' : 's'} didn't match an article in the export, so ${unmatched === 1 ? 'it was' : 'they were'} left out. Import the Readwise Reader export alongside the highlights file.`
      );
    }
  }

  if (unknown.length > 0) {
    warnings.push(
      `Skipped ${unknown.length === 1 ? 'a file' : `${unknown.length} files`} that didn't look like an export: ${unknown.slice(0, 3).join(', ')}${unknown.length > 3 ? '…' : ''}`
    );
  }

  return { saves: merged, warnings };
}
