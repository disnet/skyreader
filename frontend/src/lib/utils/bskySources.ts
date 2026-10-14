import type { Subscription } from '$lib/types';
import { decodeEntities } from './entities';

/**
 * Bluesky likes and bookmarks as sources. The posts a reader liked or
 * bookmarked on Bluesky that carry a link are gathered server-side (see
 * backend/src/services/bsky-sources.ts) into one private subscription each,
 * `feedUrl` `bsky-likes:<did>` / `bsky-bookmarks:<did>`. Like a newsletter it
 * isn't fetchable and never on the PDS, and its items sit in the same D1
 * archive as RSS, so everything that reads the archive treats it like a feed.
 */
export type BskySourceKind = 'likes' | 'bookmarks';

export const BSKY_LIKES_SOURCE_TYPE = 'bsky.likes';
export const BSKY_BOOKMARKS_SOURCE_TYPE = 'bsky.bookmarks';

export function isBskySource(sourceType: string | undefined): boolean {
  return sourceType === BSKY_LIKES_SOURCE_TYPE || sourceType === BSKY_BOOKMARKS_SOURCE_TYPE;
}

export function isBskySourceSubscription(
  sub: Pick<Subscription, 'sourceType' | 'feedUrl'>
): boolean {
  return (
    isBskySource(sub.sourceType) ||
    !!sub.feedUrl?.startsWith('bsky-likes:') ||
    !!sub.feedUrl?.startsWith('bsky-bookmarks:')
  );
}

export function bskySourceKind(
  sub: Pick<Subscription, 'sourceType' | 'feedUrl'>
): BskySourceKind | null {
  if (sub.sourceType === BSKY_LIKES_SOURCE_TYPE || sub.feedUrl?.startsWith('bsky-likes:')) {
    return 'likes';
  }
  if (sub.sourceType === BSKY_BOOKMARKS_SOURCE_TYPE || sub.feedUrl?.startsWith('bsky-bookmarks:')) {
    return 'bookmarks';
  }
  return null;
}

/** The link card a kept post links to, as the feed card draws it. */
export interface KeptPostLinkCard {
  title: string;
  description: string | null;
  thumb: string | null;
  domain: string;
}

function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** The post's own words, read back out of the item's `contentLead` quote. */
function postTextOf(leadHtml: string | null | undefined): string {
  const quoted = leadHtml?.match(/<blockquote>([\s\S]*?)<\/blockquote>/)?.[1];
  if (!quoted) return '';
  return squash(decodeEntities(quoted.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')));
}

/**
 * The link card behind a liked or bookmarked post. The item IS the linked
 * article, but until its page is fetched the card shows only the post's words,
 * which read as a post, not as a way into an article. So the article gets the
 * card Bluesky draws for it: its title, blurb and site, thumbnail beside.
 *
 * The item's `title` and `summary` fall back to the post's own text when the
 * post had no embed card (see bskyPostItem in the backend); those would only
 * repeat the words above the card, so the card drops them and names the link.
 */
export function keptPostLinkCard(item: {
  url: string;
  title: string;
  summary?: string | null;
  imageUrl?: string | null;
  leadHtml?: string | null;
}): KeptPostLinkCard {
  let domain = item.url;
  let address = item.url;
  try {
    const u = new URL(item.url);
    domain = u.hostname.replace(/^www\./, '');
    address = `${domain}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    // keep the raw url
  }

  const postText = postTextOf(item.leadHtml);
  const fromPost = (s: string) => Boolean(postText) && postText.startsWith(s.replace(/…$/, ''));

  const title = squash(decodeEntities(item.title) || '');
  const summary = squash(decodeEntities(item.summary ?? '') || '');
  return {
    title: title && title !== domain && !fromPost(title) ? title : address,
    description: summary && !fromPost(summary) ? summary : null,
    thumb: item.imageUrl || null,
    domain,
  };
}
