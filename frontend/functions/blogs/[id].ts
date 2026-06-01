// Public linkblog index — GET /blogs/<did-or-handle>
//
// Server-rendered on skyreader.app (Cloudflare Pages Function). DIDs are the
// canonical form; a handle redirects (301) to its DID so links stay stable
// across handle changes.

import {
  BlogContext,
  Profile,
  ProxyDocument,
  PublicationMeta,
  blogTitle,
  escapeHtml,
  externalArticleUrl,
  fetchLinkblogDocuments,
  fetchPublicationMeta,
  formatDate,
  getProfile,
  hostnameOf,
  htmlResponse,
  isDid,
  linkPostNote,
  renderPage,
  resolveHandleToDid,
  rkeyFromUri,
  safeHttpUrl,
} from './_lib';

// The entry body: the user's note (a link post's whole point), falling back to the
// article excerpt for a plain document.
function entryBody(doc: ProxyDocument): string {
  const text = (linkPostNote(doc) || doc.description || doc.textContent || '').trim();
  if (text.length <= 280) return text;
  return text.slice(0, 277).trimEnd() + '…';
}

function renderEntry(did: string, doc: ProxyDocument): string {
  const rkey = rkeyFromUri(doc.recordUri);
  const permalink = rkey ? `/blogs/${encodeURIComponent(did)}/${encodeURIComponent(rkey)}` : null;
  const title = escapeHtml(doc.title || 'Untitled');
  const titleHtml = permalink ? `<a href="${permalink}">${title}</a>` : title;
  const body = entryBody(doc);
  // The shared article's host (link post), falling back to the doc's own URL.
  const host = hostnameOf(externalArticleUrl(doc) || doc.canonicalUrl);
  const date = formatDate(doc.publishedAt || doc.createdAt);

  const meta: string[] = [];
  if (host) meta.push(`<span class="src">${escapeHtml(host)}</span>`);
  if (date) meta.push(`<span>${escapeHtml(date)}</span>`);

  return `<article class="entry">
  <h2>${titleHtml}</h2>
  ${body ? `<p>${escapeHtml(body)}</p>` : ''}
  ${meta.length ? `<div class="meta">${meta.join('')}</div>` : ''}
</article>`;
}

function renderIndex(
  origin: string,
  did: string,
  profile: Profile | null,
  pub: PublicationMeta | null,
  docs: ProxyDocument[]
): string {
  const title = blogTitle(profile, pub);
  const icon = safeHttpUrl(pub?.icon || profile?.avatar);
  const handle = profile?.handle;
  const description = pub?.description;

  const header = `<header>
  <div class="pubhead">
    ${icon ? `<img src="${escapeHtml(icon)}" alt="" />` : ''}
    <div>
      <h1>${escapeHtml(title)}</h1>
      ${handle ? `<p class="byline">by <a href="https://bsky.app/profile/${escapeHtml(handle)}">@${escapeHtml(handle)}</a></p>` : ''}
    </div>
  </div>
  ${description ? `<p class="pubdesc">${escapeHtml(description)}</p>` : ''}
</header>
<hr class="divider" />`;

  const list = docs.length
    ? docs.map((d) => renderEntry(did, d)).join('\n')
    : `<p class="empty">No links yet.</p>`;

  const foot = `<footer class="foot">A linkblog on <a href="${escapeHtml(origin)}">Skyreader</a>, stored in the Atmosphere.</footer>`;

  return header + list + foot;
}

export async function onRequestGet(context: BlogContext): Promise<Response> {
  const { request, env, params } = context;
  const origin = new URL(request.url).origin;
  const id = Array.isArray(params.id) ? params.id[0] : params.id;

  if (!id) {
    return htmlResponse(notFoundPage(origin), 404);
  }

  // Handle → DID: redirect to the canonical DID URL so links stay stable.
  if (!isDid(id)) {
    const did = await resolveHandleToDid(id);
    if (!did) {
      return htmlResponse(notFoundPage(origin), 404);
    }
    return Response.redirect(`${origin}/blogs/${encodeURIComponent(did)}`, 301);
  }

  const did = id;
  const [profile, pub, docs] = await Promise.all([
    getProfile(did),
    fetchPublicationMeta(did),
    fetchLinkblogDocuments(env, did),
  ]);

  const title = blogTitle(profile, pub);
  const body = renderIndex(origin, did, profile, pub, docs);
  const html = renderPage(
    {
      title,
      description: pub?.description || `Links shared by ${profile?.displayName || did}.`,
      image: safeHttpUrl(pub?.icon || profile?.avatar) ?? undefined,
      url: `${origin}/blogs/${encodeURIComponent(did)}`,
    },
    body
  );
  return htmlResponse(html);
}

function notFoundPage(origin: string): string {
  return renderPage(
    { title: 'Not found · Skyreader', url: `${origin}/blogs` },
    `<p class="empty">We couldn't find that linkblog.</p>
     <footer class="foot"><a href="${escapeHtml(origin)}">Skyreader</a></footer>`
  );
}
