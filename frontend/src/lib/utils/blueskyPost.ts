import type { ShareDraftBlock } from '$lib/types';

/**
 * Turning a share draft into a Bluesky post.
 *
 * A linkblog note can run to 3,000 characters; a Bluesky post is 300. So the
 * cross-post is planned, not copied: commentary becomes the post's text, and
 * quoted passages either go out as images ("text shots") or, with those off,
 * inline in the text. Bluesky embeds a link card or images, never both, so a
 * post with text shots carries the article's link in its text instead.
 */

export const BLUESKY_MAX_GRAPHEMES = 300;
export const BLUESKY_MAX_IMAGES = 4;
const LINK_DISPLAY_MAX = 32;

function segments(text: string): string[] {
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
  if (lastSpace > cut.length * 0.7) cut = cut.slice(0, lastSpace);
  return { text: `${cut.trimEnd()}…`, trimmed: true };
}

/** The article link as Bluesky's composer shows one: host + path, shortened. */
export function shortLink(url: string): string {
  let display: string;
  try {
    const u = new URL(url);
    display = u.host.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname) + u.search;
  } catch {
    display = url;
  }
  const chars = segments(display);
  return chars.length > LINK_DISPLAY_MAX
    ? `${chars.slice(0, LINK_DISPLAY_MAX - 1).join('')}…`
    : display;
}

export interface BlueskyPostPlan {
  text: string;
  /** Where the article link sits in `text` (only when the post carries images). */
  linkText?: string;
  /** Quoted passages to render as images, in draft order. */
  shots: string[];
  /** The text had to be cut to fit. */
  trimmed: boolean;
  /** Quotes beyond Bluesky's four images, left out. */
  droppedQuotes: number;
}

export function planBlueskyPost(
  blocks: ShareDraftBlock[],
  articleUrl: string,
  options: { textShots: boolean }
): BlueskyPostPlan {
  const filled = blocks
    .map((b) => ({ kind: b.kind, text: b.text.trim() }))
    .filter((b) => b.text !== '');
  const quotes = filled.filter((b) => b.kind === 'quote').map((b) => b.text);

  if (options.textShots && quotes.length > 0) {
    const shots = quotes.slice(0, BLUESKY_MAX_IMAGES);
    const commentary = filled
      .filter((b) => b.kind === 'text')
      .map((b) => b.text)
      .join('\n\n');
    const linkText = shortLink(articleUrl);
    const separator = commentary ? '\n\n' : '';
    const budget = BLUESKY_MAX_GRAPHEMES - graphemeLength(separator + linkText);
    const body = fitGraphemes(commentary, budget);
    return {
      text: `${body.text}${body.text ? separator : ''}${linkText}`,
      linkText,
      shots,
      trimmed: body.trimmed,
      droppedQuotes: quotes.length - shots.length,
    };
  }

  // No images: the link card carries the article, and quotes read inline.
  const joined = filled
    .map((b) => (b.kind === 'quote' ? `“${b.text.replace(/\s*\n\s*/g, ' ')}”` : b.text))
    .join('\n\n');
  const body = fitGraphemes(joined, BLUESKY_MAX_GRAPHEMES);
  return { text: body.text, shots: [], trimmed: body.trimmed, droppedQuotes: 0 };
}
