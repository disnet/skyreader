import type { ShareDraftBlock } from '$lib/types';

/**
 * Turning a share draft into a Bluesky post.
 *
 * A linkblog note can run to 3,000 characters; a Bluesky post is 300. So the
 * cross-post is planned, not copied: commentary becomes the post's text, and
 * quoted passages either go out as images ("text shots") or, with those off,
 * inline in the text. Bluesky embeds a link card or images, never both, so a
 * post with text shots carries the article's link in its text instead.
 *
 * Every post also ends on a link to the article's Discussion page
 * (read.skyreader.app/<article URL>), so whoever sees it on Bluesky can follow
 * the wider conversation. It adds to the article link, never replaces it.
 */

export const BLUESKY_MAX_GRAPHEMES = 300;
export const BLUESKY_MAX_IMAGES = 4;
const LINK_DISPLAY_MAX = 32;

/** Text split into graphemes (👩‍👩‍👧 is one), so a cut never splits a character. */
export function segments(text: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    return Array.from(
      new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
      (s) => s.segment
    );
  }
  return [...text];
}

/** Characters as Bluesky counts them (graphemes: 👩‍👩‍👧 is one). */
export function graphemeLength(text: string): number {
  return segments(text).length;
}

/**
 * Fit `text` into `budget` graphemes, cutting at a word boundary where one is
 * close and marking the cut with an ellipsis.
 */
export function fitGraphemes(text: string, budget: number): { text: string; trimmed: boolean } {
  const chars = segments(text);
  if (chars.length <= budget) return { text, trimmed: false };
  if (budget <= 1) return { text: '', trimmed: true };
  let cut = chars.slice(0, budget - 1).join('');
  const lastSpace = cut.search(/\s\S*$/);
  if (lastSpace > cut.length * 0.7) {
    cut = cut.slice(0, lastSpace);
  } else {
    // Never end on part of a URL or hashtag: it would still read as one
    // (Bluesky and our own facets both find it), just to the wrong place.
    const partial = /(^|\s)(https?:\/\/|[#＃])\S*$/.exec(cut);
    if (partial) cut = cut.slice(0, partial.index);
  }
  return { text: `${cut.trimEnd()}…`, trimmed: true };
}

/** `display` cut to `max` graphemes, the cut marked with an ellipsis. */
function shorten(display: string, max: number): string {
  const chars = segments(display);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : display;
}

/** A link as Bluesky's composer shows one: host + path, no scheme or www. */
function linkDisplay(url: string): string {
  try {
    const u = new URL(url);
    return u.host.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname) + u.search;
  } catch {
    return url;
  }
}

/** The article link as Bluesky's composer shows one: host + path, shortened. */
export function shortLink(url: string): string {
  return shorten(linkDisplay(url), LINK_DISPLAY_MAX);
}

/** The Discussion line's label; the link text follows it. */
export const DISCUSSION_LABEL = 'Discussion: ';

// How much of the article the Discussion link shows after the read host: enough
// to say which site it is, short enough to leave the reader's words their room.
const DISCUSSION_ARTICLE_MAX = 20;

/**
 * The Discussion page's link as the post shows it: the read host (and, in dev,
 * its /link prefix) in full, then the article's host and path, shortened. The
 * article's scheme is left out of the display (the facet carries the address).
 */
export function discussionLinkText(discussionUrl: string, articleUrl: string): string {
  try {
    const page = new URL(discussionUrl);
    const prefix = page.host + page.pathname.replace(/\/https?:\/\/.*$/, '').replace(/\/$/, '');
    return `${prefix}/${shorten(linkDisplay(articleUrl), DISCUSSION_ARTICLE_MAX)}`;
  } catch {
    return shorten(discussionUrl, LINK_DISPLAY_MAX);
  }
}

export interface BlueskyPostPlan {
  text: string;
  /** Where the article link sits in `text` (only when the post carries images). */
  linkText?: string;
  /** Where the Discussion page's link sits in `text`, when the post carries one. */
  discussionText?: string;
  /** Quoted passages to render as images, in draft order. */
  shots: string[];
  /** The text had to be cut to fit. */
  trimmed: boolean;
  /**
   * What the text would run to uncut, in graphemes: the composer's count ring
   * shows this, so writing past the limit reads as over rather than silently cut.
   */
  length: number;
  /** Quotes beyond Bluesky's four images, left out. */
  droppedQuotes: number;
}

export function planBlueskyPost(
  blocks: ShareDraftBlock[],
  articleUrl: string,
  options: {
    textShots: boolean;
    /** The article's Discussion page; the post ends on a link to it when given. */
    discussionUrl?: string | null;
  }
): BlueskyPostPlan {
  const filled = blocks
    .map((b) => ({ kind: b.kind, text: b.text.trim() }))
    .filter((b) => b.text !== '');
  const quotes = filled.filter((b) => b.kind === 'quote').map((b) => b.text);
  const discussionText = options.discussionUrl
    ? discussionLinkText(options.discussionUrl, articleUrl)
    : undefined;

  // What the post must end on, whatever the commentary runs to: the article's
  // link (with images, where the card can't carry it) and the Discussion line.
  // The commentary is cut to make room for them, never the other way round.
  function withTail(body: string, links: string[]) {
    const tail = links.join('\n');
    const separator = body && tail ? '\n\n' : '';
    const budget = BLUESKY_MAX_GRAPHEMES - graphemeLength(separator + tail);
    const fitted = fitGraphemes(body, budget);
    return {
      text: `${fitted.text}${fitted.text ? separator : ''}${tail}`,
      trimmed: fitted.trimmed,
      length: graphemeLength(`${body}${separator}${tail}`),
    };
  }
  const discussionLine = discussionText ? [`${DISCUSSION_LABEL}${discussionText}`] : [];

  if (options.textShots && quotes.length > 0) {
    const shots = quotes.slice(0, BLUESKY_MAX_IMAGES);
    const commentary = filled
      .filter((b) => b.kind === 'text')
      .map((b) => b.text)
      .join('\n\n');
    const linkText = shortLink(articleUrl);
    const post = withTail(commentary, [linkText, ...discussionLine]);
    return {
      ...post,
      linkText,
      ...(discussionText ? { discussionText } : {}),
      shots,
      droppedQuotes: quotes.length - shots.length,
    };
  }

  // No images: the link card carries the article, and quotes read inline.
  const joined = filled
    .map((b) => (b.kind === 'quote' ? `“${b.text.replace(/\s*\n\s*/g, ' ')}”` : b.text))
    .join('\n\n');
  const post = withTail(joined, discussionLine);
  return {
    ...post,
    ...(discussionText ? { discussionText } : {}),
    shots: [],
    droppedQuotes: 0,
  };
}
