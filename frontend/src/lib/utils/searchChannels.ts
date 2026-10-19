// Saved searches, client side: who gets them, which channels are one, and how
// a match the server served becomes a row of the river.
//
// A saved search is a channel whose config carries a `query`. The server
// matches new items from the channel's sources against it (the Percolator) and
// serves the hits from GET /api/channels/:uuid/items, so unlike every other
// channel its items aren't filtered from the local timeline — a match can be an
// item this device never loaded. See docs/plans/SAVED_SEARCH_CHANNELS.md.

import {
  ApiError,
  OfflineError,
  type ChannelItemsResponse,
  type ChannelMatch,
} from '$lib/services/api';
import type {
  Article,
  FilteredView,
  FollowLink,
  FollowLinkSharer,
  SocialDocument,
  User,
} from '$lib/types';
import { domainFromUrl } from './highlightSource';

/** Saved searches are offered when the plan includes some and this environment has them on. */
export function canUseSavedSearches(user: User | null | undefined): boolean {
  return Boolean(user?.savedSearchEnabled && (user.limits?.maxSavedSearches ?? 0) > 0);
}

/** The channel's saved query, trimmed; null for an ordinary channel. */
export function channelQuery(view: Pick<FilteredView, 'mode' | 'query'> | null | undefined) {
  if (!view || view.mode === 'saved') return null;
  const query = view.query?.trim();
  return query ? query : null;
}

/**
 * What a saved search's matches depend on: its query and its sources, in the
 * form the server stores them (services/saved-search.ts, extractSavedQuery).
 * An edit to either changes the key, so the open channel reloads for it.
 */
export function channelMatchKey(
  view: Pick<FilteredView, 'mode' | 'query' | 'sourceMode' | 'sourceKeys'> | null | undefined
): string | null {
  const query = channelQuery(view);
  if (!query || !view) return null;
  const mode =
    view.sourceMode === 'include' || view.sourceMode === 'exclude' ? view.sourceMode : 'all';
  const keys = mode === 'all' ? [] : [...new Set(view.sourceKeys ?? [])].sort();
  return JSON.stringify([query, mode, keys]);
}

/** Whether a response is for the version of the channel that `key` names. */
export function responseMatchesKey(
  res: Pick<ChannelItemsResponse, 'query' | 'sourceMode' | 'sourceKeys'>,
  key: string
): boolean {
  const [query, mode, keys] = JSON.parse(key) as [string, string, string[]];
  if (res.query.trim() !== query) return false;
  // A server from before sources were echoed: the query is all it says.
  if (res.sourceMode === undefined) return true;
  return res.sourceMode === mode && JSON.stringify(res.sourceKeys ?? []) === JSON.stringify(keys);
}

/** Why a saved search's items couldn't be read. */
export type SearchChannelError =
  /** The operator switch is off here: the endpoint 404s. */
  | 'off'
  /** The reader's plan has no saved searches. */
  | 'upgrade'
  /** The server has no query for the channel yet: its write hasn't landed. */
  | 'not_ready'
  | 'offline'
  | 'failed';

export function classifyChannelItemsError(error: unknown): SearchChannelError {
  if (error instanceof OfflineError) return 'offline';
  if (error instanceof ApiError) {
    if (error.code === 'upgrade_required') return 'upgrade';
    if (error.code === 'not_saved_search') return 'not_ready';
    if (error.status === 404) return 'off';
  }
  return 'failed';
}

/** A match as the river holds it, with what only a match carries. */
export type SearchChannelRow =
  | { type: 'article'; item: Article; key: string }
  | { type: 'document'; item: SocialDocument; key: string }
  | { type: 'link'; item: FollowLink; key: string };

export interface MatchContext {
  /** The local subscription id for a feed URL, if the reader still follows it. */
  subscriptionIdFor: (feedUrl: string) => number | undefined;
  /** This device's copy of a document, which carries its body. */
  localDocument?: (uri: string) => SocialDocument | undefined;
  now?: number;
}

/** The people who shared a match, in the shape the card's "Shared by" pill takes. */
export function matchSharers(match: ChannelMatch): FollowLinkSharer[] {
  const sharedAt = match.publishedAt;
  return match.sharedBy.map((s) => ({
    did: s.did,
    handle: s.handle,
    name: s.name,
    avatar: s.avatar,
    kind: 'post' as const,
    postUri: s.postUri,
    text: null,
    sharedAt,
  }));
}

/**
 * The river row for a match, keyed as read state is filed (so marking it read
 * here is the same label the timeline, the document reader or the follows
 * surface would write). Null for a feed match whose feed the reader has since
 * left: it has no subscription to file its read state under.
 */
export function matchToRow(match: ChannelMatch, ctx: MatchContext): SearchChannelRow | null {
  const published = new Date(match.publishedAt).toISOString();
  if (match.kind === 'feed') {
    const subscriptionId = ctx.subscriptionIdFor(match.item.feedUrl);
    if (subscriptionId === undefined) return null;
    const item = match.item;
    const article: Article = {
      subscriptionId,
      guid: item.guid,
      url: item.url,
      title: item.title,
      author: item.author,
      content: item.content,
      summary: item.summary,
      imageUrl: item.imageUrl,
      publishedAt: item.publishedAt || published,
      fetchedAt: ctx.now ?? Date.now(),
      contentTruncated: item.contentTruncated || undefined,
      contentLead: item.contentLead || undefined,
    };
    return { type: 'article', item: article, key: article.guid };
  }
  if (match.kind === 'document') {
    const doc = match.document;
    const local = ctx.localDocument?.(doc.uri);
    if (local) return { type: 'document', item: local, key: local.recordUri };
    const document: SocialDocument = {
      authorDid: doc.authorDid,
      recordUri: doc.uri,
      siteUri: doc.siteUri,
      title: doc.title,
      description: doc.description || undefined,
      canonicalUrl: doc.url ?? undefined,
      publishedAt: published,
      createdAt: published,
    };
    return { type: 'document', item: document, key: document.recordUri };
  }
  const link = match.link;
  const followLink: FollowLink = {
    url: link.url,
    urlNormalized: link.urlNormalized,
    site: domainFromUrl(link.url) ?? link.url,
    title: link.title ?? null,
    description: link.description ?? null,
    thumb: link.thumb ?? null,
    sharers: matchSharers(match),
    sharerCount: match.sharedByCount,
    firstSharedAt: match.publishedAt,
    lastSharedAt: match.publishedAt,
  };
  return { type: 'link', item: followLink, key: link.urlNormalized };
}

/**
 * The channel's unread count: the server's, corrected for what this device has
 * marked since — read here but unread when served, or the other way round. The
 * server's count is a snapshot; without this a match read in the channel kept
 * its badge until the next refresh.
 */
export function searchChannelUnread(
  serverUnread: number,
  loaded: ReadonlyArray<ChannelMatch>,
  isRead: (match: ChannelMatch) => boolean
): number {
  let count = serverUnread;
  for (const match of loaded) {
    const readNow = isRead(match);
    if (!match.read && readNow) count--;
    else if (match.read && !readNow) count++;
  }
  return Math.max(0, count);
}

/** The server reads this much of a query (backend search-query.ts). */
export const MAX_QUERY_CHARS = 200;
const MAX_QUERY_TERMS = 16;

/**
 * Whether a query has something to look for: a word or phrase that isn't an
 * exclusion. The server ignores a query without one (it would match
 * everything), so the editor asks for one rather than saving a search that
 * silently isn't.
 */
export function hasSearchableTerm(query: string): boolean {
  let terms = 0;
  for (const match of query.slice(0, MAX_QUERY_CHARS).matchAll(/(-?)"([^"]*)"?|(-?)(\S+)/g)) {
    // The server reads the first 16 terms and no further.
    if (terms >= MAX_QUERY_TERMS) break;
    const isPhrase = match[2] !== undefined;
    const negated = (isPhrase ? match[1] : match[3]) === '-';
    const text = isPhrase ? match[2] : match[4];
    if (!/[\p{L}\p{N}]/u.test(text)) continue;
    if (!negated) return true;
    terms++;
  }
  return false;
}
