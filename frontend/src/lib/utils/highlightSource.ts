import type { Article, Highlight, ItemLabelType, SavedItem, SocialDocument } from '$lib/types';
import type { FeedDisplayItem } from '$lib/stores/feedView.svelte';
import { decodeEntities } from '$lib/utils/entities';

// Resolving "what article is this highlight from" is shared by the Highlights
// list and the review deck, and the two must degrade identically: a highlight
// imported from Margin whose article was never cached locally has no article,
// document or save to hang a title on — only the `sourceTitle`/`sourceUrl`
// carried on the highlight itself. Keeping this in one place is what stops the
// review deck rendering a blank source line where the list shows a real one.

export interface HighlightSourceLookups {
  articlesByGuid: Map<string, Article>;
  documentsByUri: Map<string, SocialDocument>;
  savedByKey: Map<string, SavedItem>;
}

export interface HighlightSource {
  title: string;
  url: string | null;
  domain: string | null;
  /** The item to open in the in-app reader; null when nothing local backs it. */
  displayItem: FeedDisplayItem | null;
}

export function buildHighlightSourceLookups(
  articles: Article[],
  documents: SocialDocument[],
  saves: SavedItem[]
): HighlightSourceLookups {
  const savedByKey = new Map<string, SavedItem>();
  for (const save of saves) {
    if (save.itemGuid) savedByKey.set(save.itemGuid, save);
    if (save.uri) savedByKey.set(save.uri, save);
  }
  return {
    articlesByGuid: new Map(articles.map((a) => [a.guid, a])),
    documentsByUri: new Map(documents.map((d) => [d.recordUri, d])),
    savedByKey,
  };
}

export function domainFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Resolve the source article for a highlight: local article → social document →
 * saved copy → the highlight's own `sourceTitle`/`sourceUrl` (imported
 * highlights). Only the first three can open in the in-app reader; the last
 * falls back to the external URL.
 */
export function resolveHighlightSource(
  itemKey: string,
  itemType: ItemLabelType,
  lookups: HighlightSourceLookups,
  highlight?: Pick<Highlight, 'sourceUrl' | 'sourceTitle'>
): HighlightSource {
  let title = '';
  let url: string | null = null;
  let displayItem: FeedDisplayItem | null = null;

  if (itemType === 'article') {
    const article = lookups.articlesByGuid.get(itemKey);
    if (article) {
      title = article.title;
      url = article.url;
      displayItem = { type: 'article', item: article, key: article.guid };
    }
  } else if (itemType === 'document') {
    const document = lookups.documentsByUri.get(itemKey);
    if (document) {
      title = document.title;
      url = document.canonicalUrl ?? null;
      displayItem = { type: 'document', item: document, key: document.recordUri };
    }
  }

  // Fall back to a saved copy (carries title/url, and can open in the reader).
  if (!displayItem) {
    const save = lookups.savedByKey.get(itemKey);
    if (save) {
      title = title || save.title || '';
      url = url || save.url || null;
      displayItem = { type: 'saved', item: save, key: save.itemGuid || save.uri };
    }
  }

  // Last resort: metadata carried on the highlight (Margin imports).
  if (!title && highlight?.sourceTitle) title = highlight.sourceTitle;
  if (!url && highlight?.sourceUrl) url = highlight.sourceUrl;
  // An unmatched import keys off its normalized URL, which is a usable link.
  if (!url && /^https?:\/\//i.test(itemKey)) url = itemKey;

  const resolvedTitle = decodeEntities(title) || domainFromUrl(url) || 'Untitled';
  return { title: resolvedTitle, url, domain: domainFromUrl(url), displayItem };
}
