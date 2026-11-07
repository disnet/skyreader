import type { Reroute } from '@sveltejs/kit';
import { isArticlePath, isReadHost, LINK_PREFIX } from '$lib/link';

// read.skyreader.app/<article URL> is the link page. It's served by the /link
// route, so on a read host every path is routed there; the page reads the
// article back from the ORIGINAL URL (see articleUrlFromPage), since route
// params are decoded and would lose the article's own percent-encoding.
export const reroute: Reroute = ({ url }) => {
  if (!isReadHost(url.hostname) || url.pathname.startsWith('/_app/')) return;
  if (!isArticlePath(url.pathname)) return;
  return `${LINK_PREFIX}${url.pathname === '/' ? '' : url.pathname}`;
};
