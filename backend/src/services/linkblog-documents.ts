/**
 * Document source for the PUBLIC linkblog (`linkblogs.skyreader.app/<did>`).
 *
 * The public site used to read these through the Fly proxy's `POST /documents`,
 * and did the publication scoping and link-post filtering itself. That put a
 * second copy of the record mapper on a box that only redeploys on release, so a
 * lexicon change shipped here rendered as posts silently vanishing there (a
 * `links` union the old proxy read as an empty array — see
 * linkblog-site/CLAUDE.md). One mapper, on the side that already stores these
 * records, removes the skew rather than re-synchronising it.
 *
 * D1 first, live PDS listing on a miss — the same posture as
 * `serveSingleDocument`, and for the same reason: the stored set covers authors
 * somebody subscribes to, while a public linkblog has to render for an author
 * nobody subscribes to at all. The live path doesn't write anything back; a
 * public read is not an ingest.
 */
import type { Env } from '../types';
import type { ProxyDocument } from './feed-proxy-client';
import type { LinkblogTarget } from './linkblog-sync';
import { loadAuthorDocuments } from './document-store';
import {
  createPdsMemo,
  isValidDid,
  listAuthorDocuments,
  MAX_DOCUMENTS_PER_AUTHOR,
  recordToDocument,
  resolveSiteMeta,
  type SiteMeta,
} from './standard-site';

/**
 * Every publication a reader's view of this linkblog covers: where the author
 * publishes now, their own Skyreader publication, and — while a move off the
 * legacy rkey is unfinished — the one they moved from. Usually one or two.
 */
export function linkblogScopes(target: LinkblogTarget): string[] {
  return [...new Set([target.siteUri, target.defaultSiteUri, target.legacySiteUri])].filter(
    (uri): uri is string => !!uri
  );
}

/** The article a link post points at, if any. */
export function externalArticleUrl(doc: ProxyDocument): string | undefined {
  return doc.links?.find((l) => /^https?:\/\//i.test(l.uri))?.uri;
}

/** Publications Skyreader owns for this author: everything in them is a share. */
function ownPublications(target: LinkblogTarget): Set<string> {
  return new Set([target.defaultSiteUri, target.legacySiteUri].filter((u): u is string => !!u));
}

function dedupeByUri(documents: ProxyDocument[]): ProxyDocument[] {
  return [...new Map(documents.map((d) => [d.recordUri, d])).values()];
}

/**
 * The author's stored documents across every publication this linkblog covers.
 *
 * One query per scope rather than one `site_uri IN (...)` query, because the
 * per-author `LIMIT` has to apply per scope: an author who publishes essays on a
 * connected publication and links on `skyreader-links` would otherwise spend the
 * whole limit on essays this page then filters out, and lose the link back
 * catalogue that is the point of the page.
 *
 * `readerCollections: false` because this page has no notion of curated editions
 * — the public site's `ProxyDocument` doesn't even declare the field. Left on, the
 * fan-out would be per scope AND per call: `loadAuthorDocuments` defaults to a
 * FRESH resolve budget when it isn't handed one, so three scopes meant three
 * budgets, and one anonymous page view of an author with editions and a cold
 * preview cache could issue resolves well past the ceiling that number exists to
 * impose — each one up to `MAX_COLLECTION_ITEMS` cross-PDS reads, on a route with
 * no session for the rate limiter to key on.
 */
async function loadFromD1(env: Env, did: string, scopes: string[]): Promise<ProxyDocument[]> {
  const perScope = await Promise.all(
    scopes.map((siteUri) => loadAuthorDocuments(env, did, { siteUri, readerCollections: false }))
  );
  return dedupeByUri(perScope.flat());
}

/**
 * List the author's documents straight from their PDS and map them with the same
 * mapper the stored path uses. Throws on PDS resolution / fetch failure, like
 * `listAuthorDocuments` itself.
 */
async function loadFromPds(env: Env, did: string, scopes: string[]): Promise<ProxyDocument[]> {
  const listing = await listAuthorDocuments(did, createPdsMemo());
  const wanted = new Set(scopes);
  const records = listing.records.filter((r) => r.value.site && wanted.has(r.value.site));
  if (records.length === 0) return [];

  // One resolve per distinct publication, not per document — `resolveSiteMeta` is
  // D1-cached (24h, 5min negative), so this is usually a point read or two.
  const metas = new Map<string, SiteMeta>();
  for (const siteUri of new Set(records.map((r) => r.value.site as string))) {
    metas.set(siteUri, await resolveSiteMeta(env, siteUri));
  }

  return records.map((r) =>
    recordToDocument(did, r.uri, r.cid, r.value, metas.get(r.value.site as string)!)
  );
}

/**
 * A linkblog is links, so from a CONNECTED publication only entries that link out
 * are listed — it is also its home app's blog and can hold essays written in
 * Leaflet/pckt/…. Everything in a publication Skyreader owns is a share by
 * construction and is listed whether or not it carries a link.
 *
 * Ordered newest-SHARED-first (`createdAt`), not by the article's own publish
 * date: ranking an old article shared today by `publishedAt` would bury it.
 */
export function rankForLinkblog(
  documents: ProxyDocument[],
  target: LinkblogTarget
): ProxyDocument[] {
  const own = ownPublications(target);
  const posts = documents.filter((d) => own.has(d.siteUri) || externalArticleUrl(d));
  posts.sort(
    (a, b) => (new Date(b.createdAt).getTime() || 0) - (new Date(a.createdAt).getTime() || 0)
  );
  return posts.slice(0, MAX_DOCUMENTS_PER_AUTHOR);
}

/**
 * Whether this DID belongs to a Skyreader account.
 *
 * The precondition on the live PDS listing below. `loadLinkblogDocuments` is
 * reachable unauthenticated, and the rate limiter in `index.ts` keys on
 * `session.did`, so a public read is never limited by it. The fallback resolves
 * the DID document and then walks `listRecords` pages from whatever endpoint that
 * document names — which for `did:web:<a-host-I-control>` is a request to my
 * server, repeated as fast as I can loop, at the Worker's expense. The resolve
 * endpoint beside this one does no outbound I/O at all; this one shouldn't do it
 * on an unknown DID either.
 *
 * A public linkblog only exists for a Skyreader account, so registration is the
 * honest precondition. `users` rather than `user_settings`: the former is written
 * at sign-in, the latter lazily on the first setting touched, so a user who has
 * changed nothing has no row in it. A D1 failure reads as unregistered, which
 * costs an empty list on the one request — the same thing the fallback's own
 * catch already yields.
 */
async function isRegisteredUser(env: Env, did: string): Promise<boolean> {
  try {
    const row = await env.DB.prepare('SELECT 1 FROM users WHERE did = ?').bind(did).first();
    return row !== null;
  } catch {
    return false;
  }
}

/**
 * The public linkblog's post list for one author, already scoped, filtered and
 * ordered. Never throws: a PDS failure on the fallback path yields an empty list,
 * matching the best-effort posture the public page has always had (it degrades to
 * the author's profile rather than erroring).
 */
export async function loadLinkblogDocuments(
  env: Env,
  did: string,
  target: LinkblogTarget
): Promise<ProxyDocument[]> {
  if (!isValidDid(did)) return [];
  const scopes = linkblogScopes(target);
  if (scopes.length === 0) return [];

  const stored = await loadFromD1(env, did, scopes);
  if (stored.length > 0) return rankForLinkblog(stored, target);

  // Nothing stored for any of this author's publications. Either nobody
  // subscribes to them (so they were never ingested) or they genuinely have no
  // posts; one listing answers both, and an author with no posts is cheap.
  //
  // Only for a DID that is actually a Skyreader account — see `isRegisteredUser`.
  // The stored path above stays open to anyone: it is local reads, and gating it
  // would break nothing an attacker cares about.
  if (!(await isRegisteredUser(env, did))) return [];

  try {
    return rankForLinkblog(await loadFromPds(env, did, scopes), target);
  } catch (error) {
    console.error(`Linkblog document listing failed for ${did}:`, error);
    return [];
  }
}
