// Public linkblog RSS feed — GET /blogs/<did-or-handle>/feed.xml
//
// An RSS 2.0 feed of the linkblog, so it can be followed from any reader.
// Server-rendered on skyreader.app (Cloudflare Pages Function). DIDs are the
// canonical form; a handle redirects (301) to its DID feed so subscriptions stay
// stable across handle changes.

import {
  BlogContext,
  Profile,
  ProxyDocument,
  PublicationMeta,
  articleExcerpt,
  blogTitle,
  cdata,
  decodeParam,
  escapeHtml,
  escapeXml,
  externalArticleUrl,
  feedUrlFor,
  fetchLinkblogDocuments,
  fetchPublicationMeta,
  getProfile,
  hostnameOf,
  isDid,
  linkPostNote,
  redirect,
  resolveHandleToDid,
  rkeyFromUri,
  rssResponse,
  safeHttpUrl,
  toRfc822,
} from '../_lib';

// Each entry's HTML body: the user's note, an article excerpt (when distinct),
// and a link out to the source. Mirrors what the index/permalink pages show, so a
// reader sees the same thing whether they visit the page or subscribe.
function entryHtml(doc: ProxyDocument): string {
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
  return parts.join('\n');
}

function renderItem(origin: string, did: string, doc: ProxyDocument): string {
  const rkey = rkeyFromUri(doc.recordUri);
  // The permalink (stable, on Skyreader) is the canonical link for the item; the
  // source article lives in the body. The guid is the immutable record URI.
  const permalink = rkey
    ? `${origin}/blogs/${encodeURIComponent(did)}/${encodeURIComponent(rkey)}`
    : `${origin}/blogs/${encodeURIComponent(did)}`;
  const pubDate = toRfc822(doc.createdAt || doc.publishedAt);

  const tags = [
    `<title>${escapeXml(doc.title || 'Untitled')}</title>`,
    `<link>${escapeXml(permalink)}</link>`,
    `<guid isPermaLink="false">${escapeXml(doc.recordUri)}</guid>`,
    pubDate ? `<pubDate>${escapeXml(pubDate)}</pubDate>` : '',
    `<description>${cdata(entryHtml(doc))}</description>`,
  ].filter(Boolean);

  return `<item>\n  ${tags.join('\n  ')}\n</item>`;
}

function renderFeed(
  origin: string,
  did: string,
  profile: Profile | null,
  pub: PublicationMeta | null,
  docs: ProxyDocument[]
): string {
  const title = blogTitle(profile, pub);
  const link = `${origin}/blogs/${encodeURIComponent(did)}`;
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

export async function onRequestGet(context: BlogContext): Promise<Response> {
  const { request, env, params } = context;
  const origin = new URL(request.url).origin;
  const id = decodeParam(params.id);

  if (!id) {
    return rssResponse(emptyFeed(origin), 404);
  }

  // Handle → DID: redirect to the canonical DID feed so subscriptions stay stable.
  if (!isDid(id)) {
    const did = await resolveHandleToDid(id);
    if (!did) {
      return rssResponse(emptyFeed(origin), 404);
    }
    return redirect(feedUrlFor(origin, did));
  }

  const did = id;
  const [profile, pub, docs] = await Promise.all([
    getProfile(did),
    fetchPublicationMeta(did),
    fetchLinkblogDocuments(env, did),
  ]);

  // Cap the feed length — readers only need the recent window.
  const xml = renderFeed(origin, did, profile, pub, docs.slice(0, 50));
  return rssResponse(xml);
}

function emptyFeed(origin: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>Not found · Skyreader</title>
<link>${escapeXml(origin)}/blogs</link>
<description>We couldn't find that linkblog.</description>
</channel>
</rss>`;
}
