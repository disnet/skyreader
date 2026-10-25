// Public link page — read.skyreader.app/<article URL> (or /link/<article URL> on
// any other host of this app).
//
// "Discussion across the Atmosphere": the article's title and description, then
// who posted, noted, highlighted and saved it, from the API's cached public
// answer. The bare host is a landing page with a box to paste a link into.

import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { apiBaseFor, appUrlFor } from '$lib/fields';
import {
  articleUrlFromPage,
  linkPageUrl,
  MAX_REFRESHES,
  REFRESH_PARAM,
  safeArticleUrl,
} from '$lib/link';
import { fetchLinkPage } from '$lib/server/api';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, setHeaders }) => {
  const origin = url.origin;
  const appUrl = appUrlFor(origin, env.APP_URL);
  const articleUrl = articleUrlFromPage(url);

  if (!articleUrl) {
    // The landing box submits ?url=…; send it to the readable /<article> form.
    const submitted = url.searchParams.get('url')?.trim();
    if (submitted) {
      const target = safeArticleUrl(
        /^https?:\/\//i.test(submitted) ? submitted : `https://${submitted}`
      );
      if (target) throw redirect(303, linkPageUrl(origin, url.hostname, target));
      return { kind: 'landing' as const, appUrl, invalid: true };
    }
    return {
      kind: 'landing' as const,
      appUrl,
      invalid: url.pathname.replace(/^\/(link\/?)?/, '') !== '',
    };
  }

  const apiBase = apiBaseFor(origin, env.API_URL);
  const result = await fetchLinkPage(apiBase, articleUrl);
  const refreshes = Math.max(0, Number(url.searchParams.get(REFRESH_PARAM)) || 0);
  const settled = result.kind === 'ok' && !result.data.pending && !result.data.unavailable;
  // A settled page is cached briefly at the edge; anything still looking or
  // failing must be asked again on the next visit.
  setHeaders({ 'cache-control': settled ? 'public, max-age=60' : 'no-store' });

  // While the lookup runs, the page refreshes itself (a meta refresh: the page
  // ships no script) a bounded number of times.
  let refreshUrl: string | null = null;
  if (result.kind === 'ok' && result.data.pending && refreshes < MAX_REFRESHES) {
    const next = new URL(url);
    next.searchParams.set(REFRESH_PARAM, String(refreshes + 1));
    refreshUrl = next.pathname + next.search;
  }

  return {
    kind: 'link' as const,
    appUrl,
    articleUrl: result.kind === 'ok' ? result.data.url : articleUrl,
    pageUrl: linkPageUrl(origin, url.hostname, result.kind === 'ok' ? result.data.url : articleUrl),
    status: result.kind,
    data: result.kind === 'ok' ? result.data : null,
    refreshUrl,
  };
};
