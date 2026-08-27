import type { SavedItem } from '$lib/types';

export const DAILY_MAGAZINE_WORDS_PER_MINUTE = 200;

// How today's pile is ordered before it is packed into the issue:
// a stable daily shuffle, newest saves first, or oldest saves first.
export type DailyMagazineOrder = 'shuffle' | 'recent' | 'oldest';

export interface DailyMagazineCandidate<T> {
  item: T;
  key: string;
  wordCount: number | null | undefined;
  opened: boolean;
  // Epoch ms used to order 'recent'/'oldest' issues (typically the save date).
  sortValue?: number | null;
}

export interface DailyMagazineIssueItem<T> extends DailyMagazineCandidate<T> {
  minutes: number;
}

export interface DailyMagazineIssue<T> {
  dateKey: string;
  targetMinutes: number;
  totalMinutes: number;
  items: DailyMagazineIssueItem<T>[];
}

/** A local-calendar key, deliberately independent of UTC boundaries. */
export function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatMagazineDate(date: Date, locale?: string): string {
  return date.toLocaleDateString(locale, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Matches the app's existing read-time convention: 200 words per minute,
 * rounded to the nearest minute, with a one-minute floor for valid content.
 */
export function magazineReadingMinutes(wordCount: number | null | undefined): number | null {
  if (typeof wordCount !== 'number' || !Number.isFinite(wordCount) || wordCount <= 0) return null;
  return Math.max(1, Math.round(wordCount / DAILY_MAGAZINE_WORDS_PER_MINUTE));
}

/** The save rkey is present on every save and remains stable across list refreshes. */
export function savedItemMagazineKey(item: SavedItem): string {
  return item.rkey || item.uri || item.itemGuid || item.url;
}

/** Matches the key used when the same save opens in the standard saved reader. */
export function savedItemDisplayKey(item: SavedItem): string {
  return item.uri || item.itemGuid || item.rkey || item.url;
}

/** The label keys under which a save can be read or archived. */
export function savedItemLabelKeys(item: SavedItem): string[] {
  return [item.itemGuid, item.uri, item.url].filter(
    (key): key is string => typeof key === 'string' && key.length > 0
  );
}

// FNV-1a gives each stable key a repeatable daily sort score. It is not used
// for security or randomness; it simply rotates the pile without persisting an
// issue record. Shared with the highlight review deck, which rotates its own
// pile the same way.
export function dailyScore(dateKey: string, key: string): number {
  const value = `${dateKey}\0${key}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Builds a deterministic issue for one local day. The `order` mode decides how
 * the pile is ranked before packing: 'shuffle' considers never-opened items
 * first and rotates the rest by day, while 'recent'/'oldest' rank purely by
 * each candidate's `sortValue` (the save date). An item that is too long is
 * skipped so a later, shorter item can still fit.
 */
export function buildDailyMagazine<T>(
  candidates: DailyMagazineCandidate<T>[],
  targetMinutes: number,
  date: Date,
  order: DailyMagazineOrder = 'shuffle'
): DailyMagazineIssue<T> {
  const dateKey = localDateKey(date);
  const budget = Number.isFinite(targetMinutes) ? Math.max(0, Math.floor(targetMinutes)) : 0;

  const ordered = candidates
    .map((candidate): DailyMagazineIssueItem<T> | null => {
      const minutes = magazineReadingMinutes(candidate.wordCount);
      if (!candidate.key || minutes === null) return null;
      return { ...candidate, minutes };
    })
    .filter((candidate): candidate is DailyMagazineIssueItem<T> => candidate !== null)
    .sort((a, b) => {
      if (order === 'recent' || order === 'oldest') {
        const aValue = typeof a.sortValue === 'number' ? a.sortValue : 0;
        const bValue = typeof b.sortValue === 'number' ? b.sortValue : 0;
        const byDate = order === 'recent' ? bValue - aValue : aValue - bValue;
        return byDate || a.key.localeCompare(b.key);
      }
      if (a.opened !== b.opened) return a.opened ? 1 : -1;
      const scoreDifference = dailyScore(dateKey, a.key) - dailyScore(dateKey, b.key);
      return scoreDifference || a.key.localeCompare(b.key);
    });

  const items: DailyMagazineIssueItem<T>[] = [];
  let totalMinutes = 0;
  for (const candidate of ordered) {
    if (candidate.minutes <= budget - totalMinutes) {
      items.push(candidate);
      totalMinutes += candidate.minutes;
    }
  }

  return { dateKey, targetMinutes: budget, totalMinutes, items };
}

export function magazineIssueSummary(articleCount: number, totalMinutes: number): string {
  const articles = `${articleCount} ${articleCount === 1 ? 'article' : 'articles'}`;
  return `${articles} · ${totalMinutes} min`;
}
