// Source key utilities for unified source filter model
// Format: "rss~{subscriptionId}", "{did}~shares", "{did}~documents"

const SEP = '~';

// --- Construction ---

export function rssSourceKey(subscriptionId: number): string {
  return `rss${SEP}${subscriptionId}`;
}

export function sharesSourceKey(did: string): string {
  return `${did}${SEP}shares`;
}

export function documentsSourceKey(did: string): string {
  return `${did}${SEP}documents`;
}

// --- Parsing ---

export interface ParsedSourceKey {
  kind: string; // 'rss', 'shares', 'documents', etc.
  id: string; // subscription ID for RSS, DID for account sources
}

export function parseSourceKey(key: string): ParsedSourceKey {
  const lastSep = key.lastIndexOf(SEP);
  if (lastSep === -1) return { kind: key, id: '' };

  const prefix = key.substring(0, lastSep);
  const suffix = key.substring(lastSep + 1);

  if (prefix === 'rss') {
    return { kind: 'rss', id: suffix };
  }
  // Account sources: "{did}~shares", "{did}~documents"
  return { kind: suffix, id: prefix };
}

// --- Type guards ---

export function isRssSource(key: string): boolean {
  return key.startsWith(`rss${SEP}`);
}

export function isSharesSource(key: string): boolean {
  return key.endsWith(`${SEP}shares`);
}

export function isDocumentsSource(key: string): boolean {
  return key.endsWith(`${SEP}documents`);
}

// --- Extractors ---

export function getRssSubscriptionId(key: string): number {
  const parsed = parseSourceKey(key);
  return parseInt(parsed.id, 10);
}

export function getSourceDid(key: string): string {
  return parseSourceKey(key).id;
}

// --- Account source kinds (for UI iteration) ---

export const ACCOUNT_SOURCE_KINDS = [
  { kind: 'shares', label: 'Shares', keyFn: sharesSourceKey },
  { kind: 'documents', label: 'Articles', keyFn: documentsSourceKey },
] as const;

// --- Legacy migration ---

export interface LegacyViewFields {
  showArticles?: boolean;
  showShares?: boolean;
  showDocuments?: boolean;
  feedMode?: 'none' | 'all' | 'include' | 'exclude';
  feedIds?: number[];
  accountMode?: 'none' | 'all' | 'include' | 'exclude';
  accountDids?: string[];
}

export interface MigratedSourceFilter {
  sourceMode: 'all' | 'include';
  sourceKeys: string[];
}

/**
 * Convert legacy FilteredView fields to unified source filter.
 * Always produces 'all' or 'include' mode (no exclude).
 *
 * @param view - Legacy view fields
 * @param allSubIds - All current subscription IDs
 * @param allDids - All current followed DIDs
 */
export function migrateLegacyView(
  view: LegacyViewFields,
  allSubIds: number[],
  allDids: string[]
): MigratedSourceFilter {
  const {
    showArticles = true,
    showShares = true,
    showDocuments = true,
    feedMode = 'all',
    feedIds = [],
    accountMode = 'all',
    accountDids = [],
  } = view;

  // Effective modes (respect showArticles/showShares/showDocuments)
  const effFeedMode = !showArticles ? 'none' : feedMode;
  const effAccountMode = !showShares && !showDocuments ? 'none' : accountMode;

  // Both disabled → include with empty keys (shows nothing)
  if (effFeedMode === 'none' && effAccountMode === 'none') {
    return { sourceMode: 'include', sourceKeys: [] };
  }

  // Both "all" with all content types → truly all
  if (effFeedMode === 'all' && effAccountMode === 'all' && showShares && showDocuments) {
    return { sourceMode: 'all', sourceKeys: [] };
  }

  // Otherwise, enumerate the included sources explicitly
  const keys: string[] = [];

  // Collect RSS sources
  if (effFeedMode === 'all') {
    for (const id of allSubIds) keys.push(rssSourceKey(id));
  } else if (effFeedMode === 'include') {
    for (const id of feedIds) keys.push(rssSourceKey(id));
  } else if (effFeedMode === 'exclude') {
    const excludedSet = new Set(feedIds);
    for (const id of allSubIds) {
      if (!excludedSet.has(id)) keys.push(rssSourceKey(id));
    }
  }
  // effFeedMode === 'none' → no RSS keys

  // Collect account sources
  if (effAccountMode === 'all') {
    for (const did of allDids) {
      if (showShares) keys.push(sharesSourceKey(did));
      if (showDocuments) keys.push(documentsSourceKey(did));
    }
  } else if (effAccountMode === 'include') {
    for (const did of accountDids) {
      if (showShares) keys.push(sharesSourceKey(did));
      if (showDocuments) keys.push(documentsSourceKey(did));
    }
  } else if (effAccountMode === 'exclude') {
    const excludedSet = new Set(accountDids);
    for (const did of allDids) {
      if (excludedSet.has(did)) continue;
      if (showShares) keys.push(sharesSourceKey(did));
      if (showDocuments) keys.push(documentsSourceKey(did));
    }
  }
  // effAccountMode === 'none' → no account keys

  return { sourceMode: 'include', sourceKeys: keys };
}
