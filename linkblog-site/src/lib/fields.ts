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

interface LeafletTextBlock {
  $type?: string;
  plaintext?: string;
}
interface LeafletPage {
  blocks?: Array<{ block?: LeafletTextBlock }>;
}
interface LeafletContent {
  $type?: string;
  pages?: LeafletPage[];
}

// The user's commentary on a link post: the plaintext of the first
// `pub.leaflet.blocks.text` block (Skyreader writes the note as the leading text
// block, before the website card). Returns '' when there's no note — the
// document's `description`/`textContent` hold the article excerpt, not the note.
export function linkPostNote(doc: ProxyDocument): string {
  const content = doc.content as LeafletContent | undefined;
  if (content && content.$type === 'pub.leaflet.content') {
    for (const page of content.pages ?? []) {
      for (const wrapper of page.blocks ?? []) {
        if (wrapper.block?.$type === 'pub.leaflet.blocks.text') {
          const text = wrapper.block.plaintext?.trim();
          if (text) return text;
        }
      }
    }
  }
  return '';
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

// Render a link-post note (the user-controlled body) to safe HTML with a HEAVILY
// restricted Markdown subset: blockquotes only. Everything else is plain text.
//
// The body is untrusted PDS content on this public origin, so every character is
// HTML-escaped first and the ONLY tags emitted are <p>/<blockquote>/<br> that we
// generate — there's no path for raw HTML (or any other Markdown) to survive.
// Lines beginning with `>` open or extend a blockquote (consecutive ones fold into
// one); blank lines separate paragraphs; single newlines become <br>.
export function renderBodyHtml(body: string): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let quote: string[] = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map(escapeHtml).join('<br>')}</p>`);
      para = [];
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push(`<blockquote><p>${quote.map(escapeHtml).join('<br>')}</p></blockquote>`);
      quote = [];
    }
  };

  for (const line of lines) {
    const m = /^[ \t]*>[ \t]?(.*)$/.exec(line);
    if (m) {
      flushPara();
      quote.push(m[1]);
    } else if (line.trim() === '') {
      flushPara();
      flushQuote();
    } else {
      flushQuote();
      para.push(line);
    }
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
