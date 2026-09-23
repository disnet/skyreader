import type { useReaderStack } from '$lib/hooks/useReaderStack.svelte';
import { followLinksStore } from '$lib/stores/followLinks.svelte';
import { extractArticle } from '$lib/utils/roomArticle';
import { decodeEntities } from '$lib/utils/entities';
import type { FollowLink, FollowLinkSharer } from '$lib/types';

// Shared by the /following page and Home's "Shared by people you follow" lane,
// so both open a link and describe its sharers the same way.
// See docs/plans/FOLLOWS_LINKS_PLAN.md.

type ReaderStack = ReturnType<typeof useReaderStack>;

/**
 * Open a follows link in the reader without saving it (the rooms path), and
 * mark it opened. A page the extractor can't read opens in a new tab instead,
 * which still counts as opened.
 */
export async function openFollowLink(link: FollowLink, reader: ReaderStack): Promise<void> {
  followLinksStore.markOpened(link.url, link.urlNormalized);
  const saved = await extractArticle({
    url: link.url,
    title: link.title,
    description: link.description,
    image: link.thumb,
  });
  if (!saved) {
    window.open(link.url, '_blank', 'noopener');
    return;
  }
  reader.openReader({ type: 'saved', item: saved, key: link.url });
}

/**
 * A readable title for a link a follow shared bare (no link card, so no title):
 * the URL's last path segment when it reads like words
 * ("/p/microdramas-are-the-death-rattle" becomes "Microdramas are the death
 * rattle"), else the site. Opaque ids (rkeys, hashes) stay the site.
 */
export function titleFromUrl(url: string, site: string): string {
  let segment = '';
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    segment = decodeURIComponent(parts[parts.length - 1] ?? '');
  } catch {
    return site;
  }
  const words = segment
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .split(/[-_+]+/)
    .filter(Boolean);
  // Three or more words, each mostly letters: a slug, not an id.
  if (words.length < 3 || !words.every((w) => /^[\p{L}'’]+\d*$/u.test(w))) return site;
  const text = words.join(' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What to call a link: its card title, else a title read off its URL. */
export function followLinkTitle(link: Pick<FollowLink, 'title' | 'url' | 'site'>): string {
  return decodeEntities(link.title ?? '') || titleFromUrl(link.url, link.site);
}

function nameOf(s: Pick<FollowLinkSharer, 'name' | 'handle'>): string {
  return s.name?.trim() || s.handle || 'Someone';
}

/** "Maya shared this", "Maya and Ben shared this", "Maya and 3 others shared this".
 *  Sharers arrive newest first, so the name up front is the latest to share. */
export function sharedByLabel(sharers: Pick<FollowLinkSharer, 'name' | 'handle'>[]): string {
  if (sharers.length === 0) return '';
  if (sharers.length === 1) return `${nameOf(sharers[0])} shared this`;
  if (sharers.length === 2) return `${nameOf(sharers[0])} and ${nameOf(sharers[1])} shared this`;
  return `${nameOf(sharers[0])} and ${sharers.length - 1} others shared this`;
}

/** The lane-tile version: the tile's meta line fits "8 min read", not a
 *  sentence, and the lane's own title already says who's sharing. "Maya
 *  shared" for one (first name only), "3 shared" for more. */
export function sharedByShort(sharers: Pick<FollowLinkSharer, 'name' | 'handle'>[]): string {
  if (sharers.length === 0) return '';
  if (sharers.length > 1) return `${sharers.length} shared`;
  const s = sharers[0];
  const first = s.name?.trim().split(/\s+/)[0] || s.handle || 'Someone';
  return `${first} shared`;
}

/** The bsky.app page for a post at-uri, or the author's profile if it won't parse. */
export function bskyPostUrl(postUri: string): string {
  const m = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(postUri);
  if (!m) return 'https://bsky.app';
  return `https://bsky.app/profile/${m[1]}/post/${m[2]}`;
}
