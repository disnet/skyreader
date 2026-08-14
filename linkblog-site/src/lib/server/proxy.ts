// Feed-proxy client for the public linkblog: documents (the link posts) and
// social context (Constellation counts + "also linked by"). Both best-effort —
// they return empty on any error so the page still renders.

import { externalArticleUrl, publicationUri } from '$lib/fields';
import type { ProxyDocument, SocialContext } from '$lib/types';

export interface ProxyConfig {
  feedProxyUrl: string;
  feedProxySecret?: string;
}

export interface LinkblogTarget {
  siteUri: string;
  defaultSiteUri: string;
  /**
   * Don't render this linkblog: the user deleted it, or connected an existing
   * publication and turned this page off. The backend collapses both into one
   * flag — which it is isn't the reader's business.
   */
  hidden: boolean;
  /** The links live in a publication the user already had, with a site of its own. */
  external: boolean;
}

// One retry on a failed resolve. This is the only call that can say "don't render
// this", and unlike the documents/social fetches its fallback is not "show less"
// but "show something the user may have taken down" — worth a second attempt
// before giving up. Kept to one so a hard backend outage doesn't double the TTFB
// of every linkblog page.
async function fetchResolve(apiBase: string, did: string): Promise<Response | null> {
  const url = `${apiBase}/api/linkblog/resolve/${encodeURIComponent(did)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch {
      // Fall through to the retry, then to the caller's fail-open.
    }
  }
  return null;
}

export async function resolveLinkblogTarget(apiBase: string, did: string): Promise<LinkblogTarget> {
  const fallback = publicationUri(did);
  // Fail open, deliberately. A resolve that can't answer degrades to the default
  // publication and a visible page. Failing closed instead would take every
  // linkblog AND its RSS feed offline on an API blip — the documents come from the
  // feed proxy, not this call, so the content itself is unaffected by the outage.
  //
  // What fail-open can expose is bounded on both sides. A deleted linkblog has no
  // posts left to show. A hidden page requires a connected publication, so its
  // posts are already public on that publication's own site — and because
  // `siteUri` falls back to the default here, the documents fetched are scoped to
  // `skyreader-links` alone, which is where a connected user is no longer
  // publishing. So the exposure is at most their pre-connection posts, which were
  // public at this address before they ever connected.
  const unresolved: LinkblogTarget = {
    siteUri: fallback,
    defaultSiteUri: fallback,
    hidden: false,
    external: false,
  };
  if (!apiBase) return unresolved;
  try {
    const res = await fetchResolve(apiBase, did);
    if (!res) throw new Error();
    const data = (await res.json()) as {
      siteUri?: string;
      defaultSiteUri?: string;
      hidden?: boolean;
    };
    const siteUri = data.siteUri || fallback;
    const defaultSiteUri = data.defaultSiteUri || fallback;
    return {
      siteUri,
      defaultSiteUri,
      hidden: data.hidden === true,
      external: siteUri !== defaultSiteUri,
    };
  } catch {
    return unresolved;
  }
}

function proxyHeaders(cfg: ProxyConfig): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.feedProxySecret) headers['X-Proxy-Secret'] = cfg.feedProxySecret;
  return headers;
}

// Fetch the user's linkblog documents through the feed proxy. Scoped to the
// dedicated skyreader-links publication, plus the existing standard.site
// publication they've connected, if any. Returns newest-shared-first.
//
// A connected publication is also its home app's blog, so it can hold posts that
// aren't link posts (essays written in Leaflet/pckt/…). A linkblog is links, so
// only entries that link out are listed from it; everything in the Skyreader
// publication is a share by construction.
export async function fetchLinkblogDocuments(
  cfg: ProxyConfig,
  did: string,
  siteUris: string[] = [publicationUri(did)]
): Promise<ProxyDocument[]> {
  const defaultSiteUri = publicationUri(did);
  try {
    const res = await fetch(`${cfg.feedProxyUrl}/documents`, {
      method: 'POST',
      headers: proxyHeaders(cfg),
      body: JSON.stringify({
        authors: [...new Set(siteUris)].map((siteUri) => ({ did, siteUri })),
      }),
    });
    if (!res.ok) return [];

    const data = (await res.json()) as {
      authors?: Array<{ documents?: ProxyDocument[]; status?: string }>;
    };
    const docs = [
      ...new Map(
        (data.authors ?? [])
          .flatMap((a) => a.documents ?? [])
          .filter((d) => d.siteUri === defaultSiteUri || externalArticleUrl(d))
          .map((d) => [d.recordUri, d])
      ).values(),
    ];
    // A linkblog reads newest-shared-first. Order by when each link was shared
    // (the record's `createdAt`), not by the article's own publish date — the
    // proxy sorts its generic document feed by `publishedAt`, which would float
    // an old article shared today to the wrong place.
    docs.sort(
      (a, b) => (new Date(b.createdAt).getTime() || 0) - (new Date(a.createdAt).getTime() || 0)
    );
    return docs;
  } catch {
    return [];
  }
}

// Batch-fetch Constellation social context for link posts via the proxy. Keyed by
// each item's `key` (the document's record URI). Pass `articleUrl` to also surface
// "who else linked this" (heavier — it fetches each linker's note); omit it for a
// counts-only lookup (used on the index to keep SSR fast).
export async function fetchSocialContext(
  cfg: ProxyConfig,
  items: Array<{
    key: string;
    docUri?: string;
    articleUrl?: string;
    excludeDid?: string;
  }>
): Promise<Map<string, SocialContext>> {
  const out = new Map<string, SocialContext>();
  if (items.length === 0) return out;
  try {
    const res = await fetch(`${cfg.feedProxyUrl}/social-context`, {
      method: 'POST',
      headers: proxyHeaders(cfg),
      body: JSON.stringify({ items: items.slice(0, 25) }),
    });
    if (!res.ok) return out;

    const data = (await res.json()) as { items?: SocialContext[] };
    for (const ctx of data.items ?? []) {
      if (ctx?.key) out.set(ctx.key, ctx);
    }
    return out;
  } catch {
    return out;
  }
}
