// RSS 2.0 rendering for a linkblog feed. This is the one place we hand-build
// markup (XML, which isn't auto-escaped), so it keeps its own escaping helpers.

import {
  articleExcerpt,
  blogTitle,
  blogUrlFor,
  entryUrlFor,
  externalArticleUrl,
  feedUrlFor,
  hostnameOf,
  linkPostNote,
  rkeyFromUri,
  safeHttpUrl,
} from '$lib/fields';
import type { ProxyDocument, Profile, PublicationMeta } from '$lib/types';

// Escape for XML text/attributes. Same five entities as HTML, but apos is spelled
// `&apos;` (the XML predefined name).
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Escape text destined for HTML markup carried inside an RSS <description> CDATA.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Wrap HTML markup so it can live inside an RSS <description> verbatim (readers
// render the HTML). CDATA keeps the angle brackets literal; we only have to guard
// the one sequence that would close the section early.
export function cdata(html: string): string {
  return `<![CDATA[${html.replace(/]]>/g, ']]&gt;')}]]>`;
}

// RFC-822 date for RSS <pubDate>/<lastBuildDate>. Empty for an unparseable input.
export function toRfc822(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toUTCString();
}

// Each entry's HTML body: the user's note, an article excerpt (when distinct), a
// link out to the source, and a subtle permalink back to the commentary. Mirrors
// the index/permalink pages so a reader sees the same thing whether they visit the
// page or subscribe. The item <link> points at the source (see renderItem), so the
// permalink is the one thing only the body can carry.
function entryHtml(doc: ProxyDocument, permalink: string): string {
  const note = linkPostNote(doc).trim();
  const excerpt = articleExcerpt(doc);
  const articleUrl = safeHttpUrl(externalArticleUrl(doc) || doc.canonicalUrl);
  const host = hostnameOf(articleUrl ?? undefined);

  const parts: string[] = [];
  if (note) parts.push(`<p>${escapeHtml(note)}</p>`);
  if (excerpt && excerpt !== note) parts.push(`<blockquote>${escapeHtml(excerpt)}</blockquote>`);
  if (articleUrl) {
    parts.push(
      `<p><a href="${escapeHtml(articleUrl)}">Read the full article${host ? ` on ${escapeHtml(host)}` : ''}</a></p>`
    );
  }
  parts.push(`<p><a href="${escapeHtml(permalink)}">Permalink</a></p>`);
  return parts.join('\n');
}

function renderItem(origin: string, did: string, doc: ProxyDocument): string {
  const rkey = rkeyFromUri(doc.recordUri);
  // Daring-Fireball-style linkblog: the item <link> points at the source article
  // being commented on (the headline IS the outbound link). A subtle permalink to
  // the commentary on this site lives in the body, and the guid is the immutable
  // record URI. Note-only posts (no source) fall back to the permalink.
  const permalink = rkey ? entryUrlFor(origin, did, rkey) : blogUrlFor(origin, did);
  const itemLink = safeHttpUrl(externalArticleUrl(doc) || doc.canonicalUrl) || permalink;
  const pubDate = toRfc822(doc.createdAt || doc.publishedAt);

  const tags = [
    `<title>${escapeXml(doc.title || 'Untitled')}</title>`,
    `<link>${escapeXml(itemLink)}</link>`,
    `<guid isPermaLink="false">${escapeXml(doc.recordUri)}</guid>`,
    pubDate ? `<pubDate>${escapeXml(pubDate)}</pubDate>` : '',
    `<description>${cdata(entryHtml(doc, permalink))}</description>`,
  ].filter(Boolean);

  return `<item>\n  ${tags.join('\n  ')}\n</item>`;
}

export function renderFeed(
  origin: string,
  did: string,
  profile: Profile | null,
  pub: PublicationMeta | null,
  docs: ProxyDocument[]
): string {
  const title = blogTitle(profile, pub);
  const link = blogUrlFor(origin, did);
  const self = feedUrlFor(origin, did);
  const description =
    pub?.description || `Links shared by ${profile?.displayName || profile?.handle || did}.`;
  const image = safeHttpUrl(pub?.icon || profile?.avatar);
  // Newest share drives lastBuildDate (docs arrive newest-first).
  const lastBuild = docs.length ? toRfc822(docs[0].createdAt || docs[0].publishedAt) : '';

  const imageTag = image
    ? `<image>\n  <url>${escapeXml(image)}</url>\n  <title>${escapeXml(title)}</title>\n  <link>${escapeXml(link)}</link>\n</image>`
    : '';

  const items = docs.map((d) => renderItem(origin, did, d)).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>${escapeXml(title)}</title>
<link>${escapeXml(link)}</link>
<atom:link href="${escapeXml(self)}" rel="self" type="application/rss+xml" />
<description>${escapeXml(description)}</description>
<language>en</language>
${lastBuild ? `<lastBuildDate>${escapeXml(lastBuild)}</lastBuildDate>` : ''}
<generator>Skyreader</generator>
${imageTag}
${items}
</channel>
</rss>`;
}

export function emptyFeed(origin: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>Not found · Skyreader</title>
<link>${escapeXml(origin)}</link>
<description>We couldn't find that linkblog.</description>
</channel>
</rss>`;
}
