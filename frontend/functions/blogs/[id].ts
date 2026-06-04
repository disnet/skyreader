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
  renderPage,
  renderSocialCounts,
  resolveHandleToDid,
  rkeyFromUri,
  safeHttpUrl,
} from './_lib';

function renderEntry(did: string, doc: ProxyDocument, ctx: SocialContext | undefined): string {
  const rkey = rkeyFromUri(doc.recordUri);
  const permalink = rkey ? `/blogs/${encodeURIComponent(did)}/${encodeURIComponent(rkey)}` : null;
  const title = escapeHtml(doc.title || 'Untitled');
  // The title anchor stretches over the whole row (its ::after covers the <li>),
  // so the entire entry is one calm tap target to the permalink.
  const titleHtml = permalink ? `<a href="${permalink}">${title}</a>` : title;

  // Two distinct things: the user's own note (their voice, plain text) and a
  // snippet quoted from the article (the article's voice). Rendered separately so
  // it's always clear which is which; the excerpt is dropped when it just repeats
  // the note.
  const note = linkPostNote(doc).trim();
  const excerpt = articleExcerpt(doc);
  const noteHtml = note ? `<p class="entry-note">${escapeHtml(clampText(note, 280))}</p>` : '';
  const quoteHtml =
    excerpt && excerpt !== note
      ? `<blockquote class="entry-quote"><p>${escapeHtml(clampText(excerpt, 200))}</p></blockquote>`
      : '';

  // The shared article's host (link post), falling back to the doc's own URL.
  const host = hostnameOf(externalArticleUrl(doc) || doc.canonicalUrl);
  // Share time (when this went on the linkblog), not the article's publish date.
  const date = formatDate(doc.createdAt || doc.publishedAt);

  const meta: string[] = [];
  if (host) meta.push(`<span class="src">${escapeHtml(host)}</span>`);
  if (date) meta.push(`<span>${escapeHtml(date)}</span>`);
  const social = renderSocialCounts(ctx);
  if (social) meta.push(social);
  const metaHtml = meta.join('<span class="sep" aria-hidden="true">·</span>');

  return `<li class="entry">
  <h2 class="entry-title">${titleHtml}</h2>
  ${noteHtml}
  ${quoteHtml}
  ${meta.length ? `<div class="meta">${metaHtml}</div>` : ''}
</li>`;
}

function renderIndex(
  origin: string,
  did: string,
  profile: Profile | null,
  pub: PublicationMeta | null,
  docs: ProxyDocument[],
  social: Map<string, SocialContext>
): string {
  const title = blogTitle(profile, pub);
  const icon = safeHttpUrl(pub?.icon || profile?.avatar);
  const handle = profile?.handle;
  const description = pub?.description;

  // Byline: "by @handle · 42 links" — author credit plus a quiet sense of the
  // shelf's depth. Either half stands alone if the other is missing.
  const count = docs.length;
  const countLabel = count > 0 ? `${count} ${count === 1 ? 'link' : 'links'}` : '';
  const bylineParts: string[] = [];
  if (handle) {
    bylineParts.push(
      `by <a href="https://bsky.app/profile/${escapeHtml(handle)}">@${escapeHtml(handle)}</a>`
    );
  }
  if (countLabel) bylineParts.push(escapeHtml(countLabel));
  const byline = bylineParts.join(' · ');

  const header = `<header>
  <div class="pubhead">
    ${icon ? `<img class="pubicon" src="${escapeHtml(icon)}" alt="" />` : ''}
    <div class="pubmeta">
      <h1>${escapeHtml(title)}</h1>
      ${byline ? `<p class="byline">${byline}</p>` : ''}
    </div>
  </div>
  ${description ? `<p class="pubdesc">${escapeHtml(description)}</p>` : ''}
</header>
<hr class="divider" />`;

  const who = profile?.displayName || (handle ? `@${handle}` : 'This reader');
  const list = docs.length
    ? `<ol class="entries">${docs.map((d) => renderEntry(did, d, social.get(d.recordUri))).join('\n')}</ol>`
    : `<div class="empty">
      <p class="empty-title">No links yet</p>
      <p class="empty-sub">When ${escapeHtml(who)} shares an article, it shows up here.</p>
    </div>`;

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

  // Counts-only social context for the most recent entries (one proxy batch, no
  // per-linker PDS fetches) — keeps the index fast. Best-effort; empty on failure.
  const social = await fetchSocialContext(
    env,
    docs.slice(0, 25).map((d) => ({ key: d.recordUri, docUri: d.recordUri }))
  );

  const title = blogTitle(profile, pub);
  const body = renderIndex(origin, did, profile, pub, docs, social);
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
