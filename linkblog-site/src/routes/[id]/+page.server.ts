// Public linkblog index — GET /<did-or-handle>
//
// DIDs are canonical; a handle 302-redirects to its DID so links stay stable
// across handle changes.

import { error, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { apiBaseFor, appUrlFor, blogUrlFor, isDid } from '$lib/fields';
import { fetchPublicationMeta, getProfile, resolveHandleToDid } from '$lib/server/identity';
import { fetchLinkblogDocuments, resolveLinkblogTarget } from '$lib/server/api';
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
  const apiBase = apiBaseFor(origin, env.API_URL);
  const target = await resolveLinkblogTarget(apiBase, did);
  if (target.hidden) throw error(404, 'Linkblog not found');
  const [profile, pub, fetched] = await Promise.all([
    getProfile(did),
    fetchPublicationMeta(did, target.siteUri),
    fetchLinkblogDocuments(apiBase, did),
  ]);
  // Fail open like the resolve above: an API blip renders an empty page at a URL
  // people have bookmarked rather than an error. `fetched` stays around because
  // `null` (couldn't ask) and `[]` (nothing shared) are not the same answer to the
  // canonical question below.
  const docs = fetched ?? [];

  return {
    origin,
    did,
    profile,
    pub,
    docs,
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
    // stays its own canonical instead. A failed fetch is not evidence of a
    // superset either — canonicalizing off an outage would point crawlers away
    // from this page on the strength of a list we never received.
    canonicalUrl:
      fetched && target.external && !fetched.some((d) => d.siteUri === target.defaultSiteUri)
        ? (pub?.url ?? null)
        : null,
    appUrl: appUrlFor(origin, env.APP_URL),
  };
};
