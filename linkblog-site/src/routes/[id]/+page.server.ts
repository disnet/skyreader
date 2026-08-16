// Public linkblog index — GET /<did-or-handle>
//
// DIDs are canonical; a handle 302-redirects to its DID so links stay stable
// across handle changes.

import { error, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { apiBaseFor, appUrlFor, blogUrlFor, isDid } from '$lib/fields';
import { fetchPublicationMeta, getProfile, resolveHandleToDid } from '$lib/server/identity';
import {
  fetchLinkblogDocuments,
  fetchSocialContext,
  resolveLinkblogTarget,
  type ProxyConfig,
} from '$lib/server/proxy';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, url }) => {
  const origin = url.origin;
  const id = params.id;

  // Handle → DID: redirect to the canonical DID URL.
  if (!isDid(id)) {
    const did = await resolveHandleToDid(id);
    if (!did) throw error(404, 'Linkblog not found');
    throw redirect(302, blogUrlFor(origin, did));
  }

  const did = id;
  const cfg: ProxyConfig = {
    feedProxyUrl: env.FEED_PROXY_URL || 'http://127.0.0.1:3000',
    feedProxySecret: env.FEED_PROXY_SECRET,
  };

  const apiBase = apiBaseFor(origin, env.API_URL);
  const target = await resolveLinkblogTarget(apiBase, did);
  if (target.hidden) throw error(404, 'Linkblog not found');
  const [profile, pub, docs] = await Promise.all([
    getProfile(did),
    fetchPublicationMeta(did, target.siteUri),
    fetchLinkblogDocuments(cfg, did, [target.siteUri, target.defaultSiteUri]),
  ]);

  // Counts-only social context for the most recent entries (one proxy batch, no
  // per-linker fetches) — keeps the index fast. Best-effort; empty on failure.
  const social = await fetchSocialContext(
    cfg,
    docs.slice(0, 25).map((d) => ({ key: d.recordUri, docUri: d.recordUri }))
  );

  return {
    origin,
    did,
    profile,
    pub,
    docs,
    social,
    apiBase,
    publication: target.siteUri,
    // With a connected publication, these posts have a home of their own and this
    // page is a view of it — worth saying, whatever the canonical ends up being.
    // Absent when the publication record carries no usable site URL.
    externalUrl: target.external ? (pub?.url ?? null) : null,
    // `rel=canonical` only when the connected publication's site is a superset of
    // this page. It usually isn't: the docs above are fetched from BOTH
    // publications, so anything shared before the connection still lives in
    // `skyreader-links` and is listed here but not there. Canonicalizing then
    // would hand search engines a page missing exactly those posts, so this page
    // stays its own canonical instead.
    canonicalUrl:
      target.external && !docs.some((d) => d.siteUri === target.defaultSiteUri)
        ? (pub?.url ?? null)
        : null,
    appUrl: appUrlFor(origin, env.APP_URL),
  };
};
