// Public linkblog index — GET /<did-or-handle>
//
// DIDs are canonical; a handle 302-redirects to its DID so links stay stable
// across handle changes.

import { error, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { apiBaseFor, appUrlFor, blogUrlFor, isDid } from '$lib/fields';
import { fetchPublicationMeta, getProfile, resolveHandleToDid } from '$lib/server/identity';
import { fetchLinkblogDocuments, fetchSocialContext, type ProxyConfig } from '$lib/server/proxy';
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

  const [profile, pub, docs] = await Promise.all([
    getProfile(did),
    fetchPublicationMeta(did),
    fetchLinkblogDocuments(cfg, did),
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
    apiBase: apiBaseFor(origin, env.API_URL),
    appUrl: appUrlFor(origin, env.APP_URL),
  };
};
