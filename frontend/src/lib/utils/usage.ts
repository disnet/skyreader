import type { SavedItem } from '$lib/types';

/**
 * URL saves made since the start of the current UTC month — the number the
 * backend's monthly save limit counts against. Shared by Settings and
 * /supporter so the two surfaces can never disagree about "N this month".
 */
export function countUrlSavesThisMonth(articles: SavedItem[]): number {
  const monthStart = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)
  ).toISOString();
  return articles.filter((a) => a.source === 'url' && a.savedAt >= monthStart).length;
}
