// Feed-proxy client for the public linkblog: documents (the link posts) and
// social context (Constellation counts + "also linked by"). Both best-effort —
// they return empty on any error so the page still renders.

import { externalArticleUrl, publicationUri } from '$lib/fields';
import type { ProxyDocument, SocialContext } from '$lib/types';

export interface ProxyConfig {
  feedProxyUrl: string;
  feedProxySecret?: string;
}

export async function resolveLinkblogTarget(
  apiBase: string,
  did: string
): Promise<{ siteUri: string; defaultSiteUri: string }> {
  const fallback = publicationUri(did);
  if (!apiBase) return { siteUri: fallback, defaultSiteUri: fallback };
  try {
    const res = await fetch(`${apiBase}/api/linkblog/resolve/${encodeURIComponent(did)}`);
    if (!res.ok) throw new Error();
    return (await res.json()) as { siteUri: string; defaultSiteUri: string };
  } catch {
    return { siteUri: fallback, defaultSiteUri: fallback };
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
