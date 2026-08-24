/**
 * Trim a discussion entry down to what the person actually said.
 *
 * Lane notes come straight out of other people's records, and a large share of
 * what links an article on the Atmosphere is a bridge or a bot: the post text is
 * the article's headline, or the publication's name, followed by the URL —
 * sometimes with a second aggregator link and a stub word like "Discussion"
 * standing in for the link's label. Reprinting that under the article the reader
 * just finished is noise wearing a person's handle.
 *
 * So: drop the links, drop the titles we already show above, drop a bare link
 * label, and if nothing is left, say nothing. The caller decides what an entry
 * with no words looks like — see AtmospherePanel, which collects them into one
 * "Also linked" line instead of giving each an empty row.
 */

// Full URLs, including the wrapping parens a bot uses to tack a discussion link
// on the end.
const URL_PATTERN = /\(?\bhttps?:\/\/[^\s)]+\)?/gi;

// Bare and truncated URLs — what a Bluesky post actually stores, since the text
// carries the link's *display* form ("lucumr.pocoo.org/2026/8/22/fa…") while the
// real href lives in a facet we never see here.
const BARE_URL_PATTERN = /\(?\b(?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,24}(?:\/[^\s)]*)?\)?/gi;

// Only treat a dotted token as a URL when it carries a path or ends in a TLD
// people actually link to. Without this, "node.js" and "etc.)" get eaten.
const LINK_TLDS = new Set([
  'com',
  'org',
  'net',
  'io',
  'dev',
  'xyz',
  'app',
  'so',
  'ai',
  'co',
  'me',
  'info',
  'news',
  'blog',
  'pub',
  'social',
  'site',
  'link',
  'page',
  'press',
  'media',
  'sh',
  'gg',
  'fm',
  'tv',
  'to',
  'cc',
  'uk',
  'de',
  'fr',
  'jp',
  'ca',
  'au',
  'nl',
  'se',
  'no',
  'it',
  'es',
  'ru',
  'in',
  'cn',
  'br',
  'pl',
  'at',
]);

// What a link-drop leaves behind once its URL is gone: the anchor's label. These
// carry nothing the reader doesn't already have.
const LINK_LABELS = new Set([
  'discussion',
  'discussions',
  'comments',
  'comment',
  'link',
  'links',
  'article',
  'read more',
  'read',
  'via',
  'source',
  'submitted',
  'thread',
  'hn',
  'story',
  'post',
  'new',
  'more',
]);

// Whatever dangles once the URLs and the titles are gone: separators, empty
// brackets, trailing punctuation with nothing in front of it.
const EDGE_NOISE = /^[\s\-–—·•|:,.;"'“”()[\]]+|[\s\-–—·•|:,;"'“”()[\]]+$/g;

// Compare loosely — a bridge rewrites punctuation and casing freely, so an exact
// match would miss almost every real duplicate.
function comparable(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// True when a dotted token is a link rather than ordinary prose.
function looksLikeLink(match: string): boolean {
  const bare = match.replace(/^\(|\)$/g, '');
  if (bare.includes('/')) return true;
  const tld = bare.split('.').pop()?.toLowerCase() ?? '';
  return LINK_TLDS.has(tld);
}

// The words that remain once a leading run matching `key` is consumed, or null
// when the text doesn't open with that title. Matching walks the ORIGINAL words
// and compares their normalized form, so a title whose punctuation splits into a
// different number of words ("A/B testing") still lines up.
function withoutLeadingRun(words: string[], key: string): string[] | null {
  let acc = '';
  for (let i = 0; i < words.length; i++) {
    acc = acc ? `${acc} ${words[i]}` : words[i];
    const normalized = comparable(acc);
    if (normalized === key) return words.slice(i + 1);
    if (normalized.length > key.length) return null;
  }
  return null;
}

// The same, from the end — bots put the title on either side of the link.
function withoutTrailingRun(words: string[], key: string): string[] | null {
  let acc = '';
  for (let i = words.length - 1; i >= 0; i--) {
    acc = acc ? `${words[i]} ${acc}` : words[i];
    const normalized = comparable(acc);
    if (normalized === key) return words.slice(0, i);
    if (normalized.length > key.length) return null;
  }
  return null;
}

// Remove one title from either end of the text. Returns the text unchanged when
// it isn't there.
function stripTitle(text: string, title: string): string {
  const key = comparable(title);
  // A very short title ("Notes", "AI") shows up inside ordinary sentences, so
  // only strip one long enough to be unmistakably the article's or the site's.
  if (key.length < 8) return text;
  if (comparable(text) === key) return '';
  const words = text.split(/\s+/).filter(Boolean);
  const remainder = withoutLeadingRun(words, key) ?? withoutTrailingRun(words, key);
  return remainder ? remainder.join(' ') : text;
}

/**
 * The note as it should read under the article, or null when the record carried
 * nothing beyond the titles, a link, and the link's label.
 *
 * `titles` is everything the surface already shows above the entry: the
 * article's headline and the publication's name. A bridge posts either one.
 */
export function cleanDiscussionNote(
  note: string | null | undefined,
  titles?: string | null | (string | null | undefined)[]
): string | null {
  if (!note) return null;

  let text = note
    .replace(URL_PATTERN, ' ')
    .replace(BARE_URL_PATTERN, (match) => (looksLikeLink(match) ? ' ' : match));

  const list = Array.isArray(titles) ? titles : [titles];
  for (const title of list) {
    const trimmed = title?.trim();
    if (trimmed) text = stripTitle(text, trimmed);
    if (!text.trim()) break;
  }

  const cleaned = text.replace(/\s+/g, ' ').replace(EDGE_NOISE, '').trim();
  if (!cleaned) return null;
  // All that survived was the link's own label.
  if (LINK_LABELS.has(comparable(cleaned))) return null;
  return cleaned;
}
