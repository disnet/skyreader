import type { Article } from '$lib/types';
import type { FeedDisplayItem } from '$lib/stores/feedView.svelte';
import { getExternalArticleLink } from '$lib/utils/linkPost';

export interface ShareTarget {
  article: Article;
  /** at:// URI of the source document when sharing a document = quote-reshare. */
  repostUri?: string;
}

/**
 * The Article a linkblog share of this display item points at, plus the
 * repost credit when the item is someone's document. One rule shared by the
 * reader chrome and the Discussion rail so both build the identical share.
 */
export function shareTargetForDisplayItem(
  readerItem: FeedDisplayItem,
  normalized: { url: string; title: string; publishedAt: string },
  linkPostAuthor?: string
): ShareTarget | null {
  const itemUrl = normalized.url;
  if (!itemUrl) return null;
  if (readerItem.type === 'article') return { article: readerItem.item };
  if (readerItem.type === 'saved') {
    const saved = readerItem.item;
    return {
      article: {
        subscriptionId: 0,
        guid: saved.url,
        url: saved.url,
        title: saved.title ?? saved.url,
        author: saved.author ?? undefined,
        summary: saved.description ?? undefined,
        imageUrl: saved.image ?? undefined,
        publishedAt: saved.publishedAt ?? saved.savedAt,
        fetchedAt: Date.now(),
      },
    };
  }

  const document = readerItem.item;
  const image = document.coverImageCid
    ? `https://cdn.bsky.app/img/feed_fullsize/plain/${document.authorDid}/${document.coverImageCid}@jpeg`
    : undefined;
  // A link post shares the external article; a normal document shares its own
  // canonical URL. Either way the entry lands in the user's linkblog keyed by
  // that URL, crediting the source document via repostUri.
  const externalUrl = getExternalArticleLink(document);
  return {
    article: {
      subscriptionId: 0,
      guid: externalUrl ?? itemUrl,
      url: externalUrl ?? itemUrl,
      title: normalized.title || itemUrl,
      author: linkPostAuthor,
      summary: document.description ?? undefined,
      imageUrl: image,
      publishedAt: normalized.publishedAt,
      fetchedAt: Date.now(),
    },
    repostUri: document.recordUri,
  };
}
