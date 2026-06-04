// Public linkblog permalink — GET /blogs/<did-or-handle>/<rkey>
//
// Renders a single linkblog entry. Server-rendered on skyreader.app.

import {
  BlogContext,
  Profile,
  ProxyDocument,
  PublicationMeta,
  SocialContext,
  articleExcerpt,
  blogTitle,
  clampText,
  escapeHtml,
  externalArticleUrl,
  fetchLinkblogDocuments,
  fetchPublicationMeta,
  fetchSocialContext,
  formatDate,
  getProfile,
  hostnameOf,
  htmlResponse,
  isDid,
  linkPostNote,
  renderAlsoLinkedBy,
  renderPage,
  renderSocialCounts,
  resolveHandleToDid,
  rkeyFromUri,
  safeHttpUrl,
} from '../_lib';

function renderEntryPage(
  origin: string,
  did: string,
  profile: Profile | null,
  pub: PublicationMeta | null,
  doc: ProxyDocument,
  ctx: SocialContext | undefined
): string {
  const blogName = blogTitle(profile, pub);
  const title = escapeHtml(doc.title || 'Untitled');
  // The user's note (their voice, plain text — newlines preserved) and a snippet
  // quoted from the article (the article's voice), kept visually distinct.
  const note = linkPostNote(doc).trim();
  const excerpt = articleExcerpt(doc);
  // The shared article (link post), falling back to the doc's own URL.
  const articleUrl = safeHttpUrl(externalArticleUrl(doc) || doc.canonicalUrl);
  const host = hostnameOf(articleUrl ?? undefined);
  // Share time (when this went on the linkblog), not the article's publish date.
  const date = formatDate(doc.createdAt || doc.publishedAt);

  const meta: string[] = [];
  if (host) meta.push(`<span class="src">${escapeHtml(host)}</span>`);
  if (date) meta.push(`<span>${escapeHtml(date)}</span>`);
  const social = renderSocialCounts(ctx);
  if (social) meta.push(social);
  const metaHtml = meta.join('<span class="sep" aria-hidden="true">·</span>');
  const readMore = articleUrl
    ? `<a class="readmore" href="${escapeHtml(articleUrl)}" rel="noopener noreferrer">Read the full article${host ? ` on ${escapeHtml(host)}` : ''} <span class="arrow" aria-hidden="true">→</span></a>`
    : '';

  const noteHtml = note ? `<p class="entry-note-lg">${escapeHtml(note)}</p>` : '';
  const quoteHtml =
    excerpt && excerpt !== note
      ? `<blockquote class="entry-quote"><p>${escapeHtml(clampText(excerpt, 600))}</p></blockquote>`
      : '';

  return `<a class="back" href="/blogs/${encodeURIComponent(did)}"><span aria-hidden="true">←</span> ${escapeHtml(blogName)}</a>
<article class="entry-page">
  <h1 class="entry-title-lg">${title}</h1>
  ${meta.length ? `<div class="meta">${metaHtml}</div>` : ''}
  ${noteHtml}
  ${quoteHtml}
  ${readMore}
  ${renderAlsoLinkedBy(ctx)}
</article>
<footer class="foot">A linkblog on <a href="${escapeHtml(origin)}">Skyreader</a>, stored in the Atmosphere.</footer>`;
}

export async function onRequestGet(context: BlogContext): Promise<Response> {
  const { request, env, params } = context;
  const origin = new URL(request.url).origin;
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const rkey = Array.isArray(params.rkey) ? params.rkey[0] : params.rkey;

  if (!id || !rkey) {
    return htmlResponse(notFoundPage(origin), 404);
  }

  // Handle → DID redirect, preserving the rkey.
  if (!isDid(id)) {
    const did = await resolveHandleToDid(id);
    if (!did) {
      return htmlResponse(notFoundPage(origin), 404);
    }
    return Response.redirect(
      `${origin}/blogs/${encodeURIComponent(did)}/${encodeURIComponent(rkey)}`,
      301
    );
  }

  const did = id;
  const [profile, pub, docs] = await Promise.all([
    getProfile(did),
    fetchPublicationMeta(did),
    fetchLinkblogDocuments(env, did),
  ]);

  const doc = docs.find((d) => rkeyFromUri(d.recordUri) === rkey);
  if (!doc) {
    return htmlResponse(notFoundPage(origin), 404);
  }

  // Full social context for this single entry: recommend/quote counts + who else
  // across the Atmosphere linked the same article (with their notes). Best-effort.
  const social = await fetchSocialContext(env, [
    {
      key: doc.recordUri,
      docUri: doc.recordUri,
      articleUrl: externalArticleUrl(doc),
      excludeDid: did,
    },
  ]);

  const body = renderEntryPage(origin, did, profile, pub, doc, social.get(doc.recordUri));
  // OG description: prefer the user's note, fall back to the article snippet.
  const summary = (linkPostNote(doc).trim() || articleExcerpt(doc)).slice(0, 280);
  const html = renderPage(
    {
      title: `${doc.title || 'Untitled'} · ${blogTitle(profile, pub)}`,
      description: summary || undefined,
      image: safeHttpUrl(pub?.icon || profile?.avatar) ?? undefined,
      url: `${origin}/blogs/${encodeURIComponent(did)}/${encodeURIComponent(rkey)}`,
    },
    body
  );
  return htmlResponse(html);
}

function notFoundPage(origin: string): string {
  return renderPage(
    { title: 'Not found · Skyreader', url: `${origin}/blogs` },
    `<p class="empty">We couldn't find that link.</p>
     <footer class="foot"><a href="${escapeHtml(origin)}">Skyreader</a></footer>`
  );
}
