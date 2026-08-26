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
 * So: drop the links, drop titles that stand apart (set off by a link, a line
 * break, a separator, or the edge of the post), drop a bare link label, and if
 * nothing is left, say nothing. A title woven into the author's sentence stays —
 * including one they quoted, since the marks around “Never Be Angry at Work”
 * enclose a noun phrase, they don't set a headline apart from a comment.
 * The caller decides what an entry with no words looks like — see
 * AtmospherePanel, which collects them into one "Also linked" line instead of
 * giving each an empty row.
 */

// Full URLs, including the wrapping parens a bot uses to tack a discussion link
// on the end.
const URL_PATTERN = /\(?\bhttps?:\/\/[^\s)]+\)?/gi;

// Bare and truncated URLs — what a Bluesky post actually stores, since the text
// carries the link's *display* form ("lucumr.pocoo.org/2026/8/22/fa…") while the
// real href lives in a facet we never see here.
const BARE_URL_PATTERN = /\(?\b(?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,24}(?:\/[^\s)]*)?\)?/gi;

// Pass two keeps the boundary left by a link or line break long enough for title
// stripping to distinguish boilerplate from a title woven into a sentence.
const BOUNDARY = '\uE000';

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

// Whatever dangles once the URLs and the titles are gone: separators, trailing
// punctuation with nothing in front of it. Quotes and brackets are left to
// `dropUnpairedEdges`, which keeps the pair an author actually wrote.
const EDGE_NOISE = /^[\s\-–—·•|:,.;]+|[\s\-–—·•|:,;]+$/g;

// The other half of a quote or bracket. An author's own marks come in pairs; a
// lone one is residue from a URL or a title we removed.
const EDGE_PAIRS = new Map([
  ['“', '”'],
  ['”', '“'],
  ['‘', '’'],
  ['’', '‘'],
  ['"', '"'],
  ["'", "'"],
  ['(', ')'],
  [')', '('],
  ['[', ']'],
  [']', '['],
]);

// Punctuation that genuinely sets a headline apart from a person's own words:
// the dashes, bullets, pipes and colons a bridge puts between the two. Quotes
// and brackets are deliberately absent — they wrap a title being *used* in a
// sentence, so treating them as a separator is how a real sentence loses its
// subject.
const SEPARATOR_AFTER_TITLE = /[\-–—·•|,:;]$/u;
const SEPARATOR_BEFORE_REMAINDER = /^[\-–—·•|,:;.…]/u;

// A note the trims reduced to a matched pair of brackets and nothing else is
// still nothing said. Emoji and other real characters survive this check.
const PUNCTUATION_ONLY = /^[\s\-–—·•|:,.;!?…"'“”‘’()[\]{}]*$/u;

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
function hasLeadingBoundary(runWords: string[], remainderWords: string[]): boolean {
  if (!remainderWords.length) return true;
  if (remainderWords[0] === BOUNDARY) return true;
  if (SEPARATOR_BEFORE_REMAINDER.test(remainderWords[0])) return true;
  // Only a separator hanging off the title counts. A closing quote or bracket
  // means the sentence carried the title, and sentence-ending punctuation is
  // usually the headline's own ("What Is the Purpose of Protocols? asks Paul").
  if (SEPARATOR_AFTER_TITLE.test(runWords.at(-1) ?? '')) return true;
  return LINK_LABELS.has(comparable(remainderWords[0]));
}

function hasTrailingBoundary(remainderWords: string[]): boolean {
  if (!remainderWords.length) return true;
  const last = remainderWords.at(-1) ?? '';
  return last === BOUNDARY || /[\-–—·•|,:;.!?…'"“”‘’\])}]$/u.test(last);
}

function stripTitle(text: string, title: string, gated: boolean): string {
  const key = comparable(title);
  // A very short title ("Notes", "AI") shows up inside ordinary sentences, so
  // only strip one long enough to be unmistakably the article's or the site's.
  if (key.length < 8) return text;
  if (comparable(text) === key) return '';
  const words = text.split(/\s+/).filter(Boolean);
  const leading = withoutLeadingRun(words, key);
  if (leading) {
    const run = words.slice(0, words.length - leading.length);
    if (!gated || hasLeadingBoundary(run, leading)) return leading.join(' ');
  }
  const trailing = withoutTrailingRun(words, key);
  if (trailing && (!gated || hasTrailingBoundary(trailing))) return trailing.join(' ');
  return text;
}

// Shed a quote or bracket at either edge only when its partner is gone.
function dropUnpairedEdges(text: string): string {
  let out = text;
  for (;;) {
    const first = out.at(0) ?? '';
    const firstPartner = EDGE_PAIRS.get(first);
    if (firstPartner && !out.slice(1).includes(firstPartner)) {
      out = out.slice(1).trim();
      continue;
    }
    const last = out.at(-1) ?? '';
    const lastPartner = EDGE_PAIRS.get(last);
    if (lastPartner && !out.slice(0, -1).includes(lastPartner)) {
      out = out.slice(0, -1).trim();
      continue;
    }
    return out;
  }
}

// Both trims can expose more of the other's work — a stripped title can leave
// `— “` behind — so alternate until the edges stop moving.
function trimEdges(text: string): string {
  let out = text.trim();
  for (;;) {
    const next = dropUnpairedEdges(out.replace(EDGE_NOISE, '').trim());
    if (next === out) return out;
    out = next;
  }
}

function cleanPass(
  note: string,
  titles: (string | null | undefined)[],
  gated: boolean
): string | null {
  const replacement = gated ? ` ${BOUNDARY} ` : ' ';
  let text = note
    .replace(URL_PATTERN, replacement)
    .replace(BARE_URL_PATTERN, (match) => (looksLikeLink(match) ? replacement : match));
  if (gated) text = text.replace(/[\r\n]+/g, replacement);

  for (const title of titles) {
    const trimmed = title?.trim();
    if (trimmed) text = stripTitle(text, trimmed, gated);
    if (!text.trim()) break;
  }

  const cleaned = trimEdges(text.replaceAll(BOUNDARY, ' ').replace(/\s+/g, ' '));
  if (!cleaned || PUNCTUATION_ONLY.test(cleaned) || LINK_LABELS.has(comparable(cleaned))) {
    return null;
  }
  return cleaned;
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

  const list = Array.isArray(titles) ? titles : [titles];
  // Preserve the old aggressive algorithm as the boilerplate verdict so every
  // existing bridge/bot-only post still collapses into "Also linked".
  if (!cleanPass(note, list, false)) return null;
  return cleanPass(note, list, true);
}
