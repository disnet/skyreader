import { categoryGroupKey } from './sourceFilter';

// A folder is its sources' shared category, read trimmed. Two spellings that
// differ only in case ("Tech", "tech") are two folders; these helpers keep new
// ones from appearing and fold old ones together.

type FolderSub = { category?: string | null };

/** The folders the reader has, trimmed, each with how many sources it holds. */
export function folderCounts(subs: readonly FolderSub[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const sub of subs) {
    const name = sub.category?.trim();
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

/**
 * The folder a name lands in: one of `existing` that matches it but for case
 * (other than `from`, the folder being renamed), or the name itself, trimmed.
 */
export function folderTarget(name: string, existing: Iterable<string>, from?: string): string {
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();
  for (const folder of existing) {
    if (folder !== from && folder.toLowerCase() === lower) return folder;
  }
  return trimmed;
}

export interface CaseDuplicate {
  /** The spelling the others merge into: the fullest folder, then the first by code point. */
  keep: string;
  others: string[];
}

/** Folders whose names differ only in case, one entry per set. */
export function caseDuplicateFolders(subs: readonly FolderSub[]): CaseDuplicate[] {
  const byLower = new Map<string, Array<[string, number]>>();
  for (const [name, count] of folderCounts(subs)) {
    const key = name.toLowerCase();
    const list = byLower.get(key) ?? [];
    list.push([name, count]);
    byLower.set(key, list);
  }
  const sets: CaseDuplicate[] = [];
  for (const list of byLower.values()) {
    if (list.length < 2) continue;
    list.sort(([a, na], [b, nb]) => nb - na || (a < b ? -1 : a > b ? 1 : 0));
    sets.push({ keep: list[0][0], others: list.slice(1).map(([name]) => name) });
  }
  return sets.sort((a, b) => a.keep.localeCompare(b.keep));
}

/**
 * A channel's or filter's source keys once folder `from` is renamed `to`: the
 * old folder's key becomes the new one's, without a duplicate. `keepOld` leaves
 * the old key too, for a rename that didn't move every source.
 */
export function renameFolderKey(
  keys: readonly string[],
  from: string,
  to: string,
  keepOld = false
): string[] | null {
  const oldKey = categoryGroupKey(from);
  if (!keys.includes(oldKey)) return null;
  const newKey = categoryGroupKey(to);
  const next = keepOld ? [...keys] : keys.filter((key) => key !== oldKey);
  if (!next.includes(newKey)) next.push(newKey);
  return next;
}
