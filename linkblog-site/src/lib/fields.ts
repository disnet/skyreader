// Pure helpers for the public linkblog — identifiers, link-post field extraction,
// formatting, and URL safety. No network or framework deps, so they're shared by
// the server load functions and the Svelte components alike.

import type { ProxyDocument, Profile, PublicationMeta, SocialContext } from './types';

export const PUBLICATION_COLLECTION = 'site.standard.publication';
export const DOCUMENT_COLLECTION = 'site.standard.document';

// The dedicated, one-per-user linkblog publication (see LINKBLOG_PLAN.md).
export const LINKBLOG_RKEY = 'skyreader-links';

export function isDid(value: string): boolean {
  return value.startsWith('did:');
}

export function publicationUri(did: string): string {
  return `at://${did}/${PUBLICATION_COLLECTION}/${LINKBLOG_RKEY}`;
}

// Derive the document rkey from its AT URI (at://did/collection/rkey).
export function rkeyFromUri(uri: string): string | null {
  const parts = uri.replace(/^at:\/\//, '').split('/');
  return parts.length >= 3 ? parts.slice(2).join('/') : null;
}

// Canonical RSS feed URL for a linkblog (the DID form, mirroring the permalink
// encoding). Also the href used for feed autodiscovery on the HTML pages.
export function feedUrlFor(origin: string, did: string): string {
  return `${origin}/${encodeURIComponent(did)}/feed.xml`;
}

// Public web URL for a linkblog index (canonical DID form).
export function blogUrlFor(origin: string, did: string): string {
  return `${origin}/${encodeURIComponent(did)}`;
}

// Public web URL for a single linkblog entry.
export function entryUrlFor(origin: string, did: string, rkey: string): string {
  return `${origin}/${encodeURIComponent(did)}/${encodeURIComponent(rkey)}`;
}

// Backend API origin for the inline subscribe button. Prefer an explicit override;
// otherwise derive from the page host (prod/staging map to their api.* subdomain;
// local dev returns the dev backend so the credentialed fetch reaches it).
export function apiBaseFor(origin: string, publicApiUrl?: string): string {
  if (publicApiUrl) return publicApiUrl.replace(/\/+$/, '');
  let host = '';
  try {
    host = new URL(origin).hostname;
  } catch {
    return '';
  }
  if (host === 'linkblogs.skyreader.app' || host === 'skyreader.app') {
    return 'https://api.skyreader.app';
  }
  if (host.endsWith('.skyreader.app')) return 'https://api-staging.skyreader.app';
  if (host === '127.0.0.1' || host === 'localhost') return 'http://127.0.0.1:8787';
  return '';
}

// The Skyreader app origin (for "Open in Skyreader" + the login bounce). Prefer an
// explicit override; otherwise map the linkblog host to its sibling app host.
export function appUrlFor(origin: string, publicAppUrl?: string): string {
  if (publicAppUrl) return publicAppUrl.replace(/\/+$/, '');
  let host = '';
  try {
    host = new URL(origin).hostname;
  } catch {
    return 'https://skyreader.app';
  }
  if (host === '127.0.0.1' || host === 'localhost') return 'http://127.0.0.1:5173';
  if (host.includes('staging')) return 'https://staging.skyreader.app';
  return 'https://skyreader.app';
}

// ── Link-post fields ─────────────────────────────────────────────────────────

interface LeafletFacetFeature {
  $type?: string;
  did?: string;
}
interface LeafletFacet {
  index?: { byteStart?: number; byteEnd?: number };
  features?: LeafletFacetFeature[];
}
interface LeafletTextBlock {
  $type?: string;
  plaintext?: string;
  facets?: LeafletFacet[];
}
interface LeafletPage {
  blocks?: Array<{ block?: LeafletTextBlock }>;
}
interface LeafletContent {
  $type?: string;
  pages?: LeafletPage[];
}

// A resolved @mention in a note: the UTF-8 byte range of the `@handle` token within
// the note plaintext, plus the DID it points at. Skyreader writes these as
// `pub.leaflet.richtext.facet#didMention` facets on the note's text block (see the
// backend's mention-facets); we render them as links to the mentioned account.
export interface MentionFacet {
  byteStart: number;
  byteEnd: number;
  did: string;
}

// Facet $types we treat as an @mention. Our own writer emits `#didMention`; the
// others are accepted for interop with bsky/leaflet-native records.
const MENTION_FACET_TYPES = new Set([
  'pub.leaflet.richtext.facet#didMention',
  'pub.leaflet.richtext.facet#mention',
  'app.bsky.richtext.facet#mention',
]);

// A note's blockquote lines are stored as their own native blockquote block, so
// a facet offset inside one shifts by the `> ` markers renderBodyHtml re-adds:
// two bytes per line up to and including the line the offset falls on.
function quoteOffset(plaintext: string, byteOffset: number): number {
  const prefix = utf8Encoder.encode(plaintext).slice(0, byteOffset);
  let newlines = 0;
  for (const byte of prefix) if (byte === 10) newlines++;
  return byteOffset + 2 * (newlines + 1);
}

function blockMentions(block: LeafletTextBlock, base: number, isQuote: boolean): MentionFacet[] {
  const out: MentionFacet[] = [];
  for (const f of block.facets ?? []) {
    const byteStart = f?.index?.byteStart;
    const byteEnd = f?.index?.byteEnd;
    if (typeof byteStart !== 'number' || typeof byteEnd !== 'number' || byteEnd <= byteStart) {
      continue;
    }
    const did = (f.features ?? []).find(
      (ft) => ft && MENTION_FACET_TYPES.has(ft.$type ?? '') && ft.did?.startsWith('did:')
    )?.did;
    if (!did) continue;
    const plaintext = block.plaintext ?? '';
    out.push({
      byteStart: base + (isQuote ? quoteOffset(plaintext, byteStart) : byteStart),
      byteEnd: base + (isQuote ? quoteOffset(plaintext, byteEnd) : byteEnd),
      did,
    });
  }
  return out;
}

// Rebuild the note from the leading text and blockquote blocks — the same
// restricted Markdown the user typed, with `> ` markers restored — and rebase the
// mention facets onto it. Skyreader writes the note before the website card, so
// the walk stops at the first block that is neither.
function reconstructLeafletNote(blocks: Array<{ block?: LeafletTextBlock }>): {
  note: string;
  mentions: MentionFacet[];
} {
  const parts: string[] = [];
  const mentions: MentionFacet[] = [];
  let outputBytes = 0;

  for (const wrapper of blocks) {
    const block = wrapper.block;
    const isQuote = block?.$type === 'pub.leaflet.blocks.blockquote';
    if (!isQuote && block?.$type !== 'pub.leaflet.blocks.text') break;
    const plaintext = block?.plaintext;
    if (!plaintext?.trim()) continue;
    const rendered = isQuote
      ? plaintext
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')
      : plaintext;
    if (parts.length > 0) outputBytes += 2; // the '\n\n' separator
    mentions.push(...blockMentions(block!, outputBytes, isQuote));
    parts.push(rendered);
    outputBytes += utf8Encoder.encode(rendered).length;
  }
  return { note: parts.join('\n\n').trim(), mentions };
}

// ── Notes in a connected publication's own content lexicon ───────────────────
//
// A linkblog can be an existing standard.site publication (Leaflet, pckt,
// Offprint, Markdown), in which case its link posts carry the note in that app's
// content shape. pckt and Offprint use an ordered `items` array of text and
// blockquote blocks; Markdown stores one string. In each the note leads and the
// shared article closes the post — as a link card (pckt), a trailing line
// carrying the URL (Offprint), or a trailing Markdown link.

interface ForeignBlock {
  $type?: string;
  plaintext?: string;
  content?: ForeignBlock[];
}

function foreignBlockText(block: ForeignBlock): string {
  if (typeof block.plaintext === 'string') return block.plaintext;
  return (block.content ?? []).map(foreignBlockText).filter(Boolean).join('\n');
}

function foreignItemsNote(items: ForeignBlock[], prefix: string, articleUrl?: string): string {
  const parts: string[] = [];
  for (const item of items) {
    const isQuote = item?.$type === `${prefix}blockquote`;
    if (!isQuote && item?.$type !== `${prefix}text`) break;
    const text = foreignBlockText(item).trim();
    if (!text) continue;
    if (!isQuote && articleUrl && text.includes(articleUrl)) break;
    parts.push(
      isQuote
        ? text
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n')
        : text
    );
  }
  return parts.join('\n\n').trim();
}

function foreignMarkdownNote(markdown: string, articleUrl?: string): string {
  const lines = markdown.split('\n');
  if (articleUrl) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes(`](${articleUrl})`)) {
        lines.splice(i, 1);
        break;
      }
    }
  }
  return lines.join('\n').trim();
}

// The user's commentary on a link post, with any @mention facets rebased onto it.
// Returns an empty note when there is none — the document's
// `description`/`textContent` hold the article excerpt, not the note. Mentions are
// a Leaflet richtext feature; the other formats store the note as plain text.
function noteOf(doc: ProxyDocument): { note: string; mentions: MentionFacet[] } {
  const content = doc.content as
    | (LeafletContent & { items?: ForeignBlock[]; text?: { markdown?: string } })
    | undefined;
  const articleUrl = externalArticleUrl(doc);
  switch (content?.$type) {
    case 'pub.leaflet.content': {
      for (const page of content.pages ?? []) {
        const result = reconstructLeafletNote(page.blocks ?? []);
        if (result.note) return result;
      }
      return { note: '', mentions: [] };
    }
    case 'blog.pckt.content':
      return {
        note: foreignItemsNote(content.items ?? [], 'blog.pckt.block.', articleUrl),
        mentions: [],
      };
    case 'app.offprint.content':
      return {
        note: foreignItemsNote(content.items ?? [], 'app.offprint.block.', articleUrl),
        mentions: [],
      };
    case 'at.markpub.markdown':
      return {
        note: foreignMarkdownNote(content.text?.markdown ?? '', articleUrl),
        mentions: [],
      };
    default:
      return { note: '', mentions: [] };
  }
}

export function linkPostNote(doc: ProxyDocument): string {
  return noteOf(doc).note;
}

// The resolved @mention facets on the note, byte-indexed into linkPostNote(doc).
export function linkPostMentions(doc: ProxyDocument): MentionFacet[] {
  return noteOf(doc).mentions;
}

// A snippet of the shared article itself (its first paragraph or so). LEGACY
// shares stored it as the document's top-level `description`, rendered as a quote
// distinct from the note. New shares fold the quote into the editable note instead
// and leave `description` unset — so a present description marks a legacy record,
// and we keep rendering its standalone quote for those (see the entry components).
export function articleExcerpt(doc: ProxyDocument): string {
  return (doc.description || '').trim();
}

// Escape text for safe interpolation into the HTML we generate in renderBodyHtml.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

function byteLength(value: string): number {
  return utf8Encoder.encode(value).length;
}

// Render a mention's `@handle` label as a link to the account on Bluesky. The DID is
// validated (`did:` prefix) and percent-encoded into the path, so it can't break out
// of the href; `label` is the already-escaped handle text taken from the note.
function mentionLink(did: string, label: string): string {
  if (!did.startsWith('did:')) return label;
  return `<a href="https://bsky.app/profile/${encodeURIComponent(did)}" target="_blank" rel="noopener nofollow">${label}</a>`;
}

// Escape `text` to safe HTML, turning any mention facets that fall within it into
// links. `text` is a slice of the note plaintext starting at `baseByteOffset` (its
// UTF-8 byte offset within the full note); facets carry absolute byte offsets, so we
// shift them into the slice. Facets straddling the slice edge (e.g. cut by a clamp)
// are skipped, leaving plain escaped text.
function applyMentionFacets(text: string, baseByteOffset: number, facets: MentionFacet[]): string {
  const bytes = utf8Encoder.encode(text);
  const sliceEnd = baseByteOffset + bytes.length;
  const within = facets
    .filter((f) => f.byteStart >= baseByteOffset && f.byteEnd <= sliceEnd)
    .sort((a, b) => a.byteStart - b.byteStart);
  if (within.length === 0) return escapeHtml(text);

  let html = '';
  let cursor = 0; // byte cursor within `bytes`
  for (const f of within) {
    const start = f.byteStart - baseByteOffset;
    const end = f.byteEnd - baseByteOffset;
    if (start < cursor) continue; // overlapping facet — skip
    html += escapeHtml(utf8Decoder.decode(bytes.slice(cursor, start)));
    html += mentionLink(f.did, escapeHtml(utf8Decoder.decode(bytes.slice(start, end))));
    cursor = end;
  }
  html += escapeHtml(utf8Decoder.decode(bytes.slice(cursor)));
  return html;
}

// Render a link-post note (the user-controlled body) to safe HTML with a HEAVILY
// restricted Markdown subset: blockquotes only, plus @mention links from `facets`.
// Pass `max` to clamp long previews (mentions past the cut are dropped).
//
// The body is untrusted PDS content on this public origin, so every character is
// HTML-escaped and the ONLY tags emitted are the <p>/<blockquote>/<br> we generate
// and <a> links built from validated mention DIDs — there's no path for raw HTML (or
// any other Markdown) to survive. Lines beginning with `>` open or extend a
// blockquote (consecutive ones fold into one); blank lines separate paragraphs;
// single newlines become <br>.
export function renderBodyHtml(body: string, facets: MentionFacet[] = [], max?: number): string {
  let text = body;
  let mentions = facets;
  if (max != null && text.length > max) {
    const kept = text.slice(0, max - 1).trimEnd();
    const keptBytes = byteLength(kept);
    mentions = facets.filter((f) => f.byteEnd <= keptBytes);
    text = kept + '…';
  }

  const out: string[] = [];
  let para: string[] = [];
  let quote: string[] = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.join('<br>')}</p>`);
      para = [];
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push(`<blockquote><p>${quote.join('<br>')}</p></blockquote>`);
      quote = [];
    }
  };

  // Walk lines while tracking each line's UTF-8 byte offset, so the facets (absolute
  // byte ranges) map onto the right line. A trailing \r (from \r\n) is dropped for
  // display but still counted toward the offset.
  let byteOffset = 0;
  for (const rawLine of text.split('\n')) {
    let line = rawLine;
    let crBytes = 0;
    if (line.endsWith('\r')) {
      line = line.slice(0, -1);
      crBytes = 1;
    }
    const m = /^[ \t]*>[ \t]?(.*)$/.exec(line);
    if (m) {
      flushPara();
      // The blockquote marker is stripped, so the quoted content starts that many
      // bytes into the line.
      const contentByteStart = byteOffset + (byteLength(line) - byteLength(m[1]));
      quote.push(applyMentionFacets(m[1], contentByteStart, mentions));
    } else if (line.trim() === '') {
      flushPara();
      flushQuote();
    } else {
      flushQuote();
      para.push(applyMentionFacets(line, byteOffset, mentions));
    }
    byteOffset += byteLength(line) + crBytes + 1; // + the consumed \n
  }
  flushPara();
  flushQuote();
  return out.join('');
}

// The note as plain text (blockquote markers stripped), for meta descriptions and
// social previews where Markdown syntax would just leak `>` characters.
export function plainBody(body: string): string {
  return body
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/\n{2,}/g, ' ')
    .replace(/\n/g, ' ')
    .trim();
}

// Truncate to a max length on a word-ish boundary, preserving any newlines within
// the kept slice (renderBodyHtml turns them into <br>/paragraph breaks).
export function clampText(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + '…';
}

// The external article a link post points at: the first http(s) `links` entry.
// (`at://` repost refs are quote-reshares — ignored here.) Returns undefined for a
// plain document, so callers fall back to the document's own canonical URL.
export function externalArticleUrl(doc: ProxyDocument): string | undefined {
  return doc.links?.find((l) => /^https?:\/\//i.test(l.uri))?.uri;
}

export function blogTitle(profile: Profile | null, pub: PublicationMeta | null): string {
  if (pub?.name) return pub.name;
  const who = profile?.displayName || (profile?.handle ? `@${profile.handle}` : 'Someone');
  return `${who}'s links`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// A quiet "3 recommends · 1 quote" fragment for the entry meta row. Returns '' when
// there's nothing to show.
export function socialCountsText(ctx: SocialContext | undefined): string {
  if (!ctx) return '';
  const parts: string[] = [];
  if (ctx.recommendCount > 0) {
    parts.push(`${ctx.recommendCount} ${ctx.recommendCount === 1 ? 'recommend' : 'recommends'}`);
  }
  if (ctx.quoteCount > 0) {
    parts.push(`${ctx.quoteCount} ${ctx.quoteCount === 1 ? 'quote' : 'quotes'}`);
  }
  return parts.join(' · ');
}

export function hostnameOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// Allowlist http(s) before using a value as an href/src. These URLs originate
// from user-controlled PDS records (document/publication), so a `javascript:`
// (or `data:` etc.) scheme would otherwise survive into a link and execute on
// click. Returns the normalized URL, or null to omit the link/attribute.
export function safeHttpUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}
