/**
 * A reader's own edits to a save's metadata (title, author, description,
 * published date). The edit overwrites the column itself, so every reader of
 * saved_articles — the list, search, export, the Shelf — sees it with no
 * special casing. What it adds is `edited_fields`: the columns the reader set
 * by hand, which the automated writers (re-save upgrades, backed upserts,
 * background extraction) leave alone from then on.
 */

export const EDITABLE_COLUMNS = ['title', 'author', 'description', 'published_at'] as const;
export type EditableColumn = (typeof EDITABLE_COLUMNS)[number];

export const TITLE_MAX = 500;
export const AUTHOR_MAX = 500;
export const DESCRIPTION_MAX = 2_000;

/**
 * SQL for one SET clause's value: the column as it stands when the reader has
 * edited it, otherwise `incoming` (an expression, usually a COALESCE over a
 * bound parameter, which keeps its place in the bind order either way).
 */
export function unlessEdited(column: EditableColumn, incoming: string): string {
  return `CASE WHEN instr(COALESCE(edited_fields, ''), ' ${column} ') > 0 THEN ${column} ELSE ${incoming} END`;
}

/** `edited_fields` with `columns` added. */
export function withEditedFields(current: string | null, columns: EditableColumn[]): string {
  const set = new Set((current ?? '').split(' ').filter(Boolean));
  for (const c of columns) set.add(c);
  return ` ${[...set].join(' ')} `;
}

export interface MetadataEdit {
  title?: string;
  author?: string | null;
  description?: string | null;
  published_at?: number | null;
}

/**
 * The metadata edit a PATCH body asks for, or an error to send back. A field
 * left out is untouched; an empty string or null clears it, except the title,
 * which a save always has (the list would otherwise show its bare URL, or
 * nothing at all for an upload).
 */
export function parseMetadataEdit(
  body: Record<string, unknown>
): { edit: MetadataEdit } | { error: string } {
  const edit: MetadataEdit = {};

  if ('title' in body) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) return { error: 'Title cannot be empty' };
    if (title.length > TITLE_MAX) return { error: 'Title is too long' };
    edit.title = title;
  }

  for (const [key, max] of [
    ['author', AUTHOR_MAX],
    ['description', DESCRIPTION_MAX],
  ] as const) {
    if (!(key in body)) continue;
    const value = body[key];
    if (value !== null && typeof value !== 'string') return { error: `Invalid ${key}` };
    const text = value?.trim() ?? '';
    if (text.length > max) return { error: `${key[0].toUpperCase()}${key.slice(1)} is too long` };
    edit[key] = text || null;
  }

  if ('publishedAt' in body) {
    const value = body.publishedAt;
    if (value === null || value === '') {
      edit.published_at = null;
    } else {
      const ms = typeof value === 'string' ? Date.parse(value) : NaN;
      if (!Number.isFinite(ms)) return { error: 'Invalid publishedAt' };
      edit.published_at = ms;
    }
  }

  return { edit };
}
