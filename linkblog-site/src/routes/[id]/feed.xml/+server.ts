// Public linkblog RSS feed — GET /<did-or-handle>/feed.xml
//
// An RSS 2.0 feed of the linkblog, followable from any reader. DIDs are canonical;
// a handle 302-redirects to its DID feed so subscriptions stay stable. The static
// `feed.xml` segment outranks the sibling `[rkey]` route.

import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { apiBaseFor, feedUrlFor, isDid } from '$lib/fields';
import { fetchPublicationMeta, getProfile, resolveHandleToDid } from '$lib/server/identity';
import { fetchLinkblogDocuments, resolveLinkblogTarget } from '$lib/server/api';
import { emptyFeed, renderFeed } from '$lib/server/rss';
import type { RequestHandler } from './$types';

function rss(xml: string, status: number): Response {
  return new Response(xml, {
    status,
    headers: {
      'content-type': 'application/rss+xml; charset=utf-8',
      // Short edge cache — a linkblog updates rarely, readers poll often. No
      // inline scripts here, so caching doesn't interact with the CSP nonce.
      'cache-control': status === 200 ? 'public, max-age=300' : 'no-store',
    },
  });
}

export const GET: RequestHandler = async ({ params, url }) => {
  const origin = url.origin;
  const id = params.id;

  if (!isDid(id)) {
    const did = await resolveHandleToDid(id);
    if (!did) return rss(emptyFeed(origin), 404);
    throw redirect(302, feedUrlFor(origin, did));
  }

  const did = id;
  const apiBase = apiBaseFor(origin, env.API_URL);

  const target = await resolveLinkblogTarget(apiBase, did);
  // A hidden linkblog has no feed either — a subscriber polling an old URL should
  // see it stop, not keep receiving posts from a page that's been taken down.
  if (target.hidden) return rss(emptyFeed(origin), 404);
  const [profile, pub, docs] = await Promise.all([
    getProfile(did),
    fetchPublicationMeta(did, target.siteUri),
    fetchLinkblogDocuments(apiBase, did),
  ]);

  // The API couldn't answer. Refuse rather than render: an empty channel is not a
  // neutral placeholder in a reader, it reads as every entry having been deleted,
  // and a 200 carrying it is edge-cached for five minutes, so a blip that lasted a
  // minute keeps being served long after it's over. 503 + no-store says retry.
  if (!docs) return rss(emptyFeed(origin), 503);

  // Cap the feed length — readers only need the recent window.
  const xml = renderFeed(origin, did, profile, pub, docs.slice(0, 50));
  return rss(xml, 200);
};
