// Source key utilities for unified source filter model
// Format: "rss~{rkey}", "{rkey}~documents"
//
// A documents source is keyed by the subscription rkey (like RSS), so two
// publications owned by the same author DID are distinct sources. Legacy keys
// used the author DID ("{did}~documents") and are still resolved for
// back-compat — distinguishable because a DID carries the `did:` prefix.

const SEP = '~';

// --- Construction ---

export function rssSourceKey(rkey: string): string {
  return `rss${SEP}${rkey}`;
}

export function documentsSourceKey(rkey: string): string {
  return `${rkey}${SEP}documents`;
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
  if (sub.sourceType === 'atproto.documents') {
    return documentsSourceKey(sub.rkey);
  }
  return null;
}

// --- Documents scope resolution ---
//
// A documents source key resolves to one or more (author DID, publication)
// scopes used to decide which documents belong to it. The publication scope is
// the subscription's feedUrl when it's an `at://…publication` URI (otherwise the
// subscription covers all of that author's documents).

export interface DocScope {
  did: string;
  /** Publication AT-URI scope, or undefined for all of the author's documents. */
  pub?: string;
}

type DocScopeSub = Pick<Subscription, 'rkey' | 'sourceType' | 'subjectDid' | 'feedUrl'>;

function subToDocScope(sub: DocScopeSub): DocScope | null {
  if (!sub.subjectDid) return null;
  return {
    did: sub.subjectDid,
    pub: sub.feedUrl && sub.feedUrl.startsWith('at://') ? sub.feedUrl : undefined,
  };
}

/**
 * Resolve documents source keys to the (author, publication) scopes they cover.
 * - `{rkey}~documents` → that subscription's scope (publication-precise).
 * - legacy `{did}~documents` → the whole author (all their publications).
 * Non-documents keys are ignored.
 */
export function resolveDocScopes(sourceKeys: string[], subscriptions: DocScopeSub[]): DocScope[] {
  const scopes: DocScope[] = [];
  for (const key of sourceKeys) {
    if (!isDocumentsSource(key)) continue;
    const id = parseSourceKey(key).id;
    if (id.startsWith('did:')) {
      scopes.push({ did: id }); // legacy whole-author key
      continue;
    }
    const sub = subscriptions.find((s) => s.rkey === id && s.sourceType === 'atproto.documents');
    const scope = sub ? subToDocScope(sub) : null;
    if (scope) scopes.push(scope);
  }
  return scopes;
}

/** Whether a document falls within any of the given scopes. */
export function docInAnyScope(
  doc: { authorDid: string; siteUri?: string },
  scopes: DocScope[]
): boolean {
  return scopes.some((s) => doc.authorDid === s.did && (!s.pub || doc.siteUri === s.pub));
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
