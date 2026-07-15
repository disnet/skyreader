import type { IconName } from './Icon.svelte';
import type { Highlight, ReaderCollection, ReaderCollectionItem } from '$lib/types';

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
  note: string | null;
  url: string | null;
  /** Named Semble collection(s) the saver filed the card into (Semble lane only). */
  collections: { name: string; url: string | null }[];
  /** margin.at lane only: motivation as a past-tense verb ('highlighted' / …). */
  verb: string | null;
  /** margin.at lane only: the highlighted passage, distinct from the `note` comment. */
  quote: string | null;
}

export interface ExpandedLaneItemsVM {
  loading: boolean;
  entries: LanePersonVM[];
}

export interface AlsoLinkedEntryVM {
  recordUri: string;
  did: string;
  handle: string | null;
  note: string | null;
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
  alsoLinkedBy?: AlsoLinkedEntryVM[];

  laneRow?: LaneRowVM[];
  expandedLane?: LaneId | null;
  expandedLaneItems?: ExpandedLaneItemsVM;

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
  currentNote?: string;
  /** Highlights on the article, offered as quick blockquotes in the share note. */
  highlights?: Highlight[];
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
  /** Remove the share (unshare), from the persistent note box. */
  onRemoveShare?: () => void;
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
  onToggleLane?: (id: LaneId) => void;
  onCreateInLane?: (id: LaneId) => void;
  onApplyComment?: (note: string) => void;
  onOpenAuthor?: (did: string) => void;
  // A @mention in the note/body was clicked — open the add-feed dialog for the DID.
  onMentionClick?: (did: string) => void;
  onCloseOverflow?: () => void;
}
