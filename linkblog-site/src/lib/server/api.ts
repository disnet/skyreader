// Skyreader API client for the public linkblog: the linkblog's target publication
// and its posts. Best-effort — the resolve fails open to a default target, and the
// documents fetch reports a failure as `null` rather than as an empty linkblog.
//
// This file used to be a feed-proxy client as well, for Constellation social
// context (recommend/quote counts and "also linked by"). That was the last thing
// on this page reaching past the API, and it cost a second origin, a second shared
// secret and a second deploy cadence to adorn a page whose job is the text. It was
// dropped rather than ported.

import { publicationUri } from '$lib/fields';
import type { ProxyDocument } from '$lib/types';

export interface LinkblogTarget {
  siteUri: string;
  defaultSiteUri: string;
  /**
   * The author's old `skyreader-links` publication, when their own publication
   * has since moved to a TID rkey. Scoped alongside the others so a move that
   * was interrupted partway still renders every post, wherever it sits.
   */
  legacySiteUri?: string;
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
  // linkblog AND its RSS feed offline on an API blip. The posts come from the same
  // API now, so an outage empties the page either way; the difference this choice
  // still makes is an empty page rather than a 404 at a URL people have bookmarked.
  //
  // Fail-open no longer exposes anything: /api/linkblog/documents applies the same
  // hidden/deleted gate itself, so a page this call failed to resolve renders as an
  // empty shell rather than as posts the author took down.
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
      legacySiteUri?: string;
      hidden?: boolean;
    };
    const siteUri = data.siteUri || fallback;
    const defaultSiteUri = data.defaultSiteUri || fallback;
    return {
      siteUri,
      defaultSiteUri,
      legacySiteUri: data.legacySiteUri,
      hidden: data.hidden === true,
      external: siteUri !== defaultSiteUri,
    };
  } catch {
    return unresolved;
  }
}

// Fetch the linkblog's posts from the Skyreader API. The response is already
// scoped to the author's publications, filtered to link posts, and ordered
// newest-shared-first — all of that lives in `backend/src/services/
// linkblog-documents.ts`, beside the records themselves.
//
// It used to live here, over a `POST /documents` call to the Fly feed proxy, which
// meant two copies of the record mapper on two deploy cadences: a `site.standard.
// document` written with the current `links` union came back link-less from a
// proxy that predated it, and this file's own "does it link out?" filter then
// dropped every post on a connected publication, with no error anywhere. One
// implementation, on the side that stores the records, is the fix.
//
// `null` means the API couldn't answer, and is deliberately distinct from `[]`.
// Collapsing the two lets an outage render as a fact: the RSS feed would emit a
// well-formed channel with no items, aggregators read that as every entry having
// been deleted, and the 200 carrying it is edge-cached for five minutes, so a
// one-minute blip outlives itself in other people's readers. Callers decide —
// the pages fail open to an empty shell, the feed refuses to answer.
//
// A 404 (the linkblog is hidden or deleted) is `null` too. `resolveLinkblogTarget`
// normally catches that case first and the caller 404s on `target.hidden`; this
// path is only reached when the resolve ALSO failed, and "come back later" is the
// honest answer when both calls are failing.
export async function fetchLinkblogDocuments(
  apiBase: string,
  did: string
): Promise<ProxyDocument[] | null> {
  if (!apiBase) return null;
  try {
    const res = await fetch(`${apiBase}/api/linkblog/documents/${encodeURIComponent(did)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { documents?: ProxyDocument[] };
    return data.documents ?? [];
  } catch {
    return null;
  }
}
