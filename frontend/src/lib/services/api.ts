import type {
  ScopeFeature,
  FeedItem,
  IntegrationMembershipEditResult,
  IntegrationMemberships,
  IntegrationStatus,
  ItemLabel,
  ItemLabelType,
  LinkblogPerson,
  LinkblogPublication,
  Magazine,
  MagazineItemSnapshot,
  MagazineParams,
  MagazinePosition,
  MarginCollection,
  MarginHighlightNote,
  ParsedFeed,
  RemoteShareDraft,
  ShareDraft,
  SaveBacking,
  SembleCollection,
  ShelfCollection,
  ShelfCollectionLink,
  ShelfLinkSync,
  SavedConnectionActivity,
  SembleCard,
  SembleConnectionType,
  SocialContextResult,
  ArticleMentions,
  MentionLaneEntry,
  CommunityHighlightNote,
  SembleContext,
  SocialDocument,
  RoomInfo,
  RoomItem,
  FollowLinksResponse,
  AllFollowLinksPage,
  FollowLinksWindow,
  FollowLinkSharersResponse,
  User,
  SavedItem,
  LibrarySource,
  SavedMetadataEdit,
} from '$lib/types';
import { getLinkPostTitle, isLinkPost } from '$lib/utils/linkPost';
import { trackMarginWrite } from '$lib/services/marginWrites';
import type { BskySourceKind } from '$lib/utils/bskySources';

const API_BASE = import.meta.env.VITE_API_URL || '';

/** One `item_labels_cache` row as `GET /api/labels` serves it. */
export interface LabelRowDTO {
  itemKey: string;
  itemType: string;
  label: string;
  props: Record<string, unknown>;
  rkey?: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;
  clientUpdatedAt?: number | null;
}

export interface DocumentsBatchV2Response {
  authors: Array<{
    did: string;
    siteUri?: string;
    // Present only on `ready`; absent on `unchanged` (bodyless) and `error`.
    documents?: SocialDocument[];
    status: 'ready' | 'unchanged' | 'error';
    error?: string;
    errorCount?: number;
    nextRetryAt?: number;
    // Per-scope content hash to store and echo as `since_digest` next poll.
    digest?: string;
    // True when `documents` is the author's complete set (fit under the proxy's
    // per-author cap) — lets a client treat an absent record as deleted.
    complete?: boolean;
  }>;
  // See fetchFeedsBatchV2 — documents ride the identical read delta.
  readCursor?: number;
}

/**
 * Give a link post back the article's own title.
 *
 * A share's record title carries the author's chosen decoration (🔗 …, “…”), and
 * that decoration is FOR foreign sites — on leaflet.pub or pckt an undecorated
 * title made the post indistinguishable from a repost of the article. Inside
 * Skyreader the headline is the article, so the decoration is stripped once here,
 * at the one boundary every document read crosses, rather than at each of the
 * dozen surfaces that render `doc.title` (feed card, saves, reader, linkblog).
 *
 * Non-link-post documents — someone's essay — are untouched: their title is their
 * own, decorations and all.
 */
function undecorateLinkPostTitle(doc: SocialDocument): SocialDocument {
  if (!isLinkPost(doc)) return doc;
  const title = getLinkPostTitle(doc);
  return title && title !== doc.title ? { ...doc, title } : doc;
}

/** The background copy of saves into a Semble/Margin backing collection. */
export interface BackingCopyStatus {
  /** saves still to copy */
  pending: number;
  /** epoch ms it picks up again, while it waits out the reader's PDS write limit */
  resumesAt: number | null;
  /** stopped after failing for days (signed out, or the PDS refusing) */
  stalled: boolean;
  /** paused by the reader */
  paused: boolean;
}

export class RateLimitError extends Error {
  retryAfter: number;

  constructor(retryAfter: number) {
    super(`Rate limit exceeded. Try again in ${retryAfter} seconds.`);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

export class ScopeUpgradeError extends Error {
  /**
   * The optional feature whose permission is missing. Absent means the
   * session's core permissions are outdated (re-grant with no features).
   */
  feature?: ScopeFeature;

  constructor(message?: string, feature?: ScopeFeature) {
    super(message || 'Skyreader needs your permission to continue.');
    this.name = 'ScopeUpgradeError';
    this.feature = feature;
  }
}

/**
 * An upload POST /api/saved/pdf or /api/saved/epub refused, with the server's
 * reader-facing sentence. `code` says which wall: the plan
 * (`pdf_upgrade_required`, for either kind), a limit (`pdf_too_large`,
 * `pdf_upload_limit_reached`, `pdf_storage_full`, `pdf_daily_limit_reached`),
 * the file (`not_a_pdf`, `pdf_unreadable`, `not_an_epub`, `epub_unreadable`),
 * or `already_saved` — the same file is already a save, `rkey` says which.
 */
export class FileUploadError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly rkey?: string
  ) {
    super(message);
    this.name = 'FileUploadError';
  }
}

function isUploadPath(path: string): boolean {
  return /^\/api\/saved\/(pdf|epub)(\?|$)/.test(path);
}

/** One capture of a save's body: when, from where, how, and the body's hash. */
export interface SavedSnapshot {
  rkey: string;
  capturedAt: string;
  url: string;
  contentType: string;
  sha256: string;
  size: number;
  method: 'live-dom' | 'server' | 'feed' | 'record' | 'upload' | null;
}

/** The original file behind an uploaded save, served only to its owner. */
export function savedFileUrl(rkey: string): string {
  return `${API_BASE}/api/saved/${encodeURIComponent(rkey)}/file`;
}

/** Every save, highlight and note as one Markdown or BibTeX file (GET /api/export). */
export function libraryExportUrl(format: 'markdown' | 'bibtex'): string {
  return `${API_BASE}/api/export?format=${format}`;
}

/**
 * The copy of a picture (by the address its body gives) that a save's snapshot
 * kept, served only to its owner.
 */
export function snapshotImageUrl(rkey: string, url: string): string {
  return `${API_BASE}/api/saved/${encodeURIComponent(rkey)}/snapshot-image?url=${encodeURIComponent(url)}`;
}

/** A picture inside a saved EPUB (its path in the book), served only to its owner. */
export function savedAssetUrl(rkey: string, path: string): string {
  return `${API_BASE}/api/saved/${encodeURIComponent(rkey)}/asset?path=${encodeURIComponent(path)}`;
}

/**
 * The picture a save shows on its card or Shelf cover: its own image, else a
 * book's cover out of its kept original. For this reader only: the cover is
 * owner-only, so it never goes into a share.
 */
export function savedCoverUrl(
  save: Pick<SavedItem, 'rkey' | 'image' | 'coverPath'>
): string | null {
  if (save.image) return save.image;
  return save.coverPath ? savedAssetUrl(save.rkey, save.coverPath) : null;
}

export class UrlSaveLimitError extends Error {
  limit: number;
  current: number;
  resetsAt: string;

  constructor(message: string, limit: number, current: number, resetsAt: string) {
    super(message);
    this.name = 'UrlSaveLimitError';
    this.limit = limit;
    this.current = current;
    this.resetsAt = resetsAt;
  }
}

/**
 * One plan cap a sync ran into. `kind` names the cap, so the client can pair the
 * sentence with the raise that actually applies — never the other one, and never
 * the upsell that belongs on a plain failure.
 */
export interface SyncLimitNotice {
  kind: 'feeds' | 'mirror';
  /**
   * What `count` counts, and the cap it went over. Optional because a client
   * can outlive the backend that fed it: without these the message is shown as
   * the backend wrote it, with them the client can add up a batched sync and
   * state one total. See `mergeNotices` in $lib/utils/limitCopy.
   */
  subject?: 'feeds' | 'linkblogs';
  count?: number;
  limit?: number;
  message: string;
}

/**
 * The tier's active-feed cap. Thrown both by the 403 handler below and by the
 * subscriptions store's own pre-check, so a caller never has to care which side
 * noticed first. Over-limit feeds are parked, not lost, so callers should say
 * "park a feed to free a slot" rather than "remove some feeds".
 */
export class SubscriptionLimitError extends Error {
  limit: number;
  current: number;

  constructor(message: string, limit: number, current: number) {
    super(message);
    this.name = 'SubscriptionLimitError';
    this.limit = limit;
    this.current = current;
  }
}

// A non-2xx the client may want to branch on by status (the feed path uses it to
// detect a backend that predates /api/v2/timeline and fall back). `message` is
// unchanged from the generic error path, so existing `e.message` handling still
// works.
export class ApiError extends Error {
  status: number;
  /** The body's machine-readable `code`, when it carries one. */
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * The target site refused Skyreader's fetcher (a bot filter or CDN in front of
 * it). Its own type rather than a generic ApiError because it is not an outage
 * and it is not the reader's mistake: the page is readable in their browser, so
 * the extension can extract it even though the server can't. Callers turn this
 * into that offer instead of a dead end.
 */
export class ExtractionBlockedError extends Error {
  constructor() {
    super('That site blocks automated readers');
    this.name = 'ExtractionBlockedError';
  }
}

/**
 * The target is a PDF (or an EPUB, per `format`) the server couldn't turn into
 * text (too large, password-protected, a failed parse). Unlike a blocked site
 * there is no way through to offer: the extension extracts a PDF tab through
 * the same server.
 */
export class PdfExtractionError extends Error {
  constructor(
    message: string,
    /** The reader's plan doesn't include PDFs; the way through is upgrading. */
    readonly upgradeRequired = false,
    readonly format: 'pdf' | 'epub' = 'pdf'
  ) {
    super(message);
    this.name = 'PdfExtractionError';
  }
}

export class OfflineError extends Error {
  constructor() {
    super('You are offline');
    this.name = 'OfflineError';
  }
}

// The backend has a live session for us but couldn't refresh its access token right
// now (e.g. a request burst racing a token refresh just after a deploy). This is a
// transient, retryable condition — NOT a logout. Surfaced after the in-fetch retries
// are exhausted so callers keep the user signed in.
export class SessionRefreshError extends Error {
  constructor() {
    super('Session is refreshing, please retry');
    this.name = 'SessionRefreshError';
  }
}

// A CONFIRMED logout: the backend answered 401 and /api/auth/me agreed the session
// is gone. Distinguished from every other failure because it is the only one that
// justifies tearing down the local, account-owned cache — a network TypeError, a
// 500, or an unconfirmed 401 must leave IndexedDB alone (see auth.verifySession).
export class SessionExpiredError extends Error {
  constructor() {
    super('Session expired');
    this.name = 'SessionExpiredError';
  }
}

// One page of GET /api/v2/timeline. Items carry their archive `seq` and the feed
// they belong to; `cursor`/`generation` are stored and echoed on the next poll.
/** A purchasable plan, mirrored from the Polar dashboard by the backend. */
export interface BillingProduct {
  id: string;
  name: string;
  interval: 'month' | 'year';
  /** Price in cents. */
  priceAmount: number;
  priceCurrency: string;
}

export interface FeedbackPost {
  uri: string;
  url: string;
  author: { did: string; handle: string; displayName: string | null; avatar: string | null };
  title: string;
  body: string;
  tags: string[];
  createdAt: string;
  votes: { up: number; down: number; net: number };
  replyCount: number;
  status: string | null;
}

/**
 * One reply on a post. `parentUri` is null for a reply to the post itself and
 * set for a reply to another reply; `mod` marks the board's own moderators,
 * which on this board means the maintainer answering.
 */
export interface FeedbackReply {
  uri: string;
  parentUri: string | null;
  author: {
    did: string;
    handle: string;
    displayName: string | null;
    avatar: string | null;
    mod: boolean;
  };
  body: string;
  createdAt: string;
  editedAt: string | null;
  votes: { up: number; down: number; net: number };
}

/** A Dev Log post, shown in the bell as "New in Skyreader" (routes/updates.ts). */
export interface DevLogUpdate {
  uri: string;
  title: string;
  description: string | null;
  url: string;
  publishedAt: string;
}

/**
 * One of the caller's own posts, reduced to the fields a change shows up in.
 * What the notification inbox polls; see `services/feedbackNotifications.ts`.
 */
export interface MyFeedbackPost {
  uri: string;
  url: string;
  title: string;
  status: string | null;
  replyCount: number;
}

/** A type a post can be filed under — the board's own vocabulary. */
export interface FeedbackType {
  value: string;
  label: string;
}

/** A lex-JSON blob reference, as the upload endpoint returns it. */
export interface FeedbackBlobRef {
  $type: 'blob';
  ref: { $link: string };
  mimeType: string;
  size: number;
}

/** One attachment on a post: the uploaded blob plus its description. */
export interface FeedbackImage {
  alt?: string;
  image: FeedbackBlobRef;
}

/** What the discussion lexicon accepts as an attachment. */
export const FEEDBACK_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const FEEDBACK_IMAGE_MAX_BYTES = 1_000_000;
export const FEEDBACK_IMAGE_MAX = 4;

export interface FeedbackBoard {
  spaceUrl: string;
  total: number;
  complete: boolean;
  /** Optional: a backend older than in-app posting doesn't send it. */
  types?: FeedbackType[];
  posts: FeedbackPost[];
}

/** The user's active Polar subscription, summarized for the Settings plan card. */
/** Which of the reader's items a search covers; omitted = all of them. */
export type SearchKind = 'read' | 'saved' | 'highlighted';

export interface SearchSnippetSegment {
  text: string;
  /** This run is one of the query's terms. */
  match: boolean;
}

/** A recent item from a saved search's sources that its query matches. */
export interface SavedSearchPreviewHit {
  kind: 'feed' | 'document' | 'save';
  itemKey: string;
  title: string;
  url: string | null;
  sourceTitle: string;
  /** Unix ms. */
  publishedAt: number | null;
  snippet: SearchSnippetSegment[];
}

export interface SavedSearchPreview {
  /** Matches among the items read. */
  total: number;
  /** Recent items read from the sources. */
  scanned: number;
  /** The sources hold more than was read, so `total` is a floor. */
  capped: boolean;
  /** The selection takes in links your follows share, which aren't previewed. */
  coversFollows: boolean;
  hits: SavedSearchPreviewHit[];
}

export interface SearchHit {
  /** Same key as `FeedDisplayItem.key`: guid, save uri, or document at:// uri. */
  itemKey: string;
  itemType: 'article' | 'document' | 'saved';
  url: string | null;
  title: string;
  feedTitle: string | null;
  feedUrl: string | null;
  read: boolean;
  saved: boolean;
  highlighted: boolean;
  /** Unix ms. */
  readAt: number | null;
  savedAt: number | null;
  highlightedAt: number | null;
  snippet: SearchSnippetSegment[];
}

/** Someone you follow who shared a saved-search match. */
export interface ChannelMatchSharer {
  did: string;
  postUri: string;
  handle: string | null;
  name: string | null;
  avatar: string | null;
}

interface ChannelMatchBase {
  /** What read state is filed under: guid, document URI, or a link's normalized URL. */
  itemKey: string;
  /** Unix ms. */
  publishedAt: number;
  matchedAt: number;
  read: boolean;
  snippet: SearchSnippetSegment[];
  /** Up to three of your follows who shared it; `sharedByCount` counts them all. */
  sharedBy: ChannelMatchSharer[];
  sharedByCount: number;
}

/** One story a saved search matched, as GET /api/channels/:uuid/items serves it. */
export type ChannelMatch =
  | (ChannelMatchBase & { kind: 'feed'; item: FeedItem & { feedUrl: string; seq: number } })
  | (ChannelMatchBase & {
      kind: 'document';
      document: {
        uri: string;
        authorDid: string;
        siteUri: string;
        url: string | null;
        title: string;
        description: string;
      };
    })
  | (ChannelMatchBase & {
      kind: 'follows';
      link: {
        url: string;
        urlNormalized: string;
        title?: string | null;
        description?: string | null;
        thumb?: string | null;
      };
      /** Matched on the sharers' words and the card only, not the article. */
      bodySkipped?: boolean;
    })
  | (ChannelMatchBase & {
      /** One of your own saves; `itemKey` is its rkey, and read means archived. */
      kind: 'save';
      save: {
        rkey: string;
        url: string;
        title: string;
        description: string;
        domain: string;
        image: string | null;
      };
    });

export interface ChannelItemsResponse {
  query: string;
  /** The sources the matches are for, as the server stored them. Absent from older servers. */
  sourceMode?: 'all' | 'include' | 'exclude';
  sourceKeys?: string[];
  /** `over_limit`: past the plan's count, so it keeps its matches but gets no new ones. */
  status: 'active' | 'over_limit';
  /** Still looking back through the last 30 days. */
  backfilling: boolean;
  items: ChannelMatch[];
  /** Capped at 1,000; `unreadCapped` means more. */
  unread: number;
  unreadCapped: boolean;
  nextCursor: string | null;
}

export interface SearchResponse {
  terms: string[];
  results: SearchHit[];
  /** Capped at 1,000; `totalCapped` means "more than that". */
  total: number;
  totalCapped: boolean;
  /** `building`: the index is still working through the reader's history. */
  index: { items: number; building: boolean };
}

/** One Bluesky likes / bookmarks source, as GET /api/v2/bluesky-sources reports it. */
export interface BlueskySourceStatus {
  enabled: boolean;
  /** On, but parked by the plan's active-source limit: nothing is gathered. */
  parked: boolean;
  /** Needs a permission this sign-in doesn't hold (bookmarks only). */
  scopeRequired: boolean;
  lastPollAt: number | null;
  error: string | null;
}

export type BlueskySourcesStatus = Record<BskySourceKind, BlueskySourceStatus>;

export interface NewsletterInbox {
  enabled: boolean;
  entitled: boolean;
  address: string | null;
  lastReceivedAt: number | null;
  blockedSenders: Array<{ sender: string; blockedAt: number }>;
}

// Credentials for other RSS apps (backend/src/routes/app-passwords.ts).
export interface AppPasswordList {
  passwords: Array<{ id: number; name: string; createdAt: number; lastUsedAt: number | null }>;
  /** What the reader types into their app as the server address. */
  serverUrl: string;
  username: string;
}

// The reader's Zotero connection (backend/src/routes/zotero.ts). The key is never sent back.
export type ZoteroStatus =
  | { connected: false }
  | {
      connected: true;
      username: string | null;
      scope: 'everything' | 'collections';
      collections: string[];
      /** Unix seconds. */
      lastSyncAt: number | null;
      lastError: string | null;
      syncing: boolean;
    };

export interface BillingSubscription {
  productName: string | null;
  /** Price in cents. */
  amount: number;
  currency: string;
  interval: 'month' | 'year';
  /** ISO timestamp: when the current period renews. */
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  /** ISO timestamp: set once the subscription is scheduled to end. */
  endsAt: string | null;
}

export interface TimelineResponse {
  items: Array<FeedItem & { seq: number; feedUrl: string; read: boolean }>;
  cursor: number;
  generation: string;
  hasMore: boolean;
  // Server time (unix seconds) at annotation — seeds the forward read delta.
  readCursor?: number;
  // True when the server served a per-feed newest slice instead of draining from
  // a cursor (no cursor sent, or the generation no longer matches).
  coldStart: boolean;
  // Continuation index for a paged cold start; echo it back as `cold_offset`.
  nextColdOffset?: number;
  // Whether this deployment's crawler is actually pushing into the archive.
  // Absent on a backend that predates the flag.
  ingestActive?: boolean;
  // Feed-level metadata for the caller's subscriptions; present only on a page
  // that carried items.
  feeds?: Record<string, { title?: string; siteUrl?: string; imageUrl?: string }>;
  // Revision of the server's unhealthy-feed set. Echoed back as `health_rev` so
  // the payload below is only re-sent when it actually changed.
  healthRev?: string;
  // Per-feed crawl health for the caller's subscriptions — ONLY the broken ones.
  // A subscribed feed missing from this map is healthy, which is how recovery is
  // communicated. Present on every cold start and whenever `healthRev` moved.
  // Absent entirely on a backend that predates feed-health reporting.
  feedHealth?: Record<string, TimelineFeedHealth>;
  // Server-computed unread counts per feed URL, over the canonical newest-K
  // window. Requested with `include_counts=1` on the first page of a refresh.
  // These are what makes two devices agree: a locally-derived count is taken
  // over whatever slice THIS device holds, and no two devices hold the same one.
  unreadCounts?: Record<string, number>;
  // The archive head as of the counts response — passed back as `beforeSeq` when
  // marking a feed read, so items ingested after the press stay unread.
  head?: number;
}

/** One broken feed as the timeline reports it. Timestamps are unix ms. */
export interface TimelineFeedHealth {
  errorCount: number;
  error?: string;
  lastErrorAt?: number;
  nextRetryAt?: number;
  lastFetchedAt?: number;
}

export interface StarterChannel {
  key: string;
  name: string;
  description: string;
  feeds: Array<{ feedUrl: string; title: string; siteUrl: string }>;
}

export interface ExtractedArticle {
  title: string | null;
  author: string | null;
  description: string | null;
  content: string | null;
  domain: string | null;
  image: string | null;
  published: string | null;
  wordCount: number;
  /** 'pdf' or 'epub' when the URL served one (its text, reflowed); absent for a web page. */
  contentType?: 'pdf' | 'epub';
  /** The DOI the page named in its <head> (citation_doi and kin), if any. */
  doi?: string | null;
}

// How many times a single request transparently retries a transient
// session-refresh (503) before giving up and surfacing SessionRefreshError.
const MAX_SESSION_REFRESH_RETRIES = 4;
const MAX_UNAUTHORIZED_RETRIES = 1;

type SessionProbeResult = 'active' | 'expired' | 'unknown';

class ApiClient {
  private onUnauthorized: (() => void) | null = null;
  private onScopeUpgradeRequired: ((feature?: ScopeFeature) => void) | null = null;
  private sessionProbe: Promise<SessionProbeResult> | null = null;

  // Set callback for when 401 is received (session invalid)
  setOnUnauthorized(callback: () => void) {
    this.onUnauthorized = callback;
  }

  // Set callback for when 403 scope_upgrade_required is received
  setOnScopeUpgradeRequired(callback: (feature?: ScopeFeature) => void) {
    this.onScopeUpgradeRequired = callback;
  }

  private probeSession(): Promise<SessionProbeResult> {
    if (this.sessionProbe) return this.sessionProbe;

    const runProbe = async (sessionRefreshAttempt = 0): Promise<SessionProbeResult> => {
      try {
        const response = await fetch(`${API_BASE}/api/auth/me`, {
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
        });

        if (response.ok) return 'active';
        if (response.status === 401) return 'expired';

        if (response.status === 503) {
          const body = await response
            .json()
            .catch(() => null as { retryable?: boolean; error?: string } | null);
          if (body?.retryable && sessionRefreshAttempt < MAX_SESSION_REFRESH_RETRIES) {
            const delay = 400 * 2 ** sessionRefreshAttempt;
            await new Promise((resolve) => setTimeout(resolve, delay));
            return runProbe(sessionRefreshAttempt + 1);
          }
        }
      } catch {
        // A failed probe is not evidence that the session is gone.
      } finally {
        this.sessionProbe = null;
      }

      return 'unknown';
    };

    this.sessionProbe = runProbe();
    return this.sessionProbe;
  }

  private async fetch<T>(
    path: string,
    options: RequestInit = {},
    sessionRefreshAttempt = 0,
    unauthorizedAttempt = 0
  ): Promise<T> {
    // Fail fast when offline instead of waiting for network timeout
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      throw new OfflineError();
    }

    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    // Session is managed via HTTP-only cookies, no Authorization header needed
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      credentials: 'include',
    });

    if (!response.ok) {
      // Handle 503 session_refresh_pending - the backend has a live session for us
      // but couldn't refresh its token in time (transient, e.g. a request burst
      // racing a refresh right after a deploy). Back off and retry transparently;
      // crucially, do NOT log out. The 401 below is reserved for genuine logout.
      if (response.status === 503) {
        const body = await response
          .json()
          .catch(() => null as { retryable?: boolean; error?: string } | null);
        if (body?.retryable) {
          if (sessionRefreshAttempt < MAX_SESSION_REFRESH_RETRIES) {
            // 400ms, 800ms, 1.6s, 3.2s — covers the refresh-poll window without
            // hammering the backend.
            const delay = 400 * 2 ** sessionRefreshAttempt;
            await new Promise((resolve) => setTimeout(resolve, delay));
            return this.fetch<T>(path, options, sessionRefreshAttempt + 1, unauthorizedAttempt);
          }
          // Exhausted retries — keep the user logged in and let the caller decide.
          throw new SessionRefreshError();
        }
        // Any other 503 is the server saying "try again later" (e.g. a PDS write
        // that timed out), so keep the status for callers that decide on it.
        throw new ApiError(body?.error || `HTTP ${response.status}`, 503);
      }

      // Handle 401. During deploys, an open tab can occasionally see one stale/racy
      // 401 from a background request even though the cookie-backed session is still
      // valid. Confirm against /api/auth/me before tearing down local auth.
      if (response.status === 401) {
        const sessionStatus = path === '/api/auth/me' ? 'expired' : await this.probeSession();

        if (sessionStatus === 'active') {
          if (unauthorizedAttempt < MAX_UNAUTHORIZED_RETRIES) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            return this.fetch<T>(path, options, sessionRefreshAttempt, unauthorizedAttempt + 1);
          }
          throw new Error('Unauthorized');
        }

        if (sessionStatus === 'unknown') {
          throw new SessionRefreshError();
        }

        console.warn('Session expired or invalid, logging out...');
        if (this.onUnauthorized) this.onUnauthorized();
        throw new SessionExpiredError();
      }

      // Handle 403 - scope upgrade required or limit reached
      if (response.status === 403) {
        const body = await response.json().catch(() => ({ error: 'Forbidden' }));
        if ((body as { error: string }).error === 'scope_upgrade_required') {
          const { message, feature } = body as { message?: string; feature?: ScopeFeature };
          if (this.onScopeUpgradeRequired) {
            this.onScopeUpgradeRequired(feature);
          }
          throw new ScopeUpgradeError(message, feature);
        }
        if (isUploadPath(path)) {
          const b = body as { error?: string; message?: string };
          throw new FileUploadError(
            b.message || b.error || 'Upload refused',
            b.error || 'forbidden'
          );
        }
        if ((body as { error: string }).error === 'url_save_limit_reached') {
          const b = body as {
            message: string;
            limit: number;
            current: number;
            resetsAt: string;
          };
          throw new UrlSaveLimitError(b.message, b.limit, b.current, b.resetsAt);
        }
        if ((body as { error: string }).error === 'subscription_limit_reached') {
          const b = body as { message: string; limit: number; current: number };
          throw new SubscriptionLimitError(b.message, b.limit, b.current);
        }
        if ((body as { code?: string }).code === 'upgrade_required') {
          throw new ApiError((body as { error: string }).error, 403, 'upgrade_required');
        }
        throw new Error((body as { error: string }).error || `HTTP ${response.status}`);
      }

      // Handle 429 - rate limit exceeded
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('Retry-After') || '60', 10);
        throw new RateLimitError(retryAfter);
      }

      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      // The proxy marks a fetch the target site refused. The server-side message
      // is diagnostic prose about bot filters and CDNs, so it is dropped here in
      // favour of copy written for a reader. Scoped to /api/extract on purpose:
      // that is the only route that fetches the target site (a save posts content
      // the client already extracted), and feed discovery flags blocked fetches
      // the same way but its callers show the server's message and have no
      // extension fallback to offer.
      if ((error as { blocked?: boolean }).blocked === true && path.startsWith('/api/extract')) {
        throw new ExtractionBlockedError();
      }
      if ((error as { pdf?: boolean }).pdf === true && path.startsWith('/api/extract')) {
        throw new PdfExtractionError(
          (error as { error?: string }).error || 'Could not read that file',
          (error as { code?: string }).code === 'upgrade_required',
          (error as { format?: string }).format === 'epub' ? 'epub' : 'pdf'
        );
      }
      // An upload the server answered about (too large, not a PDF, unreadable,
      // already saved): its message is written for the reader.
      if (isUploadPath(path) && response.status < 500) {
        const b = error as { error?: string; message?: string; rkey?: string };
        throw new FileUploadError(
          b.message || b.error || `HTTP ${response.status}`,
          b.error || 'failed',
          b.rkey
        );
      }
      throw new ApiError(
        (error as { error: string }).error || `HTTP ${response.status}`,
        response.status,
        (error as { code?: string }).code
      );
    }

    return response.json() as Promise<T>;
  }

  // Auth
  // `frameRelayHash` starts a sign-in from inside a workspace frame
  // ($lib/workspace/frameSignIn.ts); the popup's callback then parks the session
  // for claimFrameSignIn instead of setting a cookie.
  async login(
    handle: string,
    returnUrl?: string,
    frameRelayHash?: string
  ): Promise<{ authUrl: string }> {
    const params = new URLSearchParams({ handle });
    if (returnUrl) params.set('returnUrl', returnUrl);
    if (frameRelayHash) params.set('frame_relay_hash', frameRelayHash);
    return this.fetch(`/api/auth/login?${params}`);
  }

  // Server-first sign-up: start OAuth against a provider's PDS/entryway host with
  // no account yet. The provider offers account creation, then redirects back here.
  async signup(
    pds: string,
    returnUrl?: string,
    frameRelayHash?: string
  ): Promise<{ authUrl: string }> {
    const params = new URLSearchParams({ pds });
    if (returnUrl) params.set('returnUrl', returnUrl);
    if (frameRelayHash) params.set('frame_relay_hash', frameRelayHash);
    return this.fetch(`/api/auth/login?${params}`);
  }

  // True once the framed sign-in behind `relay` has finished and its partitioned
  // session cookie is set; false while the popup is still signing in.
  async claimFrameSignIn(relay: string): Promise<boolean> {
    const { status } = await this.fetch<{ status: 'pending' | 'signed-in' }>(
      '/api/auth/frame-claim',
      { method: 'POST', body: JSON.stringify({ relay }) }
    );
    return status === 'signed-in';
  }

  // Progressive scopes: ask the provider for the permissions these features need
  // without signing out. Returns the consent URL to navigate to; the callback
  // swaps in the upgraded session and lands back on `returnUrl` (a same-origin
  // path). `features: []` re-grants the core permissions of an outdated session.
  async requestPermissions(features: ScopeFeature[], returnUrl?: string): Promise<string> {
    const { authUrl } = await this.fetch<{ authUrl: string }>('/api/auth/upgrade', {
      method: 'POST',
      body: JSON.stringify(returnUrl ? { features, returnUrl } : { features }),
    });
    return authUrl;
  }

  async logout(): Promise<void> {
    await this.fetch('/api/auth/logout', { method: 'POST' });
  }

  async getMe(): Promise<User> {
    return this.fetch('/api/auth/me');
  }

  // Feeds (V2 - via Fly.io proxy)
  // One feed's newest slice from the server-side archive. `refresh` forces the
  // backend to re-fetch it through the crawler first (the per-feed retry action).
  async fetchFeedV2(
    url: string,
    sinceGuids?: string[],
    limit?: number,
    refresh = false
  ): Promise<ParsedFeed> {
    const params = new URLSearchParams({ url });
    if (sinceGuids && sinceGuids.length > 0) {
      params.set('since_guids', sinceGuids.join(','));
    }
    if (limit) {
      params.set('limit', limit.toString());
    }
    if (refresh) {
      params.set('refresh', '1');
    }
    return this.fetch(`/api/v2/feeds/fetch?${params}`);
  }

  /**
   * One page of a feed's archive BELOW the local window.
   *
   * D1 never pruned anything, but each device only keeps the newest K per feed
   * and trims oldest-first — so an older unread item simply disappeared from the
   * only copy the reader could see, which reads as data loss. This is the read
   * that gets it back. Deliberately separate from `fetchFeedV2`: the result is a
   * transient archive view, never merged into the capped local set.
   */
  async fetchFeedArchive(url: string, offset: number, limit: number): Promise<ParsedFeed> {
    const params = new URLSearchParams({
      url,
      offset: String(offset),
      limit: String(limit),
    });
    return this.fetch(`/api/v2/feeds/fetch?${params}`);
  }

  /**
   * The whole feed refresh in one request: every new item across every
   * subscription, with read state already stamped on. `since_seq` + `generation`
   * are the client's global cursor into the server-side archive; `hasMore` drives
   * the drain loop. Replaces the per-subscription batch calls below.
   */
  async fetchTimeline(params: {
    since_seq?: number;
    generation?: string;
    limit?: number;
    cold_offset?: number;
    health_rev?: string;
    include_counts?: boolean;
  }): Promise<TimelineResponse> {
    const search = new URLSearchParams();
    if (params.since_seq !== undefined) search.set('since_seq', String(params.since_seq));
    if (params.generation) search.set('generation', params.generation);
    if (params.limit) search.set('limit', String(params.limit));
    if (params.cold_offset) search.set('cold_offset', String(params.cold_offset));
    if (params.health_rev) search.set('health_rev', params.health_rev);
    if (params.include_counts) search.set('include_counts', '1');
    const query = search.toString();
    return this.fetch(`/api/v2/timeline${query ? `?${query}` : ''}`);
  }

  /**
   * A long item's full body, stored out-of-row at ingest because it exceeded the
   * archive's inline cap (backend routes/item-bodies.ts). 404s (ApiError) when
   * the archive holds no copy. Guests use the rate-limited guest twin; it's the
   * same public archive content the guest timeline serves.
   */
  async fetchItemBody(
    feedUrl: string,
    guid: string,
    options: { guest: boolean }
  ): Promise<{ content: string }> {
    const params = new URLSearchParams({ feed_url: feedUrl, guid });
    return this.fetch(`/api/${options.guest ? 'guest' : 'v2'}/items/body?${params}`);
  }

  async fetchGuestTimeline(
    feedUrls: string[],
    params: { since_seq?: number; generation?: string; limit?: number; cold_offset?: number }
  ): Promise<TimelineResponse> {
    return this.fetch('/api/guest/timeline', {
      method: 'POST',
      body: JSON.stringify({ feedUrls, ...params }),
    });
  }

  async getStarterFeeds(): Promise<{ channels: StarterChannel[] }> {
    return this.fetch('/api/guest/starter-feeds');
  }

  async fetchFeedsBatchV2(
    feeds: Array<{
      url: string;
      since_guids?: string[];
      since_seq?: number;
      generation?: string;
      limit?: number;
    }>
  ): Promise<{
    feeds: Record<
      string,
      {
        title: string;
        description?: string;
        siteUrl?: string;
        imageUrl?: string;
        items: FeedItem[];
        status: 'ready' | 'error';
        error?: string;
        errorCount?: number;
        nextRetryAt?: number;
        lastFetchedAt?: number;
        // Durable-log cursor contract (RETENTION_SYNC_PLAN.md).
        cursor?: number;
        generation?: string;
        hasMore?: boolean;
      }
    >;
    // Server time (unix seconds) the response was read-annotated. The client
    // seeds its forward-read-delta cursor from this on its first annotated fetch.
    readCursor?: number;
  }> {
    return this.fetch('/api/v2/feeds/batch', {
      method: 'POST',
      body: JSON.stringify({ feeds }),
    });
  }

  async fetchDocumentsBatchV2(
    documents: Array<{ did: string; siteUri?: string; since_digest?: string }>
  ): Promise<DocumentsBatchV2Response> {
    const res = await this.fetch<DocumentsBatchV2Response>('/api/v2/documents/batch', {
      method: 'POST',
      body: JSON.stringify({ documents }),
    });
    for (const author of res.authors ?? []) {
      author.documents = author.documents?.map(undecorateLinkPostTitle);
    }
    return res;
  }

  // On-demand fetch of a single standard.site document by at:// URI — the in-app
  // reader path for a curated Collection piece the user doesn't subscribe to.
  // Returns null when the proxy can't resolve it.
  async fetchDocumentV2(uri: string): Promise<SocialDocument | null> {
    const res = await this.fetch<{ document?: SocialDocument }>(
      `/api/v2/documents/get?uri=${encodeURIComponent(uri)}`
    );
    return res.document ? undecorateLinkPostTitle(res.document) : null;
  }

  async discoverFeedsV2(url: string): Promise<{
    feeds: string[];
    standardSite?: {
      did: string;
      publicationUri: string;
      name: string;
      url?: string;
      description?: string;
      iconUrl?: string;
    } | null;
  }> {
    return this.fetch(`/api/v2/feeds/discover?url=${encodeURIComponent(url)}`);
  }

  // Feeds at the sites of people you follow: domain handles and bio links
  // (services/followSites.ts). At most 30 sites a call; answered in order.
  // `feeds` is null when the lookup failed and says nothing about the site.
  async discoverSites(
    sites: string[]
  ): Promise<{ results: Array<{ site: string; feeds: string[] | null }> }> {
    return this.fetch('/api/v2/feeds/discover-sites', {
      method: 'POST',
      body: JSON.stringify({ sites }),
    });
  }

  // Content detection
  async detectContent(did: string): Promise<{
    did: string;
    publications: Array<{
      uri: string;
      name: string;
      url: string;
      description?: string;
      iconUrl?: string;
    }>;
  }> {
    return this.fetch(`/api/social/detect-content?did=${encodeURIComponent(did)}`);
  }

  // Linkblog discovery (Phase 6)
  // Friends with linkblogs: people you follow on Bluesky who have one.
  async getLinkblogFriends(): Promise<{ people: LinkblogPerson[] }> {
    return this.fetch('/api/linkblog/discover/friends');
  }

  // The whole linkblog registry for /discover — friends first, then others.
  async getLinkblogDiscover(): Promise<{ people: LinkblogPerson[] }> {
    return this.fetch('/api/linkblog/discover');
  }

  // Subscriptions
  async createSubscription(data: {
    rkey: string;
    feedUrl?: string;
    title?: string;
    siteUrl?: string;
    category?: string;
    tags?: string[];
    source?: string;
    sourceType?: string;
    subjectDid?: string;
    collectionNsid?: string;
    /** Keep this feed off the PDS though Atmospheric sync is on. */
    keepPrivate?: boolean;
  }): Promise<{
    rkey: string;
    uri: string;
    /** The feed was already subscribed and active; nothing changed. */
    alreadySubscribed?: boolean;
    /** The feed was parked and has been reactivated in place, keeping its rkey. */
    reactivated?: boolean;
  }> {
    return this.fetch('/api/subscriptions', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateSubscription(
    rkey: string,
    updates: {
      customTitle?: string | null;
      customIconUrl?: string | null;
      category?: string | null;
    }
  ): Promise<{ success: boolean }> {
    return this.fetch(`/api/subscriptions/${rkey}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  }

  async deleteSubscription(rkey: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/subscriptions/${rkey}`, {
      method: 'DELETE',
    });
  }

  async bulkCreateSubscriptions(
    subscriptions: Array<{
      rkey: string;
      feedUrl: string;
      title?: string;
      siteUrl?: string;
      category?: string;
      source?: string;
    }>
    // `parked` lists rkeys held over the plan's active capacity — mirrored to the
    // account + PDS but not serviced. `skipped` lists rkeys dropped as duplicates
    // of a feed the user already has (active or parked). `dropped` lists rkeys over
    // the plan's mirror ceiling — not stored at all (but still on the PDS). Callers
    // should not add any of these to the reader's local cache.
  ): Promise<{
    results: Array<{ rkey: string; uri: string }>;
    parked?: string[];
    skipped?: string[];
    dropped?: string[];
  }> {
    return this.fetch('/api/subscriptions/bulk', {
      method: 'POST',
      body: JSON.stringify({ subscriptions }),
    });
  }

  async bulkUpdateSubscriptions(
    rkeys: string[],
    updates: {
      customTitle?: string | null;
      customIconUrl?: string | null;
      category?: string | null;
    }
  ): Promise<{ success: boolean; updated: number }> {
    return this.fetch('/api/subscriptions/bulk-update', {
      method: 'POST',
      body: JSON.stringify({ rkeys, updates }),
    });
  }

  async bulkDeleteSubscriptions(rkeys: string[]): Promise<{ success: boolean; deleted: number }> {
    return this.fetch('/api/subscriptions/bulk-delete', {
      method: 'POST',
      body: JSON.stringify({ rkeys }),
    });
  }

  // Parked feeds — PDS records over the plan's active capacity. Mirrored to the
  // account but not serviced or shown in the reader; listed/reactivated here.
  async getParkedSubscriptions(): Promise<{
    records: Array<{
      uri: string;
      cid: string;
      value: {
        $type: string;
        feedUrl: string;
        title: string | null;
        createdAt: string;
        sourceType?: string;
        subjectDid?: string;
        customTitle?: string;
        customIconUrl?: string;
        category?: string;
      };
    }>;
  }> {
    return this.fetch('/api/subscriptions/parked');
  }

  // Flip a subscription's local servicing state. Activating can 403 with
  // `subscription_limit_reached` when the plan's active slots are full.
  async activateSubscription(rkey: string): Promise<{ success: boolean; active: boolean }> {
    return this.fetch(`/api/subscriptions/${rkey}/activate`, { method: 'POST' });
  }

  async parkSubscription(rkey: string): Promise<{ success: boolean; active: boolean }> {
    return this.fetch(`/api/subscriptions/${rkey}/park`, { method: 'POST' });
  }

  // Linkblog — sharing as a portable site.standard.document (Phase 1)
  async createLinkblogShare(data: {
    rkey: string;
    articleUrl: string;
    articleTitle?: string;
    articleAuthor?: string;
    excerpt?: string;
    articleImage?: string;
    note?: string;
    tags?: string[];
    // Quote-reshare: the AT URI of the original link post being quoted.
    repostUri?: string;
    // Append the "Posted from skyreader.app" line to the post.
    attribution?: boolean;
  }): Promise<{ uri: string; cid: string; rkey: string; publication: string }> {
    return this.fetch('/api/linkblog/share', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async deleteLinkblogShare(rkey: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/linkblog/share/${rkey}`, {
      method: 'DELETE',
    });
  }

  // Update the note on an existing linkblog share (empty string clears it).
  async updateLinkblogShareNote(
    rkey: string,
    note: string
  ): Promise<{ uri: string; cid: string; rkey: string }> {
    return this.fetch(`/api/linkblog/share/${rkey}`, {
      method: 'PATCH',
      body: JSON.stringify({ note }),
    });
  }

  // Social context (Constellation) for link posts — how many posts quote this
  // one. Best-effort adornment; degrades to empty.
  async fetchSocialContext(
    items: Array<{ key?: string; docUri?: string }>
  ): Promise<{ items: SocialContextResult[] }> {
    return this.fetch('/api/v2/social-context', {
      method: 'POST',
      body: JSON.stringify({ items }),
    });
  }

  // Network-wide article mentions (Phase 5) — per-lane breakdown of who across
  // the Atmosphere referenced these URLs. Best-effort adornment; degrades to
  // empty per URL. The guest twin answers from the same handler without a
  // session (the data is public either way); callers pick by whether they have
  // one, since the /api/v2 path 401s without.
  async fetchArticleMentions(
    urls: string[],
    docUris?: Record<string, string>
  ): Promise<{ items: ArticleMentions[] }> {
    return this.fetch('/api/v2/mentions', {
      method: 'POST',
      body: JSON.stringify({ urls, ...(docUris ? { docUris } : {}) }),
    });
  }

  async fetchGuestArticleMentions(
    urls: string[],
    docUris?: Record<string, string>
  ): Promise<{ items: ArticleMentions[] }> {
    return this.fetch('/api/guest/mentions', {
      method: 'POST',
      body: JSON.stringify({ urls, ...(docUris ? { docUris } : {}) }),
    });
  }

  // The people inside one lane (Phase 5 "see existing items") — who referenced
  // this URL via that lane, with their note + a link out. Lazily fetched when a
  // lane is expanded. Best-effort adornment; degrades to an empty list.
  async fetchMentionLaneItems(
    url: string,
    lane: string,
    docUri?: string
  ): Promise<{ entries: MentionLaneEntry[]; sembleContext?: SembleContext }> {
    return this.fetch('/api/v2/mention-lane', {
      method: 'POST',
      body: JSON.stringify({ url, lane, ...(docUri ? { docUri } : {}) }),
    });
  }

  async fetchGuestMentionLaneItems(
    url: string,
    lane: string,
    docUri?: string
  ): Promise<{ entries: MentionLaneEntry[]; sembleContext?: SembleContext }> {
    return this.fetch('/api/guest/mention-lane', {
      method: 'POST',
      body: JSON.stringify({ url, lane, ...(docUri ? { docUri } : {}) }),
    });
  }

  // What other readers highlighted in this article, from Margin's public records
  // through the proxy's cache. Public either way; the guest twin exists because
  // the /api/v2 path is session-gated (see fetchArticleMentions).
  async fetchCommunityHighlights(
    url: string
  ): Promise<{ notes: CommunityHighlightNote[]; capped: boolean }> {
    return this.fetch('/api/v2/margin-highlights', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
  }

  async fetchGuestCommunityHighlights(
    url: string
  ): Promise<{ notes: CommunityHighlightNote[]; capped: boolean }> {
    return this.fetch('/api/guest/margin-highlights', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
  }

  async getLinkblogPublication(): Promise<LinkblogPublication> {
    return this.fetch('/api/linkblog/publication');
  }

  async updateLinkblogPublication(data: {
    name?: string;
    description?: string;
  }): Promise<LinkblogPublication> {
    return this.fetch('/api/linkblog/publication', {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async deleteLinkblog(): Promise<{ success: true; deletedPosts: number }> {
    return this.fetch('/api/linkblog/publication', { method: 'DELETE' });
  }

  async restoreLinkblog(): Promise<LinkblogPublication> {
    return this.fetch('/api/linkblog/publication', { method: 'POST' });
  }

  async listLinkblogPublications(): Promise<{
    publications: import('$lib/types').LinkblogPublicationChoice[];
  }> {
    return this.fetch('/api/linkblog/publications');
  }

  async connectLinkblogPublication(
    publicationUri: string,
    format: LinkblogPublication['format']
  ): Promise<LinkblogPublication> {
    return this.fetch('/api/linkblog/publication/connect', {
      method: 'PUT',
      body: JSON.stringify({ publicationUri, format }),
    });
  }

  async disconnectLinkblogPublication(): Promise<LinkblogPublication> {
    return this.fetch('/api/linkblog/publication/connect', { method: 'DELETE' });
  }

  // Whether Skyreader serves the public linkblog page. Only accepted while a
  // publication is connected — otherwise that page is the only public address the
  // links have, and the backend refuses.
  async setLinkblogPageHidden(pageHidden: boolean): Promise<LinkblogPublication> {
    return this.fetch('/api/linkblog/publication/visibility', {
      method: 'PUT',
      body: JSON.stringify({ pageHidden }),
    });
  }

  // How this user's link posts are written on other people's sites: the title
  // decoration and where the article's link card sits. Partial updates are fine;
  // the response is the refreshed publication meta.
  async setLinkblogFormatting(
    formatting: Partial<LinkblogPublication['formatting']>
  ): Promise<LinkblogPublication> {
    return this.fetch('/api/linkblog/formatting', {
      method: 'PUT',
      body: JSON.stringify(formatting),
    });
  }

  // Subscribe via the Atmosphere — writes/reads/deletes only the portable
  // site.standard.graph.subscription record (no Skyreader subscription).
  async getAtmosphereSubscription(publication: string): Promise<{ subscribed: boolean }> {
    return this.fetch(
      `/api/atmosphere/subscription?publication=${encodeURIComponent(publication)}`
    );
  }

  async subscribeAtmosphere(publication: string): Promise<{ subscribed: boolean; uri?: string }> {
    return this.fetch('/api/atmosphere/subscription', {
      method: 'POST',
      body: JSON.stringify({ publication }),
    });
  }

  async unsubscribeAtmosphere(publication: string): Promise<{ subscribed: boolean }> {
    return this.fetch('/api/atmosphere/subscription', {
      method: 'DELETE',
      body: JSON.stringify({ publication }),
    });
  }

  // List records (still used for syncFromBackend)
  async listRecords<T>(collection: string): Promise<{
    records: Array<{ uri: string; cid: string; value: T }>;
  }> {
    return this.fetch(`/api/records/list?collection=${encodeURIComponent(collection)}`);
  }

  // Reading (forward read delta)
  // Pass `since` (a previously returned cursor) for an incremental delta fetch.
  // The response carries every `read` row changed since the cursor — live rows
  // AND tombstones (deleted=true) — across articles and documents. Bootstrap read
  // state arrives via inline annotation on the fetch response, not here, so this
  // is always a delta. Returns the new cursor to send next time.
  // `since` is the opaque compound cursor (`nextSince` from the previous call);
  // a legacy numeric cursor is still accepted by the backend. Pages are bounded
  // now — drain while `hasMore`, and only persist `nextSince` once the batch is
  // durable, or a failed write loses rows the cursor has already moved past.
  async getReadPositions(since?: number | string): Promise<{
    positions: Array<{
      item_guid: string;
      item_type: 'article' | 'document';
      read_at: number | string | null;
      rkey: string | null;
      deleted: boolean;
      client_updated_at?: number | null;
    }>;
    cursor: number;
    nextSince?: string;
    hasMore?: boolean;
  }> {
    const params = since ? `?since=${encodeURIComponent(String(since))}` : '';
    return this.fetch(`/api/reading/positions${params}`);
  }

  async markAsRead(data: {
    itemGuid: string;
    itemType?: 'article' | 'document';
    itemUrl?: string;
    itemTitle?: string;
    rkey?: string;
    authorDid?: string;
    // When the USER acted, unix ms — the last-write-wins key. Without it the
    // server falls back to arrival time, which is what let a late queue drain
    // resurrect stale intent.
    updatedAt?: number;
  }): Promise<{ success: boolean; rkey?: string; alreadyRead?: boolean }> {
    return this.fetch('/api/reading/mark-read', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async markAsUnread(itemGuid: string, updatedAt?: number): Promise<{ success: boolean }> {
    return this.fetch('/api/reading/mark-unread', {
      method: 'POST',
      body: JSON.stringify({ itemGuid, updatedAt }),
    });
  }

  async markAsReadBulk(
    items: Array<{
      itemGuid: string;
      itemType?: 'article' | 'document';
      itemUrl?: string;
      itemTitle?: string;
      rkey?: string;
      authorDid?: string;
      updatedAt?: number;
    }>,
    updatedAt?: number
  ): Promise<{ success: boolean; marked: number; skipped: number }> {
    return this.fetch('/api/reading/mark-read-bulk', {
      method: 'POST',
      body: JSON.stringify({ items, updatedAt }),
    });
  }

  /**
   * Mark a feed's canonical window read on the SERVER.
   *
   * The client-side loop could only mark what this device happened to hold, so
   * items another device held below this device's window stayed unread there.
   * Omit `feedUrl` for every subscribed feed. `beforeSeq` is the archive head
   * the client saw, so anything ingested after the press stays unread.
   */
  async markFeedRead(options: {
    feedUrl?: string;
    beforeSeq?: number;
    updatedAt?: number;
  }): Promise<{ success: boolean; marked: number }> {
    return this.fetch('/api/reading/mark-feed-read', {
      method: 'POST',
      body: JSON.stringify(options),
    });
  }

  // Labels (unified item labels API)
  async getLabels(
    options: {
      label?: string;
      labels?: string[];
      itemType?: ItemLabelType;
      cursor?: string;
      limit?: number;
      since?: number | string;
    } = {}
  ): Promise<{
    labels: Array<{
      itemKey: string;
      itemType: string;
      label: string;
      props: Record<string, unknown>;
      rkey?: string;
      createdAt: number;
      updatedAt: number;
      // Tombstone marker: set (unix seconds) when the label was deleted; only
      // appears in delta (`since`) responses. Live snapshots never include it.
      deletedAt?: number | null;
      // When the USER made this change, unix ms. Absent on an older backend.
      clientUpdatedAt?: number | null;
    }>;
    cursor?: string;
    // The compound delta cursor to persist once this batch is durable — the
    // last row DELIVERED, never a clock reading. Delta responses only.
    nextSince?: string;
    hasMore?: boolean;
  }> {
    const params = new URLSearchParams();
    if (options.label) params.set('label', options.label);
    if (options.labels?.length) params.set('labels', options.labels.join(','));
    if (options.itemType) params.set('itemType', options.itemType);
    if (options.cursor) params.set('cursor', options.cursor);
    if (options.limit) params.set('limit', String(options.limit));
    if (options.since !== undefined) params.set('since', String(options.since));
    const query = params.toString();
    return this.fetch(`/api/labels${query ? `?${query}` : ''}`);
  }

  /**
   * Drain every page of a labels fetch.
   *
   * Returns the rows AND the compound cursor to persist. The caller must only
   * persist that cursor once the rows are durable locally — the whole point of
   * the compound form is that a cursor can never sit past a row the client
   * never applied.
   */
  async getAllLabels(
    options: {
      label?: string;
      labels?: string[];
      itemType?: ItemLabelType;
      since?: number | string;
    } = {}
  ): Promise<{ labels: LabelRowDTO[]; nextSince?: string }> {
    const all: LabelRowDTO[] = [];
    let cursor: string | undefined;
    let nextSince: string | undefined;
    do {
      // Use the backend max page size to minimise round-trips when paginating.
      const response = await this.getLabels({ ...options, cursor, limit: 500 });
      all.push(...response.labels);
      cursor = response.cursor;
      if (response.nextSince) nextSince = response.nextSince;
    } while (cursor);
    return { labels: all, nextSince };
  }

  async addLabel(data: {
    itemKey: string;
    itemType: ItemLabelType;
    label: string;
    props?: Record<string, unknown>;
    updatedAt?: number;
    // 'merge' unions highlights into what the account already holds instead of
    // replacing the array. Only for writes made in guest mode — see
    // syncHighlightsToBackend.
    mode?: 'replace' | 'merge';
  }): Promise<{ success: boolean }> {
    return this.fetch('/api/labels', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async deleteLabel(
    itemKey: string,
    label: string,
    updatedAt?: number
  ): Promise<{ success: boolean }> {
    return this.fetch('/api/labels', {
      method: 'DELETE',
      body: JSON.stringify({ itemKey, label, updatedAt }),
    });
  }

  // --- Semble connections off saves (routes/saved-connections.ts) ---

  async getSavedConnections(): Promise<{ items: SavedConnectionActivity[] }> {
    return this.fetch('/api/saved/connections');
  }

  async markSavedConnectionsSeen(rkey: string): Promise<{ success: boolean }> {
    return this.fetch('/api/saved/connections/seen', {
      method: 'POST',
      body: JSON.stringify({ rkey }),
    });
  }

  // --- The notification bell (routes/notifications.ts, routes/updates.ts) ---

  async getNotificationSeen(): Promise<{ ids: string[]; primed: boolean }> {
    return this.fetch('/api/notifications/seen');
  }

  async markNotificationsSeen(ids: string[], primed = false): Promise<{ success: boolean }> {
    return this.fetch('/api/notifications/seen', {
      method: 'POST',
      body: JSON.stringify(primed ? { ids, primed } : { ids }),
    });
  }

  async getUpdates(): Promise<{ updates: DevLogUpdate[] }> {
    return this.fetch('/api/updates');
  }

  // --- Shelf collections (routes/shelf.ts) ---

  async getShelfCollections(): Promise<{ collections: ShelfCollection[] }> {
    return this.fetch('/api/shelf/collections');
  }

  async createShelfCollection(data: {
    id: string;
    name: string;
    description?: string | null;
  }): Promise<{ success: boolean; id: string }> {
    return this.fetch('/api/shelf/collections', { method: 'POST', body: JSON.stringify(data) });
  }

  async updateShelfCollection(
    id: string,
    data: { name?: string; description?: string | null; position?: number; pinned?: boolean }
  ): Promise<{ success: boolean }> {
    return this.fetch(`/api/shelf/collections/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async deleteShelfCollection(id: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/shelf/collections/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async addToShelfCollection(id: string, rkey: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/shelf/collections/${encodeURIComponent(id)}/items`, {
      method: 'POST',
      body: JSON.stringify({ rkey }),
    });
  }

  async removeFromShelfCollection(id: string, rkey: string): Promise<{ success: boolean }> {
    return this.fetch(
      `/api/shelf/collections/${encodeURIComponent(id)}/items/${encodeURIComponent(rkey)}`,
      { method: 'DELETE' }
    );
  }

  /** Add several saves at once, in order. All or nothing past the 2,000-item cap. */
  async addManyToShelfCollection(
    id: string,
    rkeys: string[]
  ): Promise<{ success: boolean; added: number }> {
    return this.fetch(`/api/shelf/collections/${encodeURIComponent(id)}/items`, {
      method: 'POST',
      body: JSON.stringify({ rkeys }),
    });
  }

  async removeManyFromShelfCollection(id: string, rkeys: string[]): Promise<{ success: boolean }> {
    return this.fetch(`/api/shelf/collections/${encodeURIComponent(id)}/items`, {
      method: 'DELETE',
      body: JSON.stringify({ rkeys }),
    });
  }

  /** Set the order of the collections themselves (their ids, top first). */
  async reorderShelfCollections(ids: string[]): Promise<{ success: boolean }> {
    return this.fetch('/api/shelf/collections', {
      method: 'PUT',
      body: JSON.stringify({ ids }),
    });
  }

  /** Keep a collection in step with one of the reader's Semble/Margin collections
   *  (a new one named after it when `collectionUri` is left out). */
  async linkShelfCollection(
    id: string,
    // `deferSync`: save the link and answer at once; the first sync is the
    // caller's to run (syncShelfCollection). `sync` is then null.
    data: { provider: 'semble' | 'margin'; collectionUri?: string; deferSync?: boolean }
  ): Promise<{ success: boolean; link: ShelfCollectionLink; sync: ShelfLinkSync | null }> {
    return this.fetch(`/api/shelf/collections/${encodeURIComponent(id)}/link`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async unlinkShelfCollection(id: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/shelf/collections/${encodeURIComponent(id)}/link`, {
      method: 'DELETE',
    });
  }

  async syncShelfCollection(id: string, force = false): Promise<ShelfLinkSync> {
    return this.fetch(`/api/shelf/collections/${encodeURIComponent(id)}/sync`, {
      method: 'POST',
      body: JSON.stringify({ force }),
    });
  }

  async reorderShelfCollection(id: string, rkeys: string[]): Promise<{ success: boolean }> {
    return this.fetch(`/api/shelf/collections/${encodeURIComponent(id)}/items`, {
      method: 'PUT',
      body: JSON.stringify({ rkeys }),
    });
  }

  async bulkAddLabels(
    labels: Array<{
      itemKey: string;
      itemType: ItemLabelType;
      label: string;
      props?: Record<string, unknown>;
      updatedAt?: number;
    }>
  ): Promise<{ success: boolean; added: number }> {
    return this.fetch('/api/labels/bulk', {
      method: 'POST',
      body: JSON.stringify({ labels }),
    });
  }

  // Magazines (durable, cross-device reading issues)
  async getMagazines(
    options: { since?: number; cursor?: string; limit?: number } = {}
  ): Promise<{ magazines: Magazine[]; cursor?: string }> {
    const params = new URLSearchParams();
    if (options.since !== undefined) params.set('since', String(options.since));
    if (options.cursor) params.set('cursor', options.cursor);
    if (options.limit) params.set('limit', String(options.limit));
    const query = params.toString();
    return this.fetch(`/api/magazines${query ? `?${query}` : ''}`);
  }

  // Paginate the full magazine set (or delta when `since` is given).
  async getAllMagazines(options: { since?: number } = {}): Promise<Magazine[]> {
    const all: Magazine[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.getMagazines({ ...options, cursor, limit: 500 });
      all.push(...response.magazines);
      cursor = response.cursor;
    } while (cursor);
    return all;
  }

  async upsertMagazine(data: {
    rkey: string;
    params: MagazineParams;
    items: MagazineItemSnapshot[];
    position?: MagazinePosition | null;
    title?: string | null;
  }): Promise<{ success: boolean; rkey: string }> {
    return this.fetch('/api/magazines', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateMagazinePosition(
    rkey: string,
    position: MagazinePosition | null
  ): Promise<{ success: boolean }> {
    return this.fetch('/api/magazines/position', {
      method: 'PATCH',
      body: JSON.stringify({ rkey, position }),
    });
  }

  async deleteMagazine(rkey: string): Promise<{ success: boolean }> {
    return this.fetch('/api/magazines', {
      method: 'DELETE',
      body: JSON.stringify({ rkey }),
    });
  }

  // Billing (Polar). Products come from the Polar dashboard via the backend, so
  // prices are authored in exactly one place. The backend owns the checkout
  // product default; pass a product id only to override it. The returned url is
  // Polar's hosted checkout — navigate to it top-level, same shape as the OAuth
  // login redirect.
  async getBillingProducts(): Promise<{ products: BillingProduct[] }> {
    return this.fetch('/api/billing/products');
  }

  async getFeedbackBoard(): Promise<FeedbackBoard> {
    return this.fetch('/api/v2/feedback');
  }

  // The caller's own posts, for the notification inbox's poll. Session-only and
  // never cached in the browser: the whole point is to see a change land.
  async getMyFeedback(): Promise<{ posts: MyFeedbackPost[] }> {
    return this.fetch('/api/v2/feedback/mine');
  }

  // The replies on one post, addressed by its author's DID and record key (both
  // read off the post's `at://` uri). Fetched when a reader expands a post
  // rather than with the board: the board is one request for every post, and a
  // thread is one request each.
  async getFeedbackThread(
    did: string,
    rkey: string
  ): Promise<{ total: number; complete: boolean; replies: FeedbackReply[] }> {
    const qs = `did=${encodeURIComponent(did)}&rkey=${encodeURIComponent(rkey)}`;
    return this.fetch(`/api/v2/feedback/thread?${qs}`);
  }

  // Posting writes an app.userinput.discussion record to the reader's own repo,
  // so it needs a session with the userinput scope — a session that predates it
  // throws ScopeUpgradeError, which the page turns into an "Allow access" prompt
  // rather than losing what they wrote. The response's `upvoted` says whether the
  // self-upvote that follows the post landed — it doesn't when the session lacks
  // the separate vote scope, or when the PDS refuses that second write — so the
  // caller can show the count the board will actually have.
  async createFeedbackPost(input: {
    title: string;
    body?: string;
    tags?: string[];
    images?: FeedbackImage[];
  }): Promise<{
    uri: string;
    cid: string;
    url: string;
    createdAt: string;
    upvoted?: boolean;
  }> {
    return this.fetch('/api/v2/feedback', { method: 'POST', body: JSON.stringify(input) });
  }

  // One attachment's bytes, sent raw under the file's own content type (this is
  // com.atproto.repo.uploadBlob's shape, not a multipart form). The blob lands in
  // the reader's own repo and is unreferenced — and so collectable — until the
  // post that embeds it is written, which is why an abandoned draft costs
  // nothing. Needs the blob scope, so it can throw ScopeUpgradeError on a session
  // that can post but not attach.
  async uploadFeedbackImage(file: File): Promise<{ blob: FeedbackBlobRef }> {
    return this.fetch('/api/v2/feedback/image', {
      method: 'POST',
      body: file,
      headers: { 'Content-Type': file.type },
    });
  }

  // Also posting a linkblog share to Bluesky. A text shot goes up first, raw
  // under its own content type, and the post that embeds it is written after.
  // Both need the 'blueskyPost' permission and throw ScopeUpgradeError without it.
  async uploadBlueskyImage(image: Blob): Promise<{ blob: FeedbackBlobRef }> {
    return this.fetch('/api/v2/bluesky/image', {
      method: 'POST',
      body: image,
      headers: { 'Content-Type': image.type },
    });
  }

  async createBlueskyPost(input: {
    text: string;
    articleUrl: string;
    /** Where the article's (shortened) link sits in `text`; required with images. */
    linkText?: string;
    title?: string;
    description?: string;
    imageUrl?: string;
    /** The post's languages (BCP-47), for Bluesky's feeds and search. */
    langs?: string[];
    images?: Array<{
      image: FeedbackBlobRef;
      alt: string;
      aspectRatio: { width: number; height: number };
    }>;
  }): Promise<{ uri: string; cid: string; url: string }> {
    return this.fetch('/api/v2/bluesky/post', { method: 'POST', body: JSON.stringify(input) });
  }

  // The reader's newsletter inbox (a Supporter feature). `enabled` is false
  // where the backend has no inbound mail domain configured.
  // Full-text search over what the reader has read, saved and highlighted
  // (Supporter; backend/src/routes/search.ts).
  async search(params: {
    q: string;
    kinds?: SearchKind[];
    limit?: number;
    offset?: number;
    signal?: AbortSignal;
  }): Promise<SearchResponse> {
    const query = new URLSearchParams({ q: params.q });
    if (params.kinds?.length) query.set('kind', params.kinds.join(','));
    if (params.limit) query.set('limit', String(params.limit));
    if (params.offset) query.set('offset', String(params.offset));
    return this.fetch(`/api/search?${query}`, { signal: params.signal });
  }

  async getNewsletters(): Promise<NewsletterInbox> {
    return this.fetch('/api/newsletters');
  }

  // Issue the reader's address, or replace it with a fresh one (`rotate`):
  // the old address stops accepting mail, received newsletters stay.
  async issueNewsletterAddress(rotate = false): Promise<{ address: string }> {
    return this.fetch('/api/newsletters/address', {
      method: 'POST',
      body: JSON.stringify({ rotate }),
    });
  }

  // Let a sender blocked by removing its newsletter reach the inbox again.
  async unblockNewsletterSender(sender: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/newsletters/blocked?sender=${encodeURIComponent(sender)}`, {
      method: 'DELETE',
    });
  }

  // App passwords for other RSS apps syncing over the Google Reader API.
  async getAppPasswords(): Promise<AppPasswordList> {
    return this.fetch('/api/app-passwords');
  }

  // The password comes back in the clear this once; only its hash is kept.
  async createAppPassword(name: string): Promise<{ id: number; name: string; password: string }> {
    return this.fetch('/api/app-passwords', { method: 'POST', body: JSON.stringify({ name }) });
  }

  async revokeAppPassword(id: number): Promise<{ success: boolean }> {
    return this.fetch(`/api/app-passwords/${id}`, { method: 'DELETE' });
  }

  async getZotero(): Promise<ZoteroStatus> {
    return this.fetch('/api/zotero');
  }

  async connectZotero(apiKey: string): Promise<ZoteroStatus> {
    return this.fetch('/api/zotero', { method: 'POST', body: JSON.stringify({ apiKey }) });
  }

  async setZoteroScope(
    scope: 'everything' | 'collections',
    collections: string[]
  ): Promise<ZoteroStatus> {
    return this.fetch('/api/zotero', {
      method: 'PATCH',
      body: JSON.stringify({ scope, collections }),
    });
  }

  async syncZotero(): Promise<{ started: boolean }> {
    return this.fetch('/api/zotero/sync', { method: 'POST' });
  }

  async disconnectZotero(): Promise<{ success: boolean }> {
    return this.fetch('/api/zotero', { method: 'DELETE' });
  }

  async createCheckout(productId?: string): Promise<{ url: string }> {
    const qs = productId ? `?products=${encodeURIComponent(productId)}` : '';
    return this.fetch(`/api/billing/checkout${qs}`, { method: 'POST' });
  }

  // Polar's hosted customer portal (invoices, plan changes, cancellation),
  // as a short-lived signed URL. 404s for a supporter Polar has never seen
  // (admin-granted tiers) — callers fall back to the receipt-email framing.
  async createBillingPortal(): Promise<{ url: string }> {
    return this.fetch('/api/billing/portal', { method: 'POST' });
  }

  // The active subscription behind the user's tier, straight from Polar.
  // Null for anyone whose tier didn't come through a Polar subscription, so
  // callers render nothing rather than an error.
  async getBillingSubscription(): Promise<{ subscription: BillingSubscription | null }> {
    return this.fetch('/api/billing/subscription');
  }

  // Share drafts (unposted linkblog shares, private to the account)
  async getShareDrafts(
    options: { since?: number; cursor?: string; limit?: number } = {}
  ): Promise<{ drafts: RemoteShareDraft[]; cursor?: string }> {
    const params = new URLSearchParams();
    if (options.since !== undefined) params.set('since', String(options.since));
    if (options.cursor) params.set('cursor', options.cursor);
    if (options.limit) params.set('limit', String(options.limit));
    const query = params.toString();
    return this.fetch(`/api/linkblog/drafts${query ? `?${query}` : ''}`);
  }

  // Paginate the full draft set (or delta when `since` is given).
  async getAllShareDrafts(options: { since?: number } = {}): Promise<RemoteShareDraft[]> {
    const all: RemoteShareDraft[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.getShareDrafts({ ...options, cursor, limit: 500 });
      all.push(...response.drafts);
      cursor = response.cursor;
    } while (cursor);
    return all;
  }

  async upsertShareDraft(draft: ShareDraft): Promise<{ success: boolean; articleUrl: string }> {
    return this.fetch('/api/linkblog/drafts', {
      method: 'PUT',
      body: JSON.stringify({
        articleUrl: draft.articleUrl,
        draft,
        updatedAt: draft.updatedAt,
      }),
    });
  }

  async deleteShareDraft(articleUrl: string, updatedAt: number): Promise<{ success: boolean }> {
    return this.fetch('/api/linkblog/drafts', {
      method: 'DELETE',
      body: JSON.stringify({ articleUrl, updatedAt }),
    });
  }

  // Settings
  async getSettings(): Promise<{
    pdsSyncEnabled: boolean;
    lastPdsSyncSubscriptions: number | null;
    backing: SaveBacking;
    lastSuccessfulBackingPoll: number | null;
    linkblogDisabled: boolean;
    createdAt: number;
    updatedAt: number;
  }> {
    return this.fetch('/api/settings');
  }

  async updateSettings(settings: { pdsSyncEnabled?: boolean }): Promise<{
    pdsSyncEnabled: boolean;
    lastPdsSyncSubscriptions: number | null;
    backing: SaveBacking;
    createdAt: number;
    updatedAt: number;
  }> {
    return this.fetch('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    });
  }

  /**
   * Turn external-backed saves on or off (Phase 5). Enable backs the Saved list
   * with a Semble/Margin collection (creating a default "Skyreader Saves" if no
   * collectionUri is given) and optionally exports existing saves into it. A 403
   * scope_upgrade_required (caught by the fetch wrapper) means the provider scopes
   * must be re-granted via login.
   */
  async setBacking(
    body:
      | {
          action: 'enable';
          provider: 'semble' | 'margin';
          collectionUri?: string;
          exportExisting?: boolean;
        }
      | { action: 'disable' }
  ): Promise<{ backing: SaveBacking; exported?: number }> {
    return this.fetch('/api/saved/backing', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * The background copy of saves into the reader's backing collection:
   * `copyLibrary` queues every save not in it yet, `pauseCopy` / `resumeCopy`
   * pause and resume it, `copyStatus` only asks (and restarts a copy that had
   * stopped, since the reader is back). `copy` is null when no copy is under
   * way; `uncopied` then counts the saves not in the collection.
   */
  async backingCopy(
    action: 'copyLibrary' | 'copyStatus' | 'pauseCopy' | 'resumeCopy'
  ): Promise<{ copy: BackingCopyStatus | null; uncopied: number }> {
    return this.fetch('/api/saved/backing', {
      method: 'POST',
      body: JSON.stringify({ action }),
    });
  }

  // Integrations
  async getIntegrationStatus(): Promise<IntegrationStatus> {
    return this.fetch('/api/integrations/status');
  }

  async createSembleCard(data: {
    url: string;
    title?: string;
    description?: string;
    author?: string;
    publishedAt?: string;
    collections?: { uri: string; cid: string }[];
  }): Promise<{
    uri: string;
    cid: string;
    collectionResults?: { uri: string; error?: string }[];
  }> {
    return this.fetch('/api/integrations/semble/cards', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async listSembleCards(): Promise<{ cards: SembleCard[]; truncated: boolean }> {
    return this.fetch('/api/integrations/semble/cards');
  }

  /**
   * Draw a Semble connection: a typed edge from `source` to `target`, written to
   * the reader's own PDS. Online-only — a connection is a deliberate act on live
   * context, so there's no queued variant. A session without the connection
   * scope gets a 403 the shared fetch wrapper turns into `ScopeUpgradeError`
   * (and the global re-login banner).
   */
  async createSembleConnection(data: {
    source: string;
    target: string;
    connectionType?: SembleConnectionType;
    note?: string;
  }): Promise<{ uri: string; cid: string; rkey: string }> {
    return this.fetch('/api/integrations/semble/connections', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async listSembleCollections(): Promise<{ collections: SembleCollection[]; truncated?: boolean }> {
    return this.fetch('/api/integrations/semble/collections');
  }

  async createMarginBookmark(data: {
    url: string;
    title?: string;
    description?: string;
    collectionUris?: string[];
  }): Promise<{
    uri: string;
    cid: string;
    collectionResults?: { uri: string; error?: string }[];
  }> {
    return this.fetch('/api/integrations/margin/bookmarks', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async listMarginCollections(): Promise<{ collections: MarginCollection[]; truncated?: boolean }> {
    return this.fetch('/api/integrations/margin/collections');
  }

  /** Which collections this URL is already saved to (read live from the PDS). */
  async getIntegrationMemberships(
    integration: 'semble' | 'margin',
    url: string
  ): Promise<IntegrationMemberships> {
    return this.fetch(
      `/api/integrations/${integration}/memberships?url=${encodeURIComponent(url)}`
    );
  }

  /**
   * Apply a collection-membership diff for an already-saved URL. Removals delete
   * only the membership records — the card/note itself always stays.
   */
  async editIntegrationMemberships(
    integration: 'semble' | 'margin',
    data: {
      url: string;
      add: { uri: string; cid?: string }[];
      remove: string[];
      title?: string;
      description?: string;
      author?: string;
      publishedAt?: string;
    }
  ): Promise<IntegrationMembershipEditResult> {
    return this.fetch(`/api/integrations/${integration}/memberships`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  /**
   * The user's own Margin highlights, matched against their saves server-side,
   * plus the rkey of every note record listed (`rkeys`) and whose repo was read
   * (`did`) and when, by the server's clock (`listedAt`). All three are absent
   * from an older backend.
   */
  async listMarginHighlights(): Promise<{
    notes: MarginHighlightNote[];
    truncated: boolean;
    rkeys?: string[];
    did?: string;
    listedAt?: number;
  }> {
    return this.fetch('/api/integrations/margin/highlights');
  }

  async createMarginNote(data: {
    source: string;
    title?: string;
    exact: string;
    prefix?: string;
    suffix?: string;
    note?: string;
  }): Promise<{ uri: string; cid: string; rkey: string }> {
    return this.fetch('/api/integrations/margin/notes', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateMarginNote(
    rkey: string,
    data: {
      source: string;
      title?: string;
      exact: string;
      prefix?: string;
      suffix?: string;
      note?: string;
    }
  ): Promise<{ uri: string; cid: string; rkey: string }> {
    // Tracked so the Margin highlight sync can't read this write's old record
    // back over it (see marginWrites.ts).
    const settle = trackMarginWrite(rkey);
    try {
      return await this.fetch(`/api/integrations/margin/notes/${encodeURIComponent(rkey)}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    } finally {
      settle();
    }
  }

  async deleteMarginNote(rkey: string): Promise<{ success: boolean }> {
    const settle = trackMarginWrite(rkey);
    try {
      return await this.fetch(`/api/integrations/margin/notes/${encodeURIComponent(rkey)}`, {
        method: 'DELETE',
      });
    } finally {
      settle();
    }
  }

  // Extract article content via the proxy (fetch + Defuddle, cached proxy-side).
  // Routes through this.fetch so it shares the 503-retry / 401-logout handling
  // (previously a raw fetch here logged users out on any 401, bypassing that logic).
  async extract(url: string): Promise<ExtractedArticle> {
    return this.fetch<ExtractedArticle>('/api/extract', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
  }

  // Reading Rooms (spike) — see docs/plans/READING_ROOMS_SPIKE.md
  async getRoom(uri: string): Promise<RoomInfo> {
    return this.fetch(`/api/rooms?uri=${encodeURIComponent(uri)}`);
  }

  /** Start a room: a new collection in the user's own repo, joined on the way
   *  out. `joined: false` means the collection exists but the join write
   *  failed; the room page offers Join as usual. */
  async createRoom(room: {
    name: string;
    description?: string;
    provider?: 'semble' | 'margin';
    access?: 'open' | 'closed';
  }): Promise<{
    uri: string;
    provider: 'semble' | 'margin';
    name: string;
    description?: string;
    access: 'open' | 'closed';
    joined: boolean;
  }> {
    return this.fetch('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({
        name: room.name,
        description: room.description || undefined,
        provider: room.provider,
        access: room.access,
      }),
    });
  }

  async getRoomJoined(uri: string): Promise<{ joined: boolean }> {
    return this.fetch(`/api/rooms/join?uri=${encodeURIComponent(uri)}`);
  }

  async joinRoom(collectionUri: string, rkey: string): Promise<{ joined: boolean; uri: string }> {
    return this.fetch('/api/rooms/join', {
      method: 'POST',
      body: JSON.stringify({ collectionUri, rkey }),
    });
  }

  async leaveRoom(collectionUri: string): Promise<{ joined: boolean }> {
    return this.fetch('/api/rooms/join', {
      method: 'DELETE',
      body: JSON.stringify({ collectionUri }),
    });
  }

  // Recommends — one-tap public recommendations (app.skyreader.social.recommend)
  async getRecommends(): Promise<{
    recommends: Array<{ url: string; title?: string; documentUri?: string; createdAt: string }>;
  }> {
    return this.fetch('/api/recommends');
  }

  async recommend(data: {
    url: string;
    title?: string;
    documentUri?: string;
  }): Promise<{ recommended: boolean; uri?: string }> {
    return this.fetch('/api/recommends', { method: 'POST', body: JSON.stringify(data) });
  }

  async unrecommend(url: string): Promise<{ recommended: boolean }> {
    return this.fetch('/api/recommends', { method: 'DELETE', body: JSON.stringify({ url }) });
  }

  /** Add an article to a room's collection. Metadata is optional: pass what the
   *  library already knows, and the backend extracts a title for a bare URL. */
  async addRoomItem(
    collectionUri: string,
    article: {
      url: string;
      title?: string | null;
      description?: string | null;
      author?: string | null;
      publishedAt?: string | null;
    }
  ): Promise<{ item: RoomItem }> {
    return this.fetch('/api/rooms/items', {
      method: 'POST',
      body: JSON.stringify({
        collectionUri,
        url: article.url,
        title: article.title ?? undefined,
        description: article.description ?? undefined,
        author: article.author ?? undefined,
        publishedAt: article.publishedAt ?? undefined,
      }),
    });
  }

  // From your follows — see docs/plans/FOLLOWS_LINKS_PLAN.md. The read answers
  // `scopeRequired` (200) rather than a 403 until the reader has granted the
  // getTimeline permission, so loading the river never raises the app-wide
  // re-login banner; Manage Sources asks instead.
  async getFollowLinks(window: FollowLinksWindow = '24h'): Promise<FollowLinksResponse> {
    return this.fetch(`/api/v2/following-links?window=${window}`);
  }

  /** One page of every link your follows shared, newest by first share. */
  async getAllFollowLinks(cursor?: string | null, limit?: number): Promise<AllFollowLinksPage> {
    const q =
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '') + (limit ? `&limit=${limit}` : '');
    return this.fetch(`/api/v2/following-links/all?window=7d${q}`);
  }

  /** Whether follows links show in Everything, and whether every link comes back
   *  or just the most shared. Either or both. No permission needed. */
  async setFollowLinksSettings(settings: {
    inEverything?: boolean;
    allLinks?: boolean;
  }): Promise<{ ok: boolean }> {
    return this.fetch('/api/v2/following-links/settings', {
      method: 'POST',
      body: JSON.stringify(settings),
    });
  }

  /** Whether the reader's Bluesky likes / bookmarks sources are on. */
  async getBlueskySources(): Promise<BlueskySourcesStatus> {
    return this.fetch('/api/v2/bluesky-sources');
  }

  /** Turn a Bluesky likes / bookmarks source on or off. Turning one on also
   *  gathers its first items before answering. */
  async setBlueskySource(kind: BskySourceKind, enabled: boolean): Promise<BlueskySourcesStatus> {
    return this.fetch('/api/v2/bluesky-sources', {
      method: 'POST',
      body: JSON.stringify({ kind, enabled }),
    });
  }

  /** Who you follow shared this article, for the Discussion panel. Empty (not
   *  a 403) without the permission, so the panel never raises the re-login banner. */
  async getFollowLinkSharers(url: string): Promise<FollowLinkSharersResponse> {
    return this.fetch(`/api/v2/following-links/for?url=${encodeURIComponent(url)}`);
  }

  async recordRoomRead(collectionUri: string, url: string): Promise<{ ok: boolean }> {
    return this.fetch('/api/rooms/read', {
      method: 'POST',
      body: JSON.stringify({ collectionUri, url }),
    });
  }

  // Bookmarks
  /** Upload a PDF as a save (Supporter). Answers the save, its body included. */
  async uploadPdf(
    file: Blob,
    rkey: string,
    name?: string
  ): Promise<SavedItem & { pageCount?: number; pagesKept?: number }> {
    const params = new URLSearchParams({ rkey });
    if (name) params.set('name', name);
    return this.fetch(`/api/saved/pdf?${params}`, {
      method: 'POST',
      body: file,
      headers: { 'Content-Type': 'application/pdf' },
    });
  }

  /** Upload an EPUB as a save (Supporter). Answers the save, its body included. */
  async uploadEpub(
    file: Blob,
    rkey: string,
    name?: string
  ): Promise<SavedItem & { chapterCount?: number; chaptersKept?: number }> {
    const params = new URLSearchParams({ rkey });
    if (name) params.set('name', name);
    return this.fetch(`/api/saved/epub?${params}`, {
      method: 'POST',
      body: file,
      headers: { 'Content-Type': 'application/epub+zip' },
    });
  }

  async saveFromUrl(
    url: string,
    rkey: string,
    options?: {
      fromFeed?: boolean;
      source?: 'url' | 'feed' | 'document';
      itemGuid?: string;
      title?: string;
      author?: string;
      description?: string;
      content?: string;
      image?: string;
      publishedAt?: string;
      domain?: string;
      wordCount?: number;
      contentType?: 'pdf' | 'epub';
      // The page's declared DOI (ExtractedArticle.doi), kept for exports.
      doi?: string;
      // Replace an existing save of this URL's content instead of a 409.
      updateContent?: boolean;
      // How `content` was captured, recorded on the save's snapshot.
      captureMethod?: 'live-dom' | 'server';
    }
  ): Promise<{
    rkey: string;
    uri: string;
    url: string;
    title: string | null;
    author: string | null;
    description: string | null;
    content: string | null;
    contentType: string | null;
    domain: string | null;
    image: string | null;
    wordCount: number | null;
    publishedAt: string | null;
    savedAt: string;
    source?: 'url' | 'feed' | 'document';
    itemGuid?: string;
  }> {
    return this.fetch('/api/saved', {
      method: 'POST',
      body: JSON.stringify({ url, rkey, ...options }),
    });
  }

  async getSaved(opts?: { limit?: number; cursor?: string | null; sinceDigest?: string }): Promise<{
    // Metadata only — `content` (the article body) is omitted; hydrate it for
    // unseen rkeys via getSavedBodies. The body is ~20-50× the rest of a row and
    // the client already caches it, so re-sending it every refresh is the bulk
    // of the "excessive data" this endpoint used to ship.
    articles: Array<{
      rkey: string;
      uri: string;
      url: string;
      title: string | null;
      author: string | null;
      description: string | null;
      contentType: string | null;
      domain: string | null;
      image: string | null;
      wordCount: number | null;
      publishedAt: string | null;
      savedAt: string;
      source?: 'url' | 'feed' | 'document';
      itemGuid?: string;
      updatedAt?: string | null;
    }>;
    // Keyset cursor for the next (older) page; null at the end of the list.
    cursor: string | null;
    // True when the response is a full snapshot that must replace the cache
    // wholesale (external-backed saves) rather than being merged incrementally.
    full: boolean;
    // External-backed only: digest of the snapshot's serialized articles. Echo
    // it back as `sinceDigest`; a matching snapshot answers `unchanged: true`
    // with no articles instead of re-shipping the whole (large) list.
    digest?: string;
    unchanged?: boolean;
  }> {
    const params = new URLSearchParams();
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    if (opts?.cursor) params.set('cursor', opts.cursor);
    if (opts?.sinceDigest) params.set('since_digest', opts.sinceDigest);
    const qs = params.toString();
    return this.fetch(`/api/saved${qs ? `?${qs}` : ''}`);
  }

  // Saves edited in place after `since` (ms, server clock) — metadata only, oldest
  // edit first. The newest-first list refresh stops at the first cached rkey, so
  // it can't see an older save whose body changed (an extension re-save); this
  // can. Store `next` and pass it back as `since`; `more` means another page.
  async getSavedUpdates(since: number): Promise<{
    articles: SavedItem[];
    next: number;
    more: boolean;
  }> {
    return this.fetch(`/api/saved/updates?since=${encodeURIComponent(String(since))}`);
  }

  /** The captures of a save's body, oldest first (GET /api/saved/:rkey/snapshots). */
  async getSavedSnapshots(rkey: string): Promise<{ snapshots: SavedSnapshot[] }> {
    return this.fetch(`/api/saved/${encodeURIComponent(rkey)}/snapshots`);
  }

  // Hydrate article bodies for the given rkeys. Returns a map rkey → body (null
  // when the row has no stored content yet, e.g. a backed stub awaiting
  // extraction). The client calls this only for saves it hasn't cached locally.
  // `extract` (one rkey, the save being opened): fetch the text of a save
  // imported from another app first, if it's still waiting for it.
  async getSavedBodies(
    rkeys: string[],
    opts: { extract?: boolean } = {}
  ): Promise<{ bodies: Record<string, string | null> }> {
    return this.fetch('/api/saved/bodies', {
      method: 'POST',
      body: JSON.stringify(opts.extract ? { rkeys, extract: true } : { rkeys }),
    });
  }

  // A batch of saves read from another read-later app's export (at most 100).
  async importSaved(
    source: string,
    items: Array<{
      url: string;
      title?: string;
      author?: string;
      description?: string;
      savedAt?: number;
      archived: boolean;
      tags: string[];
      highlights: Array<{ text: string; note?: string; createdAt?: number }>;
    }>,
    /** False keeps them out of the "Imported from" Shelf collection. */
    shelf = true
  ): Promise<{
    added: number;
    duplicates: number;
    invalid: number;
    highlights: number;
    rkeys: string[];
  }> {
    return this.fetch('/api/saved/import', {
      method: 'POST',
      // A backed Library's new saves are copied into its collection in the
      // background, at the pace the reader's PDS allows.
      body: JSON.stringify({ source, items, shelf, copyToBacking: 'queue' }),
    });
  }

  // Patch mutable fields on an existing saved item: the precomputed word count
  // (backfilling old saves that lack one) and the reader's own edit of its
  // metadata. A metadata edit answers with the save's new updatedAt.
  async updateSaved(
    rkey: string,
    fields: { wordCount?: number } & SavedMetadataEdit
  ): Promise<{ success: boolean; updatedAt?: string }> {
    return this.fetch(`/api/saved/${rkey}`, {
      method: 'PATCH',
      body: JSON.stringify(fields),
    });
  }

  async deleteSaved(rkey: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/saved/${rkey}`, {
      method: 'DELETE',
    });
  }

  /** Delete up to 500 saves at once (the Library's bulk delete). Saves already gone are skipped. */
  async deleteSavedMany(rkeys: string[]): Promise<{ deleted: number }> {
    return this.fetch('/api/saved/delete', {
      method: 'POST',
      body: JSON.stringify({ rkeys }),
    });
  }

  async deleteSavedByGuid(guid: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/saved/by-guid/${encodeURIComponent(guid)}`, {
      method: 'DELETE',
    });
  }

  // PDS Sync
  async triggerFullSync(): Promise<{
    success: boolean;
    /** Set when the user's PDS moved and they must reconnect to resume sync. */
    needsReauth?: boolean;
    subscriptions?: {
      success: boolean;
      pulledFromPds: number;
      pushedToPds: number;
      skipped: number;
      /** Things that went wrong. Never paired with an upgrade prompt. */
      warnings: string[];
      /**
       * Plan-limit outcomes (parked / not mirrored). These get the upsell, and
       * `kind` says which raise to quote.
       */
      limitNotices?: SyncLimitNotice[];
      hasMore?: boolean;
      needsReauth?: boolean;
    };
    atmosphere?: {
      success: boolean;
      imported: number;
      removed: number;
      pushed: number;
      skipped: number;
      warnings: string[];
      limitNotices?: SyncLimitNotice[];
      hasMore?: boolean;
      error?: string;
    };
    error?: string;
    hasMore?: boolean;
  }> {
    return this.fetch('/api/sync/full', { method: 'POST' });
  }

  async getSyncStatus(): Promise<{
    pdsSyncEnabled: boolean;
    lastSyncSubscriptions: number | null;
    /** Feeds whose local edits haven't reached the PDS yet. 0 is the normal state. */
    pendingSubscriptions: number;
  }> {
    return this.fetch('/api/sync/status');
  }

  // Channels
  async getChannels(): Promise<{
    channels: Array<{
      uuid: string;
      name: string;
      config: string;
      position: number;
      createdAt: number;
      updatedAt: number;
    }>;
    deletedUuids: string[];
  }> {
    return this.fetch('/api/channels');
  }

  async syncChannels(
    channels: Array<{
      uuid: string;
      name: string;
      config: string;
      position: number;
      createdAt: number;
      updatedAt: number;
    }>
  ): Promise<{ success: boolean }> {
    return this.fetch('/api/channels', {
      method: 'PUT',
      body: JSON.stringify({ channels }),
    });
  }

  async upsertChannel(
    uuid: string,
    data: {
      name: string;
      config: string;
      position: number;
      createdAt: number;
      updatedAt: number;
    }
  ): Promise<{ success: boolean }> {
    return this.fetch(`/api/channels/${uuid}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  /** Move channels; the one write that changes an existing channel's position. */
  async reorderChannels(
    channels: Array<{ uuid: string; position: number }>,
    updatedAt: number
  ): Promise<{ success: boolean }> {
    return this.fetch('/api/channels/order', {
      method: 'PUT',
      body: JSON.stringify({ channels, updatedAt }),
    });
  }

  async deleteChannel(uuid: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/channels/${uuid}`, {
      method: 'DELETE',
    });
  }

  // What a saved-search channel has matched, newest first
  // (backend/src/routes/channel-items.ts).
  async getChannelItems(
    uuid: string,
    params: { before?: string | null; limit?: number; signal?: AbortSignal } = {}
  ): Promise<ChannelItemsResponse> {
    const query = new URLSearchParams();
    if (params.before) query.set('before', params.before);
    if (params.limit) query.set('limit', String(params.limit));
    const qs = query.size > 0 ? `?${query}` : '';
    return this.fetch(`/api/channels/${uuid}/items${qs}`, { signal: params.signal });
  }

  // What a saved search would find among its sources' recent items, read or
  // not (backend/src/routes/channel-items.ts).
  async previewSavedSearch(
    params: {
      query: string;
      sourceMode: 'all' | 'include' | 'exclude';
      sourceKeys: string[];
      librarySources?: LibrarySource[];
    },
    signal?: AbortSignal
  ): Promise<SavedSearchPreview> {
    return this.fetch('/api/channels/preview', {
      method: 'POST',
      body: JSON.stringify(params),
      signal,
    });
  }
}

export const api = new ApiClient();
