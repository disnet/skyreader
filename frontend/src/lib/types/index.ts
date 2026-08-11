export interface User {
  did: string;
  handle: string;
  displayName?: string;
  avatarUrl?: string;
  pdsUrl: string;
  tier?: string;
  limits?: {
    maxSubscriptions: number;
    maxUrlSavesPerMonth: number;
  };
}

export type SubscriptionSourceType = 'rss' | 'atproto.documents' | 'atproto.collection';

export interface Subscription {
  id?: number;
  rkey: string;
  feedUrl?: string; // Required for RSS, optional for AT Proto subscriptions
  title: string;
  siteUrl?: string;
  category?: string;
  tags: string[];
  createdAt: string;
  updatedAt?: string;
  localUpdatedAt: number;
  fetchStatus?: 'pending' | 'ready' | 'error';
  lastFetchedAt?: number;
  fetchError?: string;
  source?: 'manual' | 'opml';
  customTitle?: string; // User-set title override (synced to PDS)
  customIconUrl?: string; // User-set icon override (synced to PDS)
  sourceType?: SubscriptionSourceType; // Content source type; omitted = RSS
  subjectDid?: string; // AT Protocol account DID; required for atproto.* types
  collectionNsid?: string; // Collection NSID for atproto.collection (future)
}

export interface Article {
  id?: number;
  subscriptionId: number;
  guid: string;
  url: string;
  title: string;
  author?: string;
  content?: string;
  summary?: string;
  imageUrl?: string;
  publishedAt: string;
  fetchedAt: number;
  // Precomputed body stats. The full `content` HTML is dropped from the
  // in-memory copy of an article (see toLightArticle) to keep the heap small —
  // it stays in IndexedDB and is lazy-loaded on expand. These numbers let the
  // length/word-count features (sort-by-length, "long reads", read time) keep
  // working without holding every body in memory. Absent on un-lightened rows.
  contentLength?: number;
  wordCount?: number;
}

export interface ReadPosition {
  id?: number;
  rkey?: string;
  subscriptionRkey: string;
  articleGuid: string;
  articleUrl: string;
  articleTitle?: string;
  readAt: string;
  scrollPosition?: number;
  /** @deprecated use savesStore.isSaved() instead */
  starred: boolean;
}

// Unified social read position types
export type SocialItemType = 'document';

export interface SocialReadPosition {
  id?: number;
  rkey?: string;
  type: SocialItemType;
  itemUri: string;
  authorDid: string;
  itemUrl: string;
  itemTitle?: string;
  readAt: string;
}

// Leaflet content types for pub.leaflet.content format
export interface LeafletFacetIndex {
  byteStart: number;
  byteEnd: number;
}

export interface LeafletFacetFeature {
  $type: string;
  uri?: string; // for links
  did?: string; // for mentions
  // Footnotes travel inside the facet rather than as a block: the reference
  // point is a facet over a marker character in the block's plaintext, and the
  // footnote body rides along in contentPlaintext/contentFacets.
  footnoteId?: string;
  contentPlaintext?: string;
  contentFacets?: LeafletFacet[];
}

export interface LeafletFacet {
  index: LeafletFacetIndex;
  features: LeafletFacetFeature[];
}

export interface LeafletTextBlock {
  $type: 'pub.leaflet.blocks.text';
  plaintext: string;
  textSize?: 'default' | 'small' | 'large';
  facets?: LeafletFacet[];
}

export interface LeafletHeaderBlock {
  $type: 'pub.leaflet.blocks.header';
  plaintext: string;
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  facets?: LeafletFacet[];
}

export interface LeafletCodeBlock {
  $type: 'pub.leaflet.blocks.code';
  plaintext: string;
  language?: string;
}

export interface LeafletBlockquoteBlock {
  $type: 'pub.leaflet.blocks.blockquote';
  plaintext: string;
  facets?: LeafletFacet[];
}

export interface LeafletHorizontalRuleBlock {
  $type: 'pub.leaflet.blocks.horizontalRule';
}

export interface LeafletListItemContent {
  $type: 'pub.leaflet.blocks.text';
  plaintext: string;
  facets?: LeafletFacet[];
}

export interface LeafletListItemBlock {
  $type: 'pub.leaflet.blocks.unorderedList#listItem' | 'pub.leaflet.blocks.orderedList#listItem';
  content: LeafletListItemContent;
  children?: LeafletListItemBlock[];
}

export interface LeafletUnorderedListBlock {
  $type: 'pub.leaflet.blocks.unorderedList';
  children: LeafletListItemBlock[];
}

export interface LeafletOrderedListBlock {
  $type: 'pub.leaflet.blocks.orderedList';
  children: LeafletListItemBlock[];
}

export interface LeafletImageBlock {
  $type: 'pub.leaflet.blocks.image';
  image: { ref: { $link: string }; mimeType: string };
  aspectRatio?: { width: number; height: number };
  alt?: string;
}

export interface LeafletWebsiteBlock {
  $type: 'pub.leaflet.blocks.website';
  url: string;
  title?: string;
  description?: string;
  thumb?: {
    ref: { $link: string };
    mimeType: string;
  };
}

export interface LeafletBskyPostBlock {
  $type: 'pub.leaflet.blocks.bskyPost';
  postRef: {
    uri: string;
    cid?: string;
  };
}

export interface LeafletPageBlock {
  $type: 'pub.leaflet.blocks.page';
  pageId: string;
}

// Union of all supported block types
export type LeafletBlock =
  | LeafletTextBlock
  | LeafletHeaderBlock
  | LeafletCodeBlock
  | LeafletBlockquoteBlock
  | LeafletHorizontalRuleBlock
  | LeafletUnorderedListBlock
  | LeafletOrderedListBlock
  | LeafletImageBlock
  | LeafletWebsiteBlock
  | LeafletBskyPostBlock
  | LeafletPageBlock;

export interface LeafletBlockWrapper {
  block: LeafletBlock;
  alignment?: 'left' | 'center' | 'right';
}

export interface LeafletLinearDocument {
  $type: 'pub.leaflet.pages.linearDocument';
  blocks: LeafletBlockWrapper[];
}

export interface LeafletContent {
  $type: 'pub.leaflet.content';
  pages: LeafletLinearDocument[];
}

// pckt.blog content types for blog.pckt.content format
export interface PcktBlogFacetIndex {
  byteStart: number;
  byteEnd: number;
}

export interface PcktBlogFacetFeature {
  $type: string;
  uri?: string; // for links
  did?: string; // for didMention
}

export interface PcktBlogFacet {
  index: PcktBlogFacetIndex;
  features: PcktBlogFacetFeature[];
}

export interface PcktBlogTextBlock {
  $type: 'blog.pckt.block.text';
  plaintext: string;
  facets?: PcktBlogFacet[];
}

export interface PcktBlogHeadingBlock {
  $type: 'blog.pckt.block.heading';
  plaintext: string;
  level?: 1 | 2 | 3 | 4 | 5 | 6;
}

export interface PcktBlogHorizontalRuleBlock {
  $type: 'blog.pckt.block.horizontalRule';
}

export interface PcktBlogImageBlock {
  $type: 'blog.pckt.block.image';
  attrs: {
    alt?: string;
    src?: string;
    blob?: {
      $type: 'blob';
      ref: { $link: string };
      mimeType: string;
      size: number;
    };
    align?: 'left' | 'center' | 'right';
  };
}

export interface PcktBlogListItemBlock {
  $type: 'blog.pckt.block.listItem';
  content?: PcktBlogBlock[];
}

export interface PcktBlogOrderedListBlock {
  $type: 'blog.pckt.block.orderedList';
  attrs?: {
    start?: number;
  };
  content?: PcktBlogListItemBlock[];
}

export interface PcktBlogBlockquoteBlock {
  $type: 'blog.pckt.block.blockquote';
  content?: PcktBlogBlock[];
}

export interface PcktBlogTableCellBlock {
  $type: 'blog.pckt.block.tableCell' | 'blog.pckt.block.tableHeader';
  attrs?: {
    colspan?: number;
    rowspan?: number;
    colwidth?: number[];
  };
  content?: PcktBlogBlock[];
}

export interface PcktBlogTableRowBlock {
  $type: 'blog.pckt.block.tableRow';
  content?: PcktBlogTableCellBlock[];
}

export interface PcktBlogTableBlock {
  $type: 'blog.pckt.block.table';
  content?: PcktBlogTableRowBlock[];
}

export interface PcktBlogBlueskyEmbedBlock {
  $type: 'blog.pckt.block.blueskyEmbed';
  attrs?: {
    postRef?: {
      uri: string;
      cid: string;
    };
  };
}

export interface PcktBlogIframeBlock {
  $type: 'blog.pckt.block.iframe';
  attrs?: {
    url?: string;
    height?: number;
  };
}

export interface PcktBlogWebsiteBlock {
  $type: 'blog.pckt.block.website';
  attrs?: {
    src?: string;
    title?: string;
    description?: string;
    previewImage?: string;
  };
}

// Union of all supported pckt.blog block types
export type PcktBlogBlock =
  | PcktBlogTextBlock
  | PcktBlogHeadingBlock
  | PcktBlogHorizontalRuleBlock
  | PcktBlogImageBlock
  | PcktBlogListItemBlock
  | PcktBlogOrderedListBlock
  | PcktBlogBlockquoteBlock
  | PcktBlogTableCellBlock
  | PcktBlogTableRowBlock
  | PcktBlogTableBlock
  | PcktBlogBlueskyEmbedBlock
  | PcktBlogIframeBlock
  | PcktBlogWebsiteBlock;

export interface PcktBlogContent {
  $type: 'blog.pckt.content';
  items: PcktBlogBlock[];
}

// Offprint content types for app.offprint.content format
export interface OffprintFacetFeature {
  $type: string;
  uri?: string;
  did?: string;
  handle?: string;
  color?: string;
  title?: string;
  siteName?: string;
}

export interface OffprintFacet {
  index: { byteStart: number; byteEnd: number };
  features: OffprintFacetFeature[];
}

export interface OffprintTextBlock {
  $type: 'app.offprint.block.text';
  plaintext: string;
  facets?: OffprintFacet[];
  textAlign?: 'left' | 'center' | 'right';
}

export interface OffprintHeadingBlock {
  $type: 'app.offprint.block.heading';
  plaintext: string;
  facets?: OffprintFacet[];
  textAlign?: 'left' | 'center' | 'right';
  level: 1 | 2 | 3;
}

export interface OffprintBlockquoteBlock {
  $type: 'app.offprint.block.blockquote';
  content: (OffprintTextBlock | OffprintHeadingBlock)[];
}

export interface OffprintCalloutBlock {
  $type: 'app.offprint.block.callout';
  plaintext: string;
  facets?: OffprintFacet[];
  emoji?: string;
  color?: string;
}

export interface OffprintListItemContent {
  plaintext: string;
  facets?: OffprintFacet[];
}

export interface OffprintListItem {
  content: OffprintListItemContent;
  children?: OffprintListItem[];
}

export interface OffprintBulletListBlock {
  $type: 'app.offprint.block.bulletList';
  children: OffprintListItem[];
}

export interface OffprintOrderedListBlock {
  $type: 'app.offprint.block.orderedList';
  start?: number;
  children: OffprintListItem[];
}

export interface OffprintTaskItem {
  checked: boolean;
  content: OffprintListItemContent;
  children?: OffprintTaskItem[];
}

export interface OffprintTaskListBlock {
  $type: 'app.offprint.block.taskList';
  children: OffprintTaskItem[];
}

export interface OffprintCodeBlockBlock {
  $type: 'app.offprint.block.codeBlock';
  code: string;
  language?: string;
  showLineNumbers?: boolean;
}

export interface OffprintHorizontalRuleBlock {
  $type: 'app.offprint.block.horizontalRule';
}

export interface OffprintImageBlock {
  $type: 'app.offprint.block.image';
  blob: { ref: { $link: string }; mimeType: string; size?: number };
  alt?: string;
  width?: number;
  caption?: string;
  captionFacets?: OffprintFacet[];
  alignment?: 'left' | 'center' | 'right';
  aspectRatio?: { width: number; height: number };
}

export interface OffprintImageGridImage {
  blob: { ref: { $link: string }; mimeType: string; size?: number };
  alt?: string;
}

export interface OffprintImageGridBlock {
  $type: 'app.offprint.block.imageGrid';
  images: OffprintImageGridImage[];
  caption?: string;
  gridRows?: number;
  aspectRatio?: { width: number; height: number };
}

export interface OffprintImageCarouselBlock {
  $type: 'app.offprint.block.imageCarousel';
  images: OffprintImageGridImage[];
  caption?: string;
  autoplay?: boolean;
  interval?: number;
}

export interface OffprintImageDiffBlock {
  $type: 'app.offprint.block.imageDiff';
  images: [OffprintImageGridImage, OffprintImageGridImage];
  labels?: [string, string];
  caption?: string;
  width?: number;
  alignment?: 'left' | 'center' | 'right';
}

// Union of all supported Offprint block types
export type OffprintBlock =
  | OffprintTextBlock
  | OffprintHeadingBlock
  | OffprintBlockquoteBlock
  | OffprintCalloutBlock
  | OffprintBulletListBlock
  | OffprintOrderedListBlock
  | OffprintTaskListBlock
  | OffprintCodeBlockBlock
  | OffprintHorizontalRuleBlock
  | OffprintImageBlock
  | OffprintImageGridBlock
  | OffprintImageCarouselBlock
  | OffprintImageDiffBlock;

export interface OffprintContent {
  $type: 'app.offprint.content';
  items: OffprintBlock[];
}

// Greengale content types for app.greengale.document format (markdown-based)
export interface GreengaleBlobRef {
  name: string;
  cid: string;
  mimeType?: string;
}

export interface GreengaleContent {
  $type: 'app.greengale.document';
  markdown: string;
  blobs?: GreengaleBlobRef[];
}

// markpub content (https://markpub.at/) — an interop wrapper for embedding
// Markdown into a standard.site document. The body lives at `text.markdown`;
// `textBlob`/`facets` are optional overlays Skyreader doesn't currently consume.
export interface MarkpubText {
  $type?: 'at.markpub.text';
  markdown: string;
  textBlob?: { ref?: { $link: string }; mimeType?: string; size?: number };
  facets?: unknown[];
  lenses?: unknown[];
}

export interface MarkpubContent {
  $type: 'at.markpub.markdown';
  text: MarkpubText;
  flavor?: 'gfm' | 'commonmark' | string;
  renderingRules?: string;
  extensions?: string[];
  frontMatter?: unknown[];
}

export interface SocialDocument {
  id?: number;
  authorDid: string;
  recordUri: string;
  siteUri: string;
  title: string;
  publishedAt: string;
  path?: string;
  description?: string;
  coverImageCid?: string;
  textContent?: string;
  bskyPostUri?: string;
  // Precomputed word count. The flat `textContent` is dropped from the in-memory
  // copy (see toLightDocument) — it duplicates the structured `content` body and
  // is only used for word count + an unrecognized-format render fallback. This
  // keeps the count available without holding every body's text in memory.
  wordCount?: number;
  tags?: string[];
  updatedAt?: string;
  canonicalUrl?: string;
  content?:
    | LeafletContent
    | PcktBlogContent
    | OffprintContent
    | GreengaleContent
    | MarkpubContent
    | unknown; // Open union for future content types
  indexedAt?: string;
  createdAt: string;
  siteIcon?: string;
  // External resource refs (RFC-8288-style). A linkblog "link post" carries the
  // shared article's https URL here (rel: 'related'); see utils/linkPost.ts.
  links?: Array<{ uri: string; rel?: string }>;
  // Present when this document is a Standard Reader "Collection" — a curated
  // magazine edition of other documents. The proxy resolves each item to a
  // preview; the river renders an edition card, opening into the edition reader.
  readerCollection?: ReaderCollection;
  // Per-user read state stamped onto the document batch response by the backend
  // (inline read annotation, keyed by recordUri). Consumed additively on merge.
  read?: boolean;
  // Skyreader's provenance marker (a constant URL) on a link post it wrote. A
  // linkblog connected to an existing publication shares that publication with
  // whatever its home app publishes there, so this is what separates a share from
  // someone's essay — see isSkyreaderShare in utils/linkPost.
  skyreaderLinkblog?: string;
}

// A single curated piece in a Collection, resolved by the proxy to a renderable
// preview (the curator's `note` + the referenced document's metadata). A failed
// resolution degrades to note + raw `document` URI with the previews absent.
export interface ReaderCollectionItem {
  /** The referenced document's at:// URI (or a raw https URL for loose links). */
  document: string;
  /** The curator's blurb for this piece (markdown). */
  note?: string;
  authorDid?: string;
  title?: string;
  description?: string;
  canonicalUrl?: string;
  siteIcon?: string;
  /** The referenced document's publication name (e.g. "Alex's Blog"), shown as
   *  the source label in the magazine TOC. Falls back to hostname in the UI. */
  sourceName?: string;
  publishedAt?: string;
}

// A publication's `basicTheme` palette — accent/background/foreground colors as
// raw RGB triples (from `site.standard.publication.basicTheme`), used to paint
// the optional magazine view of a curated edition.
export interface BasicTheme {
  accent?: { r: number; g: number; b: number };
  background?: { r: number; g: number; b: number };
  foreground?: { r: number; g: number; b: number };
  accentForeground?: { r: number; g: number; b: number };
}

// Google Font family names for a collections publication's typography
// (app.standard-reader.publicationTheme), honored by the magazine view.
export interface PublicationFonts {
  title?: string;
  body?: string;
}

// A curated edition: an editorial intro, an ordered list of pieces with notes,
// and a closing colophon. `editorial`/`colophon` bodies are GFM markdown.
// `publicationName`/`theme`/`fonts`/`authorHandle` describe the edition's own
// publication and drive the themed magazine masthead.
export interface ReaderCollection {
  editorial?: { title?: string; body?: string };
  colophon?: { body?: string };
  items: ReaderCollectionItem[];
  publicationName?: string;
  theme?: BasicTheme;
  fonts?: PublicationFonts;
  authorHandle?: string;
}

// Profile info fetched from Bluesky
export interface BlueskyProfile {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
}

// A person with a Skyreader linkblog, surfaced by discovery (Phase 6).
export interface LinkblogPerson {
  did: string;
  handle: string | null;
  displayName?: string;
  avatar?: string;
  // The publication to subscribe to (at://did/site.standard.publication/skyreader-links).
  publicationUri: string;
  // The public linkblog page — used as the subscription's siteUrl.
  blogUrl: string;
  // Whether the current user already follows this person on Bluesky.
  isFollow: boolean;
}

// A standard.site publication owned by someone you follow on Bluesky, surfaced
// by /discover's "people you follow" scan. A single account may have several.
export interface FollowingPublication {
  did: string;
  handle: string | null;
  displayName?: string;
  avatar?: string;
  // The publication record to subscribe to (at://did/site.standard.publication/<rkey>).
  publicationUri: string;
  name: string;
  description?: string;
  iconUrl?: string;
  // The publication's public website — used as the subscription's siteUrl.
  url: string;
}

// A locally-tracked linkblog share (Phase 1). Sharing an article now writes a
// site.standard.document to the user's skyreader-links publication; we keep a
// local record keyed by the external article URL so the share button can show
// "shared" state and support un-sharing. (Authoritative reconciliation from the
// PDS arrives in Phase 2, once the proxy surfaces the document's `links`.)
export interface LinkblogShare {
  id?: number;
  rkey: string;
  recordUri?: string;
  articleUrl: string;
  articleTitle?: string;
  note?: string;
  createdAt: string;
}

// One other person who linked the same external article (Constellation), with
// their commentary if available. Powers the "also linked by …" context line.
export interface AlsoLinkedEntry {
  did: string;
  handle: string | null;
  note: string | null;
  recordUri: string;
}

// Constellation social context for a single link post (Phase 3). Adornment only;
// all fields are best-effort and degrade to zero/empty.
export interface SocialContextResult {
  key: string;
  quoteCount: number;
  alsoLinkedBy: AlsoLinkedEntry[];
}

// One source lane of network-wide mentions for an article (Phase 5): a kind of
// reference (linkblog note / Bluesky post / margin.at highlight / Semble save)
// with its honest verb and a distinct-DID count. `capped` marks a count that hit
// the lookup page cap and is a lower bound.
export interface MentionLane {
  lane: 'linkblog' | 'bluesky' | 'margin' | 'semble';
  label: string;
  verb: string;
  noun: string;
  icon: string;
  count: number;
  capped: boolean;
}

// The network-wide mention breakdown for one article URL (Phase 5). `total` is
// the distinct-DID union across all lanes; `lanes` are non-empty lanes in
// priority order (the lead lane is lanes[0]). Adornment only — degrades to
// total 0 / empty lanes.
export interface ArticleMentions {
  url: string;
  total: number;
  lanes: MentionLane[];
}

// One resolved reference inside a lane (Phase 5 "see existing items"): a person
// who referenced this URL via that lane, with their note/snippet and a link out
// to the actual post / card / highlight. Lazily resolved on lane expand — off
// the always-on counts path, since it costs a per-record PDS fetch. `note` and
// `url` are best-effort and degrade to null per lane / per record.
export interface MentionLaneEntry {
  did: string;
  handle: string | null;
  note: string | null;
  url: string | null;
  // Named Semble collection(s) the saver filed the card into, each with a link
  // to its public Semble page where resolvable. Semble lane only; empty
  // elsewhere. Adornment — degrades to an empty list.
  collections: SembleCollectionRef[];
  // margin.at lane only: the annotation's motivation as a past-tense verb
  // ('highlighted' / 'commented' / …), and the highlighted passage it targets
  // (distinct from the user's comment in `note`). Null for other lanes.
  verb: string | null;
  quote: string | null;
}

// One named Semble collection a card was filed into (see MentionLaneEntry).
export interface SembleCollectionRef {
  name: string;
  url: string | null;
}

// An in-app notification (currently only @mention-on-a-share). `actor*` fields
// are the sharer who mentioned you; `sourceUri` is the mentioning
// site.standard.document; `title` is the shared article's title. Sourced
// client-side from Constellation (see services/mentions.ts); `id` is the
// stable source URI.
export interface SkyNotification {
  id: string;
  type: 'mention' | string;
  actorDid: string;
  actorHandle: string | null;
  actorDisplayName: string | null;
  actorAvatar: string | null;
  sourceUri: string;
  canonicalUrl: string | null;
  title: string | null;
  createdAt: number;
  seen: boolean;
}

// The user's linkblog publication metadata (site.standard.publication), as
// returned by the backend. `exists` is false when the publication hasn't been
// created yet (first share creates it lazily).
export interface LinkblogPublication {
  uri: string;
  url: string;
  name: string;
  description?: string;
  iconUrl?: string;
  exists: boolean;
  external: boolean;
  format: 'leaflet' | 'pckt' | 'offprint' | 'markpub';
  // For a connected publication only: its own site (e.g. https://leaflet.pub/…).
  // Informational — `url` above is always the Skyreader linkblog page, which
  // renders the connected publication's link posts too.
  externalUrl?: string;
}

// One publication the user could publish their links to, as offered by
// GET /api/linkblog/publications. Everything past `isDefault` is descriptive —
// it exists so the picker can say what a publication actually is instead of
// showing a bare name.
export interface LinkblogPublicationChoice {
  uri: string;
  rkey: string;
  name: string;
  description?: string;
  url?: string;
  isDefault: boolean;
  /** Which standard.site app this publication belongs to, when we can tell. */
  appId?: string;
  appLabel?: string;
  /** The content format that app's posts use — pre-selected on connect. */
  detectedFormat?: LinkblogPublication['format'];
  /** How many documents already live in this publication (capped by the scan). */
  posts?: number;
}

export interface ParsedFeed {
  title: string;
  description?: string;
  siteUrl?: string;
  imageUrl?: string;
  items: FeedItem[];
  fetchedAt: number;
}

export interface FeedItem {
  guid: string;
  url: string;
  title: string;
  author?: string;
  content?: string;
  summary?: string;
  imageUrl?: string;
  publishedAt: string;
  // Per-user read state stamped onto the batch fetch response by the backend
  // (inline read annotation). Consumed additively on merge, then discarded — it
  // is not an Article column. Absent on un-annotated responses.
  read?: boolean;
}

// Combined feed item for unified "all" view
export type CombinedFeedItem =
  | { type: 'article'; item: Article; date: string }
  | { type: 'document'; item: SocialDocument; date: string };

/**
 * Auto-update rule for a channel. When set, sourceKeys are automatically
 * recomputed when subscriptions change.
 */
export type ChannelAutoRule =
  | { type: 'category'; value: string }
  | { type: 'subscriptionTag'; value: string }
  | { type: 'domain'; patterns: string[] }
  | { type: 'people' }
  | { type: 'frequency'; threshold: 'high' | 'low' }
  | { type: 'longReads'; minLength: number }
  | { type: 'recent'; withinDays: number };

export type SavedSourceType = 'url' | 'feed' | 'document';
export type DateAddedPreset = 'last-week' | 'last-month' | 'last-3-months' | 'last-year';
export type ReadingLengthFilter = 'quick' | 'medium' | 'long';
export type SortOrder =
  | 'newest'
  | 'oldest'
  | 'published-newest'
  | 'published-oldest'
  | 'shortest'
  | 'longest'
  | 'domain-asc'
  | 'domain-desc';

export interface FilteredView {
  id?: number;
  uuid: string;
  name: string;
  // Channel mode: 'feed' (default) shows normal content, 'saved' shows only saved items
  mode?: 'feed' | 'saved';
  // Unified source filter (new format) — applies to feed-mode channels
  sourceMode?: 'all' | 'include' | 'exclude';
  sourceKeys?: string[];
  // Auto-update rule: when set, sourceKeys are kept in sync with subscriptions
  autoRule?: ChannelAutoRule;
  // Saved channel: filter by save source type (url, feed, share, document)
  savedSourceFilter?: SavedSourceType[];
  // Saved channel filters
  savedDateFilter?: DateAddedPreset;
  savedReadingLength?: ReadingLengthFilter[];
  savedDomainFilter?: string[];
  // Legacy fields (kept for backward compat with existing IndexedDB records)
  showArticles?: boolean;
  showShares?: boolean;
  showDocuments?: boolean;
  feedMode?: 'none' | 'all' | 'include' | 'exclude';
  feedIds?: number[];
  accountMode?: 'none' | 'all' | 'include' | 'exclude';
  accountDids?: string[];
  readFilter: 'all' | 'unread' | 'read';
  sortOrder: SortOrder;
  tagFilter?: string[];
  typeFilter?: SubscriptionSourceType[];
  createdAt: number;
  updatedAt: number;
  position: number;
}

/** Alias for FilteredView — use Channel in new code. */
export type Channel = FilteredView;

export interface ItemTags {
  itemKey: string;
  tags: string[];
  itemType: ItemLabelType;
}

export type ItemLabelType = 'article' | 'document' | 'saved';

export interface SavedItem {
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
}

export interface ItemLabel {
  itemKey: string;
  itemType: ItemLabelType;
  label: string; // 'read', 'archived', 'tag:<name>'
  props: Record<string, unknown>; // label-specific metadata
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms
}

// A durable, cross-device magazine: an explicitly-generated reading issue whose
// membership + order are frozen at generate time (immune to later saves) and
// synced via D1. See docs/plans / the magazine store for the full model.

// One frozen entry in a magazine. Carries enough to render the TOC/headers and
// reading time without re-deriving from live saves; the body is still fetched
// lazily by `rkey` (a snapshot whose save was deleted renders a "missing" body).
export interface MagazineItemSnapshot {
  key: string; // stable magazine key (savedItemMagazineKey)
  displayKey: string; // reader key (savedItemDisplayKey)
  rkey: string; // save rkey — used to lazily fetch the body
  title: string | null;
  author: string | null;
  url: string;
  domain: string | null;
  image: string | null;
  wordCount: number | null;
  minutes: number; // estimated reading minutes at generate time
  savedAt: string | null;
}

// Where the reader left off inside a magazine (magazine-level resume pointer).
export interface MagazinePosition {
  itemKey: string; // displayKey of the active item
  paragraphIndex: number; // paragraph within that item (-1/0 = opened, not yet deep)
  updatedAt: number; // epoch ms
}

export interface MagazineParams {
  order: 'shuffle' | 'recent' | 'oldest'; // mirrors DailyMagazineOrder
  targetMinutes: number;
  totalMinutes: number;
}

export interface Magazine {
  rkey: string;
  params: MagazineParams;
  items: MagazineItemSnapshot[];
  position: MagazinePosition | null;
  title: string | null;
  createdAt: number; // epoch seconds
  updatedAt: number; // epoch seconds
  deletedAt?: number | null;
}

// Integration types
export interface IntegrationStatus {
  scopeStatus: {
    margin: boolean;
    semble: boolean;
  };
}

// External-backed saves: which engine backs the Saved list (one per account).
// Mirrors the backend SaveBacking union (backend/src/routes/settings.ts).
export type SaveBacking =
  | { provider: 'skyreader' }
  | { provider: 'semble'; collectionUri: string }
  | { provider: 'margin'; collectionUri: string };

export interface SembleCollection {
  uri: string;
  cid: string;
  name?: string;
  description?: string;
  createdAt?: string;
}

export interface MarginCollection {
  uri: string;
  cid: string;
  name?: string;
  description?: string;
  createdAt?: string;
}

export interface TextQuoteSelector {
  type: 'TextQuoteSelector';
  exact: string;
  prefix?: string;
  suffix?: string;
}

export interface Highlight {
  id: string;
  selector: TextQuoteSelector;
  createdAt: number; // epoch ms
  // Optional note/comment the user attached to the highlight. Synced as a W3C
  // comment body on the Margin note when the highlight is pushed to the PDS.
  note?: string;
  // Set once the highlight has been pushed to Margin (at.margin.note on the user's PDS).
  marginUri?: string;
  marginRkey?: string;
}
