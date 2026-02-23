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

export type SubscriptionSourceType =
  | 'rss'
  | 'atproto.shares'
  | 'atproto.documents'
  | 'atproto.collection';

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
  customTitle?: string; // User-set title override (local only)
  customIconUrl?: string; // User-set icon override (local only)
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

export interface ShareReadPosition {
  id?: number;
  rkey?: string;
  shareUri: string;
  shareAuthorDid: string;
  itemUrl: string;
  itemTitle?: string;
  readAt: string;
}

// Unified social read position types
export type SocialItemType = 'share' | 'document';

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

export interface SocialShare {
  id?: number;
  authorDid: string;
  recordUri: string;
  feedUrl?: string;
  itemUrl: string;
  itemTitle?: string;
  itemAuthor?: string;
  itemDescription?: string;
  itemImage?: string;
  itemGuid?: string;
  itemPublishedAt?: string;
  note?: string;
  content?: string;
  createdAt: string;
  reshareOf?: {
    uri: string;
    authorDid: string;
  };
  reshareCount?: number;
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
  tags?: string[];
  updatedAt?: string;
  canonicalUrl?: string;
  content?: LeafletContent | PcktBlogContent | OffprintContent | GreengaleContent | unknown; // Open union for future content types
  indexedAt?: string;
  createdAt: string;
  siteIcon?: string;
}

// Grouped share for deduplicated feed
export interface GroupedShare {
  itemUrl: string;
  itemTitle?: string;
  itemAuthor?: string;
  itemDescription?: string;
  itemImage?: string;
  itemGuid?: string;
  itemPublishedAt?: string;
  feedUrl?: string;
  content?: string;
  sharers: Array<{
    did: string;
    recordUri: string;
    createdAt: string;
    note?: string;
    reshareCount: number;
  }>;
  firstSharer: {
    did: string;
    recordUri: string;
  };
  totalShareCount: number;
  latestShareAt: string;
}

// Reshare activity item (grouped by article)
export interface ReshareActivity {
  originalShare: {
    uri: string;
    itemUrl: string;
    itemTitle?: string;
  };
  resharers: Array<{
    did: string;
    resharedAt: string;
  }>;
  totalCount: number;
  latestReshareAt: string;
}

// Profile info fetched from Bluesky
export interface BlueskyProfile {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
}

export interface UserShare {
  id?: number;
  rkey?: string;
  subscriptionRkey?: string;
  feedUrl?: string;
  articleGuid: string;
  articleUrl: string;
  articleTitle?: string;
  articleAuthor?: string;
  articleDescription?: string;
  articleContent?: string;
  articleImage?: string;
  articlePublishedAt?: string;
  note?: string;
  createdAt: string;
  reshareOf?: {
    uri: string;
    authorDid: string;
  };
  reshareCount?: number;
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
}

// Combined feed item for unified "all" view
export type CombinedFeedItem =
  | { type: 'article'; item: Article; date: string }
  | { type: 'share'; item: SocialShare; date: string }
  | { type: 'document'; item: SocialDocument; date: string };

export interface FilteredView {
  id?: number;
  name: string;
  // Unified source filter (new format)
  sourceMode?: 'all' | 'include';
  sourceKeys?: string[];
  // Legacy fields (kept for backward compat with existing IndexedDB records)
  showArticles?: boolean;
  showShares?: boolean;
  showDocuments?: boolean;
  feedMode?: 'none' | 'all' | 'include' | 'exclude';
  feedIds?: number[];
  accountMode?: 'none' | 'all' | 'include' | 'exclude';
  accountDids?: string[];
  readFilter: 'all' | 'unread' | 'read';
  sortOrder: 'newest' | 'oldest';
  tagFilter?: string[];
  typeFilter?: SubscriptionSourceType[];
  createdAt: number;
  updatedAt: number;
  position: number;
}

export interface ItemTags {
  itemKey: string;
  tags: string[];
  itemType: ItemLabelType;
}

export type ItemLabelType = 'article' | 'share' | 'document' | 'userShare' | 'saved';

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
  source?: 'url' | 'feed' | 'share' | 'document';
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
}
