import type { useReaderStack } from '$lib/hooks/useReaderStack.svelte';
import { extractArticle } from '$lib/utils/roomArticle';
import { openOutside } from '$lib/utils/followLinks';
import type { BskyPost, BskyTextSegment } from '$lib/types';

// Bluesky posts in the river (docs/plans/BLUESKY_FEEDS_PLAN.md): the pieces the
// post card, the keyboard shortcuts and the reader stack share.

type ReaderStack = ReturnType<typeof useReaderStack>;

/** The article a post points at, if any: its own link card, a link in its text,
 *  or the card of the post it quotes. What opening a post reads. */
export function bskyPostLink(
  post: BskyPost
): { url: string; title?: string; description?: string; image?: string } | null {
  if (post.external) {
    return {
      url: post.external.uri,
      title: post.external.title || undefined,
      description: post.external.description || undefined,
      image: post.external.thumb,
    };
  }
  const facetLink = post.segments.find((s) => s.link && /^https?:\/\//.test(s.link))?.link;
  if (facetLink && !isBskyUrl(facetLink)) return { url: facetLink };
  if (post.quote && 'external' in post.quote && post.quote.external) {
    const e = post.quote.external;
    return {
      url: e.uri,
      title: e.title || undefined,
      description: e.description || undefined,
      image: e.thumb,
    };
  }
  return null;
}

function isBskyUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'bsky.app' || host.endsWith('.bsky.app');
  } catch {
    return false;
  }
}

/**
 * Open what a post links to in the reader without saving it (the follows-link
 * path). A page the extractor can't read opens in a new tab, as does a post
 * with no link at all (its thread, on Bluesky).
 */
export async function openBskyPost(
  post: BskyPost,
  reader: Pick<ReaderStack, 'openReader'>
): Promise<void> {
  const link = bskyPostLink(post);
  if (!link) {
    openOutside(post.url);
    return;
  }
  const saved = await extractArticle(link);
  if (!saved) {
    openOutside(link.url);
    return;
  }
  reader.openReader({ type: 'saved', item: saved, key: link.url });
}

/** Where a text segment goes when clicked: its link, the mentioned profile, or
 *  the tag's search, all on Bluesky except a plain link. */
export function segmentHref(seg: BskyTextSegment): string | null {
  if (seg.link) return seg.link;
  if (seg.mention) return `https://bsky.app/profile/${seg.mention}`;
  if (seg.tag) return `https://bsky.app/hashtag/${encodeURIComponent(seg.tag)}`;
  return null;
}

/** The profile page of an actor on Bluesky. */
export function profileUrl(actor: { handle: string; did: string }): string {
  return `https://bsky.app/profile/${actor.handle || actor.did}`;
}

/** "3m", "5h", "2d", or a date past a week: how Bluesky dates a post. */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(t).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(new Date(t).getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}),
  });
}

/** A count as Bluesky shows it: 1.2K, 3.4M. */
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** Bluesky's post length limit, in graphemes. */
export const POST_MAX_GRAPHEMES = 300;

export function graphemeLength(text: string): number {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    let n = 0;
    for (const _ of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) n++;
    return n;
  }
  return [...text].length;
}
