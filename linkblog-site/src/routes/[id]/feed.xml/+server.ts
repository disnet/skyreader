// Public linkblog RSS feed — GET /<did-or-handle>/feed.xml
//
// An RSS 2.0 feed of the linkblog, followable from any reader. DIDs are canonical;
// a handle 302-redirects to its DID feed so subscriptions stay stable. The static
// `feed.xml` segment outranks the sibling `[rkey]` route.

import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { feedUrlFor, isDid } from '$lib/fields';
import { fetchPublicationMeta, getProfile, resolveHandleToDid } from '$lib/server/identity';
import { fetchLinkblogDocuments, type ProxyConfig } from '$lib/server/proxy';
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
  const cfg: ProxyConfig = {
    feedProxyUrl: env.FEED_PROXY_URL || 'http://127.0.0.1:3000',
    feedProxySecret: env.FEED_PROXY_SECRET,
  };

  const [profile, pub, docs] = await Promise.all([
    getProfile(did),
    fetchPublicationMeta(did),
    fetchLinkblogDocuments(cfg, did),
  ]);

  // Cap the feed length — readers only need the recent window.
  const xml = renderFeed(origin, did, profile, pub, docs.slice(0, 50));
  return rss(xml, 200);
};
