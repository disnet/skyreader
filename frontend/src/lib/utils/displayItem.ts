import type { FeedDisplayItem } from '$lib/stores/feedView.svelte';
import type { Subscription } from '$lib/types';
import { getFaviconUrl } from '$lib/utils/favicon';
import { isLeafletContent, renderLeafletContent } from '$lib/utils/leaflet-renderer';
import { isPcktBlogContent, renderPcktBlogContent } from '$lib/utils/pckt-blog-renderer';
import { isOffprintContent, renderOffprintContent } from '$lib/utils/offprint-renderer';
import { isGreengaleContent, renderGreengaleContent } from '$lib/utils/greengale-renderer';
import { getDocumentEffectiveUrl } from '$lib/utils/linkPost';
import type {
  LeafletContent,
  PcktBlogContent,
  OffprintContent,
  GreengaleContent,
} from '$lib/types';

export interface NormalizedDisplayItem {
  title: string;
  url: string;
  publishedAt: string;
  displayContent: string;
  faviconUrl: string;
  /** DID of the author for documents, undefined for articles */
  authorDid: string | undefined;
  /** Label type for itemLabels operations */
  labelItemType: 'article' | 'document' | 'saved';
}

/**
 * Normalize a FeedDisplayItem into a flat object with common display fields.
 * Eliminates the repeated type-switching pattern across components.
 *
 * @param item - The feed display item to normalize
 * @param sub - The subscription for article items (optional)
 */
export function normalizeDisplayItem(
  item: FeedDisplayItem,
  sub?: Subscription
): NormalizedDisplayItem {
  return {
    title: getTitle(item),
    url: getUrl(item),
    publishedAt: getPublishedAt(item),
    displayContent: getDisplayContent(item),
    faviconUrl: getFavicon(item, sub),
    authorDid: getAuthorDid(item),
    labelItemType: item.type,
  };
}

function getTitle(item: FeedDisplayItem): string {
  if (item.type === 'article') return item.item.title || item.item.url;
  if (item.type === 'document') return item.item.title || item.item.recordUri;
  if (item.type === 'saved') return item.item.title || item.item.url;
  return '';
}

function getUrl(item: FeedDisplayItem): string {
  if (item.type === 'article') return item.item.url;
  // Link posts resolve to the external article; normal docs to their permalink.
  if (item.type === 'document') return getDocumentEffectiveUrl(item.item);
  if (item.type === 'saved') return item.item.url;
  return '';
}

function getPublishedAt(item: FeedDisplayItem): string {
  if (item.type === 'article') return item.item.publishedAt;
  if (item.type === 'document') return item.item.publishedAt;
  if (item.type === 'saved') return item.item.publishedAt || item.item.savedAt;
  return '';
}

export function getDisplayContent(item: FeedDisplayItem): string {
  if (item.type === 'article') {
    return item.item.content || item.item.summary || '';
  }
  if (item.type === 'document') {
    const doc = item.item;
    if (doc.content && isLeafletContent(doc.content)) {
      return renderLeafletContent(doc.content as LeafletContent, doc.authorDid);
    }
    if (doc.content && isPcktBlogContent(doc.content)) {
      return renderPcktBlogContent(doc.content as PcktBlogContent, doc.authorDid);
    }
    if (doc.content && isOffprintContent(doc.content)) {
      return renderOffprintContent(doc.content as OffprintContent, doc.authorDid);
    }
    if (doc.content && isGreengaleContent(doc.content)) {
      return renderGreengaleContent(doc.content as GreengaleContent, doc.authorDid);
    }
    return doc.textContent || doc.description || '';
  }
  if (item.type === 'saved') {
    return item.item.content || item.item.description || '';
  }
  return '';
}

function getFavicon(item: FeedDisplayItem, sub?: Subscription): string {
  if (item.type === 'article') {
    return getFaviconUrl(sub?.siteUrl || sub?.feedUrl || item.item.url);
  }
  if (item.type === 'document') {
    // Link posts use the external article's favicon; normal docs the site icon.
    const effective = getDocumentEffectiveUrl(item.item);
    if (effective.startsWith('http') && effective !== (item.item.canonicalUrl || ''))
      return getFaviconUrl(effective);
    if (item.item.siteIcon) return item.item.siteIcon;
    if (item.item.canonicalUrl) return getFaviconUrl(item.item.canonicalUrl);
  }
  if (item.type === 'saved') return getFaviconUrl(item.item.url);
  const url = getUrl(item);
  return url ? getFaviconUrl(url) : '';
}

function getAuthorDid(item: FeedDisplayItem): string | undefined {
  if (item.type === 'document') return item.item.authorDid;
  return undefined;
}

/**
 * Build the author label string given the normalized item and an optional profile.
 * This is kept separate since it depends on async profile data.
 */
export function getAuthorLabel(
  item: FeedDisplayItem,
  authorProfile: { handle?: string } | null
): string {
  if (item.type === 'article' && item.item.author) return `by ${item.item.author}`;
  if (item.type === 'document') {
    const handle = authorProfile?.handle || item.item.authorDid;
    return `by @${handle}`;
  }
  if (item.type === 'saved' && item.item.author) return `by ${item.item.author}`;
  return '';
}

/** Metadata shape for saving to Semble */
export interface SembleMetadata {
  url: string;
  title?: string;
  description?: string;
  author?: string;
  publishedAt?: string;
}

/** Metadata shape for saving to Margin */
export interface MarginMetadata {
  url: string;
  title?: string;
  description?: string;
}

/** Extract metadata for saving a display item to Semble */
export function extractSembleMetadata(item: FeedDisplayItem): SembleMetadata {
  switch (item.type) {
    case 'article':
      return {
        url: item.item.url,
        title: item.item.title,
        description: item.item.summary,
        author: item.item.author,
        publishedAt: item.item.publishedAt,
      };
    case 'document':
      return {
        url: getDocumentEffectiveUrl(item.item),
        title: item.item.title,
        description: item.item.description,
        publishedAt: item.item.publishedAt,
      };
    case 'saved':
      return {
        url: item.item.url,
        title: item.item.title ?? undefined,
        description: item.item.description ?? undefined,
        author: item.item.author ?? undefined,
        publishedAt: item.item.publishedAt ?? undefined,
      };
  }
}

/** Extract metadata for saving a display item to Margin */
export function extractMarginMetadata(item: FeedDisplayItem): MarginMetadata {
  const data = extractSembleMetadata(item);
  return { url: data.url, title: data.title, description: data.description };
}
