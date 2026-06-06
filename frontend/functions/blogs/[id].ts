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
  apiBaseFor,
  articleExcerpt,
  blogTitle,
  clampText,
  decodeParam,
  escapeHtml,
  externalArticleUrl,
  feedUrlFor,
  fetchLinkblogDocuments,
  fetchPublicationMeta,
  fetchSocialContext,
  formatDate,
  getProfile,
  hostnameOf,
  htmlResponse,
  isDid,
  linkPostNote,
  publicationUri,
  redirect,
  renderPage,
  renderSocialCounts,
  renderSubscribeScript,
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
  social: Map<string, SocialContext>,
  apiBase: string
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

  // Two ways to subscribe. "Atmosphere" subscribes inline — it writes a portable
  // site.standard.graph.subscription to the visitor's PDS (redirecting to login
  // first if needed); "RSS" is the open-standard feed any reader can follow. The
  // Atmosphere control is a <button> wired up by renderSubscribeScript.
  const atmosphereBtn = `<button id="atmo-sub" type="button" class="sub-link sub-action" data-state="idle" title="Subscribe in the Atmosphere">
    <svg class="ico-follow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
    <svg class="ico-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
    <span class="sub-label">Atmosphere</span>
  </button>`;
  const rssLink = `<a class="sub-link" href="${escapeHtml(feedUrlFor(origin, did))}" title="Subscribe via RSS">
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.18 17.82a2.18 2.18 0 1 0 0 4.36 2.18 2.18 0 0 0 0-4.36zM4 11.13v3.05a6.82 6.82 0 0 1 6.82 6.82h3.05A9.87 9.87 0 0 0 4 11.13zm0-6.63v3.05c7.16 0 12.96 5.8 12.96 12.95H20C20 11.07 12.84 4.5 4 4.5z"/></svg>
    <span>RSS</span>
  </a>`;
  // Space is reserved (visibility:hidden); the subscribe script adds .show once
  // subscribed so revealing it doesn't shift the masthead. The href deep-links to
  // this linkblog's feed: ?feed=<publicationUri> is a stable, cross-user key the
  // app resolves to the visitor's local subscription (FeedPage canonicalizes it to
  // the numeric id on load).
  const openHref = `/?feed=${encodeURIComponent(publicationUri(did))}`;
  const openLink = `<a id="atmo-open" class="open-app" href="${escapeHtml(openHref)}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
    <span>Open in Skyreader</span>
  </a>`;

  const header = `<header>
  <div class="pubhead">
    ${icon ? `<img class="pubicon" src="${escapeHtml(icon)}" alt="" />` : ''}
    <div class="pubmeta">
      <h1>${escapeHtml(title)}</h1>
      ${byline ? `<p class="byline">${byline}</p>` : ''}
    </div>
    <div class="pubactions">
      <span class="pubactions-label">Subscribe via:</span>
      ${atmosphereBtn}${rssLink}${openLink}
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

  const script = renderSubscribeScript(apiBase, publicationUri(did));

  return header + list + foot + script;
}

export async function onRequestGet(context: BlogContext): Promise<Response> {
  const { request, env, params } = context;
  const origin = new URL(request.url).origin;
  const id = decodeParam(params.id);

  if (!id) {
    return htmlResponse(notFoundPage(origin), 404);
  }

  // Handle → DID: redirect to the canonical DID URL so links stay stable.
  if (!isDid(id)) {
    const did = await resolveHandleToDid(id);
    if (!did) {
      return htmlResponse(notFoundPage(origin), 404);
    }
    return redirect(`${origin}/blogs/${encodeURIComponent(did)}`);
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
  const body = renderIndex(origin, did, profile, pub, docs, social, apiBaseFor(origin, env));
  const html = renderPage(
    {
      title,
      description: pub?.description || `Links shared by ${profile?.displayName || did}.`,
      image: safeHttpUrl(pub?.icon || profile?.avatar) ?? undefined,
      url: `${origin}/blogs/${encodeURIComponent(did)}`,
      feedUrl: feedUrlFor(origin, did),
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
