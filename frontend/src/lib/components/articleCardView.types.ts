import type { IconName } from './Icon.svelte';
import type { ReaderCollection, ReaderCollectionItem } from '$lib/types';

/**
 * View-model types for the PURE presentational `ArticleCardView.svelte`.
 *
 * The container (`ArticleCard.svelte`) resolves all store/service/derivation
 * work into these flat primitives and callbacks, so the view renders entirely
 * from props — no stores, no services, no fetching $effects. This makes the
 * card's visual design iterable from mock data (see /dev/cards).
 */

export type LaneId = 'linkblog' | 'bluesky' | 'margin' | 'semble';

/** One Atmosphere-row lane chip, with LANE_META already folded in. */
export interface LaneRowVM {
  id: LaneId;
  count: number;
  capped: boolean;
  canCreate: boolean;
  icon: IconName;
  label: string;
  verb: string;
  /** Pre-computed tooltip string. */
  title: string;
  /** id === 'linkblog' && currentlyShared — the "this is mine" tint. */
  isMine: boolean;
  /** Label for the inline create button (the specific action verb). */
  createLabel: string;
  /** linkblog + already-shared → the create affordance becomes "edit". */
  createIsEdit: boolean;
}

export interface LanePersonVM {
  did: string;
  handle: string | null;
  /** The author's own name, when their profile record carries one. */
  displayName: string | null;
  /** Their avatar image URL, or null — the entry falls back to a monogram. */
  avatar: string | null;
  /** When the reference was written (ISO). Null when the record had no date. */
  createdAt: string | null;
  note: string | null;
  url: string | null;
  /** Named Semble collection(s) the saver filed the card into (Semble lane only). */
  collections: { name: string; url: string | null }[];
  /** margin.at lane only: motivation as a past-tense verb ('highlighted' / …). */
  verb: string | null;
  /** margin.at lane only: the highlighted passage, distinct from the `note` comment. */
  quote: string | null;
}

/** `all` is the resting state of the discussion: every lane, one stream. */
export type DiscussionFilterId = LaneId | 'all';

/** One chip in the discussion's filter row. `all` carries no icon. */
export interface DiscussionFilterVM {
  id: DiscussionFilterId;
  label: string;
  count: number;
  capped: boolean;
  icon: IconName | null;
}

/**
 * One reference in the merged discussion — a lane entry that has been told
 * which lane it came from, had its note cleaned of the article's own title and
 * links, and had its date pre-formatted. The panel renders these directly.
 */
export interface DiscussionEntryVM extends LanePersonVM {
  /** Stable list key across lanes. */
  key: string;
  lane: LaneId;
  laneLabel: string;
  laneIcon: IconName;
  /**
   * What this person did, in the head line: the lane's verb ('posted', 'noted'),
   * or margin.at's per-note motivation ('highlighted'). Null where the body
   * already says it — a Semble save names its collections.
   */
  headVerb: string | null;
  /** Pre-formatted relative time ('2d ago'), or null when undated. */
  relativeTime: string | null;
  /** Full timestamp for the `datetime` attribute / tooltip. */
  isoTime: string | null;
  /** `note` with the article's title and bare URLs stripped; null when nothing
      of substance was left. */
  cleanNote: string | null;
}

/** The merged, filtered, chronologically ordered discussion. */
export interface DiscussionStreamVM {
  /**
   * Nobody has asked for the people yet — the host hasn't opened the stream (the
   * card's Discussion toggle, the reader's section scrolling into range). Not the
   * same as `loading`: there is no request in flight and nothing to say yet, so
   * the surface renders neither skeletons nor an empty state.
   */
  idle?: boolean;
  /** At least one lane in view is still resolving its people. */
  loading: boolean;
  /** Every lane in view failed to resolve and none produced entries. */
  failed?: boolean;
  /** People who said something: a note, a quoted passage, or a named collection. */
  entries: DiscussionEntryVM[];
  /**
   * People who only dropped the link — a bridge or a bot whose whole post was
   * the headline and the URL. They are distribution, not discussion, so the
   * surface collects them into one line instead of giving each an empty row.
   */
  linkOnly?: DiscussionEntryVM[];
}

export interface SocialContextVM {
  quoteCount: number;
}

export interface ArticleCardViewProps {
  // ── Data (pre-resolved primitives) ──
  itemUrl: string;
  itemTitle: string;
  /** Pre-resolved formatRelativeDate(publishedAt). */
  relativeDate: string;
  /** Pre-resolved getFaviconUrl(...) / siteIcon. */
  faviconUrl: string;
  displayFeedTitle?: string;
  /** Raw feed title — the mobile meta line keys off this, not displayFeedTitle. */
  feedTitle?: string;
  feedId?: number;
  readTimeMinutes: number;
  /** Already sanitizeHtml'd in the container — rendered with {@html}. */
  sanitizedContent: string;
  hasContent: boolean;

  /**
   * Whether the Share control belongs in the action bar at all — the user is
   * signed in with a linkblog. Resolved by the container: the discussion's
   * compose row deliberately does NOT offer the linkblog on a card (the Share
   * button owns it), so this can't be inferred from the lane VM.
   */
  canShare?: boolean;

  isDocumentMode: boolean;
  isLinkPostMode: boolean;

  linkPostNote?: string;
  /** The note rendered from Markdown to sanitized HTML, for {@html}. */
  linkPostNoteHtml?: string;
  linkPostExcerpt?: string;
  linkPostThumb?: string;

  authorHandle?: string;
  authorDisplayName?: string;
  authorAvatar?: string;
  authorDid?: string;

  socialContext?: SocialContextVM;

  laneRow?: LaneRowVM[];
  /** The discussion's filter chips, its active chip, and the merged stream. */
  filters?: DiscussionFilterVM[];
  activeFilter?: DiscussionFilterId;
  stream?: DiscussionStreamVM;

  itemTagCount: number;
  itemTags?: string[];

  /** >0 when this document is a curated edition (Collection): the number of
   *  pieces it gathers. Drives the quiet "Edition · N" marker in the title row
   *  and keeps the Reader action available even when there's no inline body. */
  collectionPieceCount?: number;

  /** The resolved curated edition, when this document is a Collection. When
   *  present (and the card is open), the body renders the edition's pieces as
   *  embedded cards (CollectionReader) instead of the {@html sanitizedContent}
   *  body — the same treatment the fullscreen reader uses. */
  collection?: ReaderCollection;

  // ── State ──
  isRead?: boolean;
  isSaved?: boolean;
  selected?: boolean;
  expanded?: boolean;
  isOpen: boolean;
  highlighted?: boolean;
  isTruncated?: boolean;
  currentlyShared?: boolean;
  /** The posted note. Not rendered — it decides whether the Share button shows
   *  its "has commentary" dot, and what its title says. */
  currentNote?: string;
  /** A local share draft exists for this article (unposted composer content). */
  hasShareDraft?: boolean;
  showActionBarIntegrations?: boolean;
  overflowMenuOpen?: boolean;
  /** Offer the inline "fetch original article" action (short-excerpt articles). */
  showFetchOriginal?: boolean;
  /** Offer "fetch original article" in the overflow menu (long-body articles). */
  showFetchOriginalMenu?: boolean;
  /** The original-article extraction is in flight. */
  fetchingOriginal?: boolean;
  /** The original article has been fetched and is shown inline. */
  hasFetchedOriginal?: boolean;
  canFollowSource?: boolean;
  hasSaveToSemble?: boolean;
  hasSaveToMargin?: boolean;
  hasOpenFullscreen?: boolean;

  // ── Bindings (element refs surfaced back to the container) ──
  bodyEl?: HTMLElement;
  tagBtnRef?: HTMLButtonElement;
  overflowTriggerRef?: HTMLButtonElement;

  // ── Callbacks (view emits semantic events; container does store work) ──
  onHeaderClick?: () => void;
  onContentTap?: () => void;
  onToggleRead?: () => void;
  onToggleSave?: () => void;
  onOpenUrl?: () => void;
  onOpenFullscreen?: () => void;
  /** Open a curated edition piece in the in-app reader (CollectionReader). */
  onOpenCollectionPiece?: (item: ReaderCollectionItem) => void | Promise<void>;
  /** Toggle a curated edition piece into the Saved list. */
  onSaveCollectionPiece?: (item: ReaderCollectionItem) => void;
  /** Reactive saved-state predicate for a curated edition piece. */
  isCollectionPieceSaved?: (item: ReaderCollectionItem) => boolean;
  /** Open the link context menu (open externally / save to reader) for a link
   *  post's URL, anchored to the clicked chip's rect. */
  onOpenLinkMenu?: (anchorRect: DOMRect) => void;
  onExpandToggle?: () => void;
  onTagClick?: () => void;
  onOverflowClick?: () => void;
  onOverflowOpenUrl?: () => void;
  /** Fetch the full original article and render it inline. */
  onFetchOriginal?: () => void;
  /** Fetch the full original article from the overflow menu (closes the menu). */
  onOverflowFetchOriginal?: () => void;
  onOverflowTag?: () => void;
  onOverflowSemble?: () => void;
  onOverflowMargin?: () => void;
  onSaveToSemble?: () => void;
  onSaveToMargin?: () => void;
  onFollowSource?: () => void;
  onSelectFilter?: (id: DiscussionFilterId) => void;
  /** Opening Discussion is what starts resolving the people in it. */
  onOpenStream?: () => void;
  onRetryStream?: () => void;
  onCreateInLane?: (id: LaneId) => void;
  /** Open the share composer (drafting; resumes an existing draft). */
  onComposeShare?: () => void;
  /** Open the share composer on the posted note (edit mode) — where editing the
   *  note and removing the share both live. */
  onEditShare?: () => void;
  onOpenAuthor?: (did: string) => void;
  // A @mention in the note/body was clicked — open the add-feed dialog for the DID.
  onMentionClick?: (did: string) => void;
  onCloseOverflow?: () => void;
}
