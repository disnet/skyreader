import type { ImportedSave, ImportSource } from './parsers';

/** What the server takes per request (backend routes/saved-import.ts MAX_IMPORT_ITEMS). */
export const IMPORT_BATCH_SIZE = 100;

export interface ImportTotals {
  added: number;
  duplicates: number;
  invalid: number;
  highlights: number;
  /** A book's passages past what one book holds, left out. */
  skippedHighlights?: number;
  /** The new saves, for copying into a Semble/Margin backing collection. */
  rkeys: string[];
}

export type ImportBatch = (
  source: ImportSource,
  items: Omit<ImportedSave, 'source'>[]
) => Promise<ImportTotals>;

/**
 * Unread saves first, newest first, then the archive: the server fetches the
 * text of the first unread ones it sees, and those are the ones a reader opens next.
 */
export function importOrder(saves: ImportedSave[]): ImportedSave[] {
  return [...saves].sort(
    (a, b) => Number(a.archived) - Number(b.archived) || (b.savedAt ?? 0) - (a.savedAt ?? 0)
  );
}

/**
 * Where imported saves land in the Queue: as they were in the other app
 * (unread to the Inbox, archived to the Archive), or all in one of the two.
 */
export type QueuePlacement = 'as-exported' | 'inbox' | 'archive';

export function placeInQueue(saves: ImportedSave[], placement: QueuePlacement): ImportedSave[] {
  if (placement === 'as-exported') return saves;
  const archived = placement === 'archive';
  return saves.map((save) => (save.archived === archived ? save : { ...save, archived }));
}

/**
 * Send the saves a batch at a time, one app's at a time, and add up what the
 * server did with them. A rate-limited batch waits the time it's told and goes
 * again; anything else stops the import there, with the totals so far kept on
 * the error so the reader can see how far it got.
 */
export async function runImport(
  saves: ImportedSave[],
  importBatch: ImportBatch,
  onProgress: (done: number, total: number) => void,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<ImportTotals> {
  const totals: ImportTotals = { added: 0, duplicates: 0, invalid: 0, highlights: 0, rkeys: [] };
  const bySource = new Map<ImportSource, ImportedSave[]>();
  for (const save of importOrder(saves)) {
    const group = bySource.get(save.source);
    if (group) group.push(save);
    else bySource.set(save.source, [save]);
  }

  let done = 0;
  onProgress(done, saves.length);
  for (const [source, group] of bySource) {
    for (let i = 0; i < group.length; i += IMPORT_BATCH_SIZE) {
      const items = group
        .slice(i, i + IMPORT_BATCH_SIZE)
        .map(({ source: _source, ...item }) => item);
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await importBatch(source, items);
          totals.added += result.added;
          totals.duplicates += result.duplicates;
          totals.invalid += result.invalid;
          totals.highlights += result.highlights;
          if (result.skippedHighlights) {
            totals.skippedHighlights = (totals.skippedHighlights ?? 0) + result.skippedHighlights;
          }
          totals.rkeys.push(...(result.rkeys ?? []));
          break;
        } catch (err) {
          const retryAfter = (err as { retryAfter?: unknown }).retryAfter;
          if (typeof retryAfter === 'number' && attempt < 5) {
            await wait(Math.max(1, retryAfter) * 1000);
            continue;
          }
          throw Object.assign(err as Error, { totals });
        }
      }
      done += items.length;
      onProgress(done, saves.length);
    }
  }
  return totals;
}
