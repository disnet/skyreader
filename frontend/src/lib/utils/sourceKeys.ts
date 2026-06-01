// Source key utilities for unified source filter model
// Format: "rss~{rkey}", "{did}~documents"

const SEP = '~';

// --- Construction ---

export function rssSourceKey(rkey: string): string {
  return `rss${SEP}${rkey}`;
}

export function documentsSourceKey(did: string): string {
  return `${did}${SEP}documents`;
}

// --- Parsing ---

export interface ParsedSourceKey {
  kind: string; // 'rss', 'documents', etc.
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
  // Account sources: "{did}~documents"
  return { kind: suffix, id: prefix };
}

// --- Type guards ---

export function isRssSource(key: string): boolean {
  return key.startsWith(`rss${SEP}`);
}

export function isDocumentsSource(key: string): boolean {
  return key.endsWith(`${SEP}documents`);
}

// --- Extractors ---

export function getRssSubscriptionRkey(key: string): string {
  return parseSourceKey(key).id;
}

export function getSourceDid(key: string): string {
  return parseSourceKey(key).id;
}

// --- Subscription source key (derive from subscription type) ---

import type { Subscription } from '$lib/types';

export function subscriptionSourceKey(sub: Subscription): string | null {
  if (!sub.rkey) return null;
  if (!sub.sourceType || sub.sourceType === 'rss') {
    return rssSourceKey(sub.rkey);
  }
  if (sub.sourceType === 'atproto.documents' && sub.subjectDid) {
    return documentsSourceKey(sub.subjectDid);
  }
  return null;
}

// --- Account source kinds (for UI iteration) ---

export const ACCOUNT_SOURCE_KINDS = [
  { kind: 'documents', label: 'Articles', keyFn: documentsSourceKey },
] as const;

// --- Legacy migration ---

export interface LegacyViewFields {
  showArticles?: boolean;
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
 * @param allSubRkeys - All current subscription rkeys
 * @param allDids - All current followed DIDs
 * @param idToRkey - Map from Dexie ID to rkey (for feedIds migration)
 */
export function migrateLegacyView(
  view: LegacyViewFields,
  allSubRkeys: string[],
  allDids: string[],
  idToRkey?: Map<number, string>
): MigratedSourceFilter {
  const {
    showArticles = true,
    showDocuments = true,
    feedMode = 'all',
    feedIds = [],
    accountMode = 'all',
    accountDids = [],
  } = view;

  // Effective modes (respect showArticles/showDocuments)
  const effFeedMode = !showArticles ? 'none' : feedMode;
  const effAccountMode = !showDocuments ? 'none' : accountMode;

  // Both disabled → include with empty keys (shows nothing)
  if (effFeedMode === 'none' && effAccountMode === 'none') {
    return { sourceMode: 'include', sourceKeys: [] };
  }

  // Both "all" with all content types → truly all
  if (effFeedMode === 'all' && effAccountMode === 'all' && showDocuments) {
    return { sourceMode: 'all', sourceKeys: [] };
  }

  // Otherwise, enumerate the included sources explicitly
  const keys: string[] = [];

  // Helper: resolve legacy Dexie IDs to rkeys
  const resolveIds = (ids: number[]): string[] => {
    if (!idToRkey) return [];
    return ids.map((id) => idToRkey.get(id)).filter((rkey): rkey is string => rkey != null);
  };

  // Collect RSS sources
  if (effFeedMode === 'all') {
    for (const rkey of allSubRkeys) keys.push(rssSourceKey(rkey));
  } else if (effFeedMode === 'include') {
    for (const rkey of resolveIds(feedIds)) keys.push(rssSourceKey(rkey));
  } else if (effFeedMode === 'exclude') {
    const excludedRkeys = new Set(resolveIds(feedIds));
    for (const rkey of allSubRkeys) {
      if (!excludedRkeys.has(rkey)) keys.push(rssSourceKey(rkey));
    }
  }
  // effFeedMode === 'none' → no RSS keys

  // Collect account sources
  if (effAccountMode === 'all') {
    for (const did of allDids) {
      if (showDocuments) keys.push(documentsSourceKey(did));
    }
  } else if (effAccountMode === 'include') {
    for (const did of accountDids) {
      if (showDocuments) keys.push(documentsSourceKey(did));
    }
  } else if (effAccountMode === 'exclude') {
    const excludedSet = new Set(accountDids);
    for (const did of allDids) {
      if (excludedSet.has(did)) continue;
      if (showDocuments) keys.push(documentsSourceKey(did));
    }
  }
  // effAccountMode === 'none' → no account keys

  return { sourceMode: 'include', sourceKeys: keys };
}
