import type { useReaderStack } from '$lib/hooks/useReaderStack.svelte';
import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
import { extractArticle } from '$lib/utils/roomArticle';
import { decodeEntities } from '$lib/utils/entities';
import { toastStore } from '$lib/stores/toast.svelte';
import type { Article, FollowLink, FollowLinkSharer } from '$lib/types';

// Shared by the river's follows rows and Home's "Shared by people you follow"
// lane, so both open a link, mark it read and describe its sharers the same way.
// See docs/plans/FOLLOWS_LINKS_PLAN.md.

type ReaderStack = ReturnType<typeof useReaderStack>;

/**
 * The item key a follows link is read under, and its row key in the river. The
 * normalized URL, not the posted one: the posted URL is whichever sharer's card
 * won, so it can change between loads, and read state mustn't change with it.
 */
export function followLinkReadKey(link: Pick<FollowLink, 'urlNormalized'>): string {
  return link.urlNormalized;
}

/** Mark a follows link read, the same label an RSS article gets. */
export function markFollowLinkRead(link: FollowLink): void {
  itemLabelsStore.markAsRead('', followLinkReadKey(link), link.url, followLinkTitle(link));
}

/** Whose words a link's card quotes: the sharer whose post about it has the
 *  most likes, the latest of them on a tie (sharers arrive newest first).
 *  Reposts carry no words of their own, so they're skipped. */
export function followLinkSaid(link: FollowLink): { text: string; name: string } | null {
  let said: FollowLinkSharer | null = null;
  for (const s of link.sharers) {
    if (s.kind === 'repost' || !s.text?.trim()) continue;
    if (!said || (s.likeCount ?? 0) > (said.likeCount ?? 0)) said = s;
  }
  return said?.text ? { text: said.text.trim(), name: nameOf(said) } : null;
}

/**
 * A follows link as the article a river card renders: its card title and blurb
 * (for search and the "Shared by" rows' metadata; the card draws the link card
 * instead), dated by its first share. No subscription (id -1) and no body; the
 * card fetches the page itself, and opening it goes through openFollowLink,
 * never the feed-article path.
 */
export function followLinkArticle(link: FollowLink): Article {
  return {
    subscriptionId: -1,
    guid: followLinkReadKey(link),
    url: link.url,
    title: followLinkTitle(link),
    summary: link.description ? decodeEntities(link.description) : undefined,
    imageUrl: link.thumb ?? undefined,
    publishedAt: new Date(link.firstSharedAt).toISOString(),
    fetchedAt: link.lastSharedAt,
  };
}

/**
 * Open a follows link in the reader without saving it (the rooms path), and
 * mark it read. A page the extractor can't read opens in a new tab instead,
 * which still counts as read.
 */
export async function openFollowLink(
  link: FollowLink,
  reader: Pick<ReaderStack, 'openReader'>
): Promise<void> {
  markFollowLinkRead(link);
  const saved = await extractArticle({
    url: link.url,
    title: link.title,
    description: link.description,
    image: link.thumb,
  });
  if (!saved) {
    openOutside(link.url);
    return;
  }
  reader.openReader({ type: 'saved', item: saved, key: link.url });
}

/**
 * Open a URL in a new tab after an await. By then the click no longer counts
 * as a user gesture, so a popup blocker (Safari's, notably) may refuse the tab;
 * when it does, a toast carries the link, and tapping that is a fresh gesture.
 * `noopener` would make window.open return null either way, so the opener is
 * cut by hand instead.
 */
function openOutside(url: string): void {
  const tab = window.open(url, '_blank');
  if (tab) {
    tab.opener = null;
    return;
  }
  const id = toastStore.add('');
  toastStore.update(id, 'error', "This one doesn't open in Skyreader.", {
    label: 'Open it',
    href: url,
  });
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
  // Words, each mostly letters, with plain numbers allowed among them
  // ("best-books-of-2026"): a slug, not an id. At least three real words, so a
  // mixed id ("a1b2-c3d4") or a short path ("/about") keeps the site.
  const isWord = (w: string) => /^[\p{L}'’]+\d*$/u.test(w);
  if (!words.every((w) => isWord(w) || /^\d+$/.test(w))) return site;
  if (words.filter(isWord).length < 3) return site;
  // Slugs are almost always lowercase; one that kept an acronym ("AI") keeps it.
  const text = words.map((w) => (/^\p{Lu}{2,}\d*$/u.test(w) ? w : w.toLowerCase())).join(' ');
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

/** The card pill's name line, after "Shared by": "Maya", "Maya +2". */
export function sharedByPill(sharers: Pick<FollowLinkSharer, 'name' | 'handle'>[]): string {
  if (sharers.length === 0) return '';
  const first = nameOf(sharers[0]);
  return sharers.length === 1 ? first : `${first} +${sharers.length - 1}`;
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

/** The bsky.app page for a post at-uri; for any other at-uri, its author's
 *  profile; bsky.app itself if there's no author to find. */
export function bskyPostUrl(postUri: string): string {
  const m = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(postUri);
  if (m) return `https://bsky.app/profile/${m[1]}/post/${m[2]}`;
  const author = /^at:\/\/([^/]+)/.exec(postUri)?.[1];
  return author ? `https://bsky.app/profile/${author}` : 'https://bsky.app';
}
