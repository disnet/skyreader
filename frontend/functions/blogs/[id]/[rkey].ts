// Public linkblog permalink — GET /blogs/<did-or-handle>/<rkey>
//
// Renders a single linkblog entry. Server-rendered on skyreader.app.

import {
  BlogContext,
  Profile,
  ProxyDocument,
  PublicationMeta,
  SocialContext,
  blogTitle,
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

// The user's note (a link post's commentary), falling back to the article excerpt.
function entryNote(doc: ProxyDocument): string {
  return (linkPostNote(doc) || doc.description || doc.textContent || '').trim();
}

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
  const note = entryNote(doc);
  // The shared article (link post), falling back to the doc's own URL.
  const articleUrl = safeHttpUrl(externalArticleUrl(doc) || doc.canonicalUrl);
  const host = hostnameOf(articleUrl ?? undefined);
  const date = formatDate(doc.publishedAt || doc.createdAt);

  const meta: string[] = [];
  if (host) meta.push(`<span class="src">${escapeHtml(host)}</span>`);
  if (date) meta.push(`<span>${escapeHtml(date)}</span>`);
  const social = renderSocialCounts(ctx);
  if (social) meta.push(social);
  const readMore = articleUrl
    ? `<a class="readmore" href="${escapeHtml(articleUrl)}" rel="noopener noreferrer">Read the full article${host ? ` on ${escapeHtml(host)}` : ''} →</a>`
    : '';

  return `<a class="back" href="/blogs/${encodeURIComponent(did)}">← ${escapeHtml(blogName)}</a>
<article class="entry" style="border-bottom:0;padding-top:0;">
  <h2 style="font-size:1.5rem;">${title}</h2>
  ${meta.length ? `<div class="meta">${meta.join('')}</div>` : ''}
  ${note ? `<p style="margin-top:1.25rem;">${escapeHtml(note)}</p>` : ''}
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
  const note = entryNote(doc);
  const html = renderPage(
    {
      title: `${doc.title || 'Untitled'} · ${blogTitle(profile, pub)}`,
      description: note ? note.slice(0, 280) : undefined,
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
