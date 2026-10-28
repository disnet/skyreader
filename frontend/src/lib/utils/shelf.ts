import type { SavedItem } from '$lib/types';
import { savedAtMs } from './savedPile';

/**
 * Pure helpers behind the Shelf page (components/shelf/ShelfPage.svelte): what
 * kind a save is, how far through it the reader is, and the page's filter and
 * sort. The store answers "what's on the Shelf"; these answer "in what order".
 */

export type ShelfKind = 'book' | 'pdf' | 'article';
export type ShelfKindFilter = 'all' | ShelfKind;
export type ShelfSort = 'activity' | 'connected' | 'saved' | 'title' | 'author' | 'collection';

export function shelfKind(save: Pick<SavedItem, 'contentType'>): ShelfKind {
  if (save.contentType === 'epub') return 'book';
  if (save.contentType === 'pdf') return 'pdf';
  return 'article';
}

export const SHELF_KIND_LABEL: Record<ShelfKind, string> = {
  book: 'Book',
  pdf: 'PDF',
  article: 'Article',
};

/**
 * How far through, 0–1, from a `readProgress` label, or null when there's no
 * real position: never opened, or only the "opened" sentinel (-1 / 0) that the
 * combined reading surfaces write.
 */
export function progressFraction(
  progress: { paragraphIndex: number; totalParagraphs: number } | null | undefined
): number | null {
  if (!progress) return null;
  const { paragraphIndex, totalParagraphs } = progress;
  if (!(totalParagraphs > 0) || !(paragraphIndex >= 0)) return null;
  return Math.min(1, (paragraphIndex + 1) / totalParagraphs);
}

/** Past this, a reference counts as read through, not in progress. */
export const FINISHED_FRACTION = 0.97;

/**
 * Started and not yet read through. The one rule behind every "Continue
 * reading" — Home's and the Shelf's — so the two never disagree about a save.
 */
export function isInProgress(fraction: number | null): fraction is number {
  return fraction !== null && fraction > 0 && fraction < FINISHED_FRACTION;
}

export interface ShelfEntry {
  save: SavedItem;
  /** epoch ms of the last read activity, 0 when never opened */
  lastActivityAt: number;
  progress: number | null;
  /** epoch ms of the newest Semble connection someone drew off it, 0 when none */
  connectedAt?: number;
}

/** Title (else URL/domain), lowercased and stripped of a leading article. */
function titleSortKey(save: SavedItem): string {
  return (save.title || save.domain || save.url || '')
    .trim()
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, '');
}

/** "Surname, Given" sorts by surname; a single token sorts as itself. */
function authorSortKey(save: SavedItem): string {
  const author = (save.author || '').trim().toLowerCase();
  if (!author) return '￿';
  const first = author.split(/\s*(?:,|;|&|\band\b)\s*/)[0];
  if (author.includes(',')) return first;
  const parts = first.split(/\s+/);
  return parts.length > 1 ? `${parts[parts.length - 1]} ${parts.slice(0, -1).join(' ')}` : first;
}

/**
 * Narrow by kind and by a free-text query over title, author and site.
 * Every word must match somewhere, so "knuth art" finds The Art of Computer
 * Programming by Donald Knuth.
 */
export function filterShelf(
  entries: ShelfEntry[],
  kind: ShelfKindFilter,
  query: string
): ShelfEntry[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter(({ save }) => {
    if (kind !== 'all' && shelfKind(save) !== kind) return false;
    if (words.length === 0) return true;
    const haystack = [save.title, save.author, save.domain, save.description]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}

/**
 * Order the Shelf. `collection` keeps the given order (a collection's own); the
 * others are stable on ties so the list doesn't shuffle as labels sync in.
 */
export function sortShelf<T extends ShelfEntry>(entries: T[], sort: ShelfSort): T[] {
  if (sort === 'collection') return entries;
  const indexed = entries.map((entry, index) => ({ entry, index }));
  const compare = (a: { entry: T; index: number }, b: { entry: T; index: number }): number => {
    switch (sort) {
      case 'activity': {
        // Opened most recently first, then never-opened by newest save.
        const diff = b.entry.lastActivityAt - a.entry.lastActivityAt;
        if (diff !== 0) return diff;
        return savedAtMs(b.entry.save) - savedAtMs(a.entry.save);
      }
      case 'connected': {
        // Most recently connected first; the rest as Recently read orders them.
        const diff = (b.entry.connectedAt ?? 0) - (a.entry.connectedAt ?? 0);
        if (diff !== 0) return diff;
        const opened = b.entry.lastActivityAt - a.entry.lastActivityAt;
        if (opened !== 0) return opened;
        return savedAtMs(b.entry.save) - savedAtMs(a.entry.save);
      }
      case 'saved':
        return savedAtMs(b.entry.save) - savedAtMs(a.entry.save);
      case 'title':
        return titleSortKey(a.entry.save).localeCompare(titleSortKey(b.entry.save));
      case 'author': {
        const diff = authorSortKey(a.entry.save).localeCompare(authorSortKey(b.entry.save));
        return diff || titleSortKey(a.entry.save).localeCompare(titleSortKey(b.entry.save));
      }
    }
    return 0;
  };
  return indexed.sort((a, b) => compare(a, b) || a.index - b.index).map(({ entry }) => entry);
}

/**
 * "Continue reading": started, not finished, most recent first.
 */
export function continueReading(entries: ShelfEntry[], limit = 6): ShelfEntry[] {
  return entries
    .filter((e) => isInProgress(e.progress))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, limit);
}

/** How many collections the Shelf's one-line row shows, unless more are pinned. */
export const COLLECTION_ROW_SIZE = 5;
/** How many recently opened collections a device remembers. */
export const RECENT_COLLECTIONS = 10;

/**
 * The collections on the Shelf's one-line row, ahead of "All N": every pinned
 * one, then the most recently opened, then the rest, until there are `size`.
 * Recency only picks which collections fill the row; they show in the reader's
 * order, so opening a chip that's already there doesn't move the chips around.
 * Pins are never cut, so a reader who pins more than `size` gets a row that
 * scrolls, and the open collection (`selectedId`) is always on it. Recent ids
 * that no longer exist are skipped.
 */
export function collectionRow<T extends { id: string; pinned?: boolean }>(
  collections: T[],
  recentIds: string[],
  selectedId: string | null = null,
  size = COLLECTION_ROW_SIZE
): T[] {
  const pinned = collections.filter((c) => c.pinned);
  const picked = new Set<string>();
  const known = new Set(collections.map((c) => c.id));
  const unpinned = new Set(collections.filter((c) => !c.pinned).map((c) => c.id));
  const want = [...(selectedId ? [selectedId] : []), ...recentIds, ...collections.map((c) => c.id)];
  for (const id of want) {
    if (pinned.length + picked.size >= size && id !== selectedId) break;
    if (known.has(id) && unpinned.has(id)) picked.add(id);
  }
  return [...pinned, ...collections.filter((c) => picked.has(c.id))];
}

/**
 * Collections with the pinned ones first, each group in the order given: how
 * the places you file a save list them, so a pin on the Shelf's row is also
 * where you look first when filing.
 */
export function pinnedFirst<T extends { pinned?: boolean }>(collections: T[]): T[] {
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const c of collections) (c.pinned ? pinned : rest).push(c);
  return [...pinned, ...rest];
}

/** `recentIds` with `id` moved to the front, kept to `max`. */
export function pushRecent(recentIds: string[], id: string, max = RECENT_COLLECTIONS): string[] {
  return [id, ...recentIds.filter((r) => r !== id)].slice(0, max);
}
