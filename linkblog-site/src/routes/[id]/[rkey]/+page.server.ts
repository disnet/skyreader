// Public linkblog permalink — GET /<did-or-handle>/<rkey>
//
// Renders a single linkblog entry.

import { error, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import {
  apiBaseFor,
  appUrlFor,
  entryUrlFor,
  externalArticleUrl,
  isDid,
  rkeyFromUri,
} from '$lib/fields';
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
  const rkey = params.rkey;

  // Handle → DID redirect, preserving the rkey.
  if (!isDid(id)) {
    const did = await resolveHandleToDid(id);
    if (!did) throw error(404, 'Linkblog not found');
    throw redirect(302, entryUrlFor(origin, did, rkey));
  }

  const did = id;
  const cfg: ProxyConfig = {
    feedProxyUrl: env.FEED_PROXY_URL || 'http://127.0.0.1:3000',
    feedProxySecret: env.FEED_PROXY_SECRET,
  };

  const apiBase = apiBaseFor(origin, env.API_URL);
  const target = await resolveLinkblogTarget(apiBase, did);
  const [profile, pub, docs] = await Promise.all([
    getProfile(did),
    fetchPublicationMeta(did, target.siteUri),
    fetchLinkblogDocuments(cfg, did, [target.siteUri, target.defaultSiteUri]),
  ]);

  const doc = docs.find((d) => rkeyFromUri(d.recordUri) === rkey);
  if (!doc) throw error(404, 'Link not found');

  // Full social context for this single entry: recommend/quote counts + who else
  // across the Atmosphere linked the same article (with their notes). Best-effort.
  const social = await fetchSocialContext(cfg, [
    {
      key: doc.recordUri,
      docUri: doc.recordUri,
      articleUrl: externalArticleUrl(doc),
      excludeDid: did,
    },
  ]);

  return {
    origin,
    did,
    profile,
    pub,
    doc,
    ctx: social.get(doc.recordUri),
    apiBase,
    appUrl: appUrlFor(origin, env.APP_URL),
  };
};
