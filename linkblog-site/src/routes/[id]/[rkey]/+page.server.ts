// Public linkblog permalink — GET /<did-or-handle>/<rkey>
//
// Renders a single linkblog entry.

import { error, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { apiBaseFor, appUrlFor, entryUrlFor, isDid, rkeyFromUri, safeHttpUrl } from '$lib/fields';
import { fetchPublicationMeta, getProfile, resolveHandleToDid } from '$lib/server/identity';
import { fetchLinkblogDocuments, resolveLinkblogTarget } from '$lib/server/api';
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
  const apiBase = apiBaseFor(origin, env.API_URL);
  const target = await resolveLinkblogTarget(apiBase, did);
  if (target.hidden) throw error(404, 'Linkblog not found');
  const [profile, pub, docs] = await Promise.all([
    getProfile(did),
    fetchPublicationMeta(did, target.siteUri),
    fetchLinkblogDocuments(apiBase, did),
  ]);

  // 404 means "this entry does not exist", which we can only say from a list we
  // actually received. An unreachable API is a 503 — a permalink is the URL most
  // likely to be linked from elsewhere, and a 404 invites crawlers to drop it.
  if (!docs) throw error(503, 'Linkblog temporarily unavailable');

  const doc = docs.find((d) => rkeyFromUri(d.recordUri) === rkey);
  if (!doc) throw error(404, 'Link not found');

  return {
    origin,
    did,
    profile,
    pub,
    doc,
    apiBase,
    // Where this entry lives on the connected publication's own site, when we can
    // name that page exactly. `canonicalUrl` is the publication's base URL joined
    // with the document's `path`, and with no path it collapses to the publication
    // home — which is not this post, so it's no good as a canonical or a "read it
    // there" link. Null then, and the page canonicalizes to itself.
    sourceUrl:
      target.external && doc.siteUri === target.siteUri && doc.path
        ? safeHttpUrl(doc.canonicalUrl)
        : null,
    externalUrl: target.external ? (pub?.url ?? null) : null,
    appUrl: appUrlFor(origin, env.APP_URL),
  };
};
