/**
 * External-backed saves — the READ path (snapshot poll + in-memory join).
 *
 * Proven end-to-end in Phase 0 against real Semble + Margin collections (via a
 * since-removed read-path spike). See docs/plans/EXTERNAL_BACKED_SAVES_PLAN.md.
 *
 * Properties this module relies on, all confirmed live (2026-06-18):
 *  - Reads are AUTH-FREE. `com.atproto.repo.listRecords`/`getRecord` are public, so
 *    a snapshot needs only DID->PDS resolution, not a DPoP session (Phase 2 invariant 3).
 *  - A `listRecords` snapshot of the owner's collection is a CONSISTENT set, so the
 *    membership↔item join is a pure in-memory operation — no event ordering, no
 *    durable reconcile state.
 *  - Collections are HETEROGENEOUS: one collection's membership records can point at
 *    different item lexicons (a Semble card next to a community bookmark were seen in
 *    one Margin collection). Import resolves whatever type it finds and extracts a URL
 *    per shape. (Writing stays single-type per provider — that's the write path.)
 *  - Membership targets can be CROSS-REPO: a Margin collectionItem.annotation pointed
 *    at a bookmark in a different DID's repo. Each item is resolved by the DID in its
 *    own at-uri, never by assuming the collection owner's repo.
 */

import { resolvePdsUrl } from '../../utils/did-resolver';
import { parseAtUri } from '../../utils/canonical-url';
import { normalizeArticleUrl } from '../../utils/url-normalize';

export type BackingProviderName = 'semble' | 'margin';

/** One resolved member of a backed collection (an article save). */
export interface BackedMember {
  /** raw web URL as stored on the foreign record */
  url: string;
  /** normalizeArticleUrl(url) — the cross-app join key into saved_articles */
  urlNormalized: string;
  /** the resolved item record (card / bookmark / note) — read or item-delete target */
  itemUri: string;
  /** the membership record (collectionLink / collectionItem) — deleted on unsave */
  linkUri: string;
  /** the item record's $type (heterogeneous collections resolve a mix) */
  itemType: string;
  /** canonical at:// peer identifier stashed in the item, when present (Semble only) */
  canonicalAtUri?: string;
  /** title/author/etc carried ON the foreign record (Semble card metadata; a margin
   *  note's target.title). Lets imported saves show a real title before the body is
   *  extracted. Community bookmarks carry none, so those rely on extraction. */
  title?: string;
  author?: string;
  description?: string;
  image?: string;
}

/** A member that resolved but carried no usable article URL (skipped, not an error). */
export interface SkippedMember {
  reason: string;
  itemUri?: string;
  linkUri: string;
}

/**
 * The outcome of one snapshot poll. `complete` is the load-bearing flag: a poll
 * that errored, was truncated by a safety cap, or failed to resolve the owner PDS
 * is NOT complete, and Phase 2 invariant 1 forbids replacing the membership table
 * on an incomplete snapshot (it would be "the collection is empty", not "no info").
 */
export interface SnapshotResult {
  complete: boolean;
  members: BackedMember[];
  skipped: SkippedMember[];
  /** count of each resolved item $type, for diagnostics */
  typeMix: Record<string, number>;
}

const MAX_PAGES = 50;
// Bounded concurrency for resolving membership -> item records. The snapshot runs on
// the awaited GET path, so a large collection's per-item getRecords must not be a
// serial round-trip chain. Kept small so we don't fan out hundreds of subrequests at
// once (Workers caps them); the per-snapshot caches dedup repeats and cross-repo PDS.
const RESOLVE_CONCURRENCY = 8;

export interface RawRecord<T = Record<string, unknown>> {
  uri: string;
  cid: string;
  value: T;
}

/**
 * Public, auth-free paginated listRecords over a repo+collection. Returns
 * `truncated: true` when it stopped on the page cap with a cursor still pending
 * (an INCOMPLETE snapshot). Mirrors pds-client.ts listAllRecords but needs no session.
 *
 * Exported because the Margin highlight import reads the user's own
 * `at.margin.note` collection the same auth-free way (see routes/integrations.ts).
 */
export async function listAllRecordsPublic<T = Record<string, unknown>>(
  pds: string,
  repo: string,
  collection: string
): Promise<{ records: RawRecord<T>[]; truncated: boolean }> {
  const all: RawRecord<T>[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const u = new URL(`${pds}/xrpc/com.atproto.repo.listRecords`);
    u.searchParams.set('repo', repo);
    u.searchParams.set('collection', collection);
    u.searchParams.set('limit', '100');
    if (cursor) u.searchParams.set('cursor', cursor);
    const res = await fetch(u.toString());
    if (!res.ok) {
      throw new Error(`listRecords ${collection} -> ${res.status}`);
    }
    const data = (await res.json()) as { records?: RawRecord<T>[]; cursor?: string };
    for (const r of data.records ?? []) all.push(r);
    cursor = data.cursor;
    pages++;
    if (!cursor || (data.records ?? []).length === 0) break;
    if (pages >= MAX_PAGES) break;
  }
  const truncated = cursor !== undefined && pages >= MAX_PAGES;
  return { records: all, truncated };
}

// getRecord resolutions are cached per snapshot so a repeated item isn't fetched
// twice, and so a cross-repo item only resolves its foreign PDS once.
type ItemValue = Record<string, unknown> & { $type?: string };

async function getRecordPublic(
  pds: string,
  repo: string,
  collection: string,
  rkey: string
): Promise<ItemValue | null> {
  const u = new URL(`${pds}/xrpc/com.atproto.repo.getRecord`);
  u.searchParams.set('repo', repo);
  u.searchParams.set('collection', collection);
  u.searchParams.set('rkey', rkey);
  const res = await fetch(u.toString());
  if (!res.ok) {
    // Distinguish "genuinely gone" from "transient failure". A deleted/missing record
    // is reported as 404 or 400 RecordNotFound — resolve it to null so it legitimately
    // drops from the snapshot. ANY other status (5xx, 429, auth, a flaky cross-repo
    // PDS) is transient: THROW so snapshotBackedCollection marks the snapshot
    // incomplete and the membership table is NOT replaced (read.ts completeness
    // invariant). Returning null here would silently drop a live member on a hiccup.
    if (res.status === 404) return null;
    if (res.status === 400) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (body?.error === 'RecordNotFound') return null;
    }
    throw new Error(`getRecord ${repo}/${collection}/${rkey} -> ${res.status}`);
  }
  const data = (await res.json()) as { value?: ItemValue };
  return data.value ?? null;
}

/**
 * Pull an article URL from whatever item shape a membership points at. Returns null
 * for members that aren't article saves (a free-text Semble NOTE card, a Margin note
 * whose motivation isn't bookmarking, a record with no URL field) — skip those.
 */
export function extractUrlFromRecord(value: ItemValue | null): string | null {
  if (!value || typeof value !== 'object') return null;
  const type = value.$type;
  const content = value.content as { url?: string; metadata?: unknown } | undefined;
  const target = value.target as { source?: string } | undefined;

  if (type === 'community.lexicon.bookmarks.bookmark') {
    return typeof value.subject === 'string' ? value.subject : null;
  }
  if (type === 'network.cosmik.card') {
    if (value.type === 'NOTE') return null; // free-text card, no URL
    return content?.url ?? (typeof value.url === 'string' ? value.url : null);
  }
  if (type === 'at.margin.note') {
    if (value.motivation && value.motivation !== 'bookmarking') return null; // highlight/comment
    return target?.source ?? null;
  }
  // Generic fallback for an unknown item type — try the usual URL-bearing fields.
  return (
    (typeof value.subject === 'string' ? value.subject : undefined) ??
    (typeof value.url === 'string' ? value.url : undefined) ??
    content?.url ??
    target?.source ??
    null
  );
}

/**
 * Pull display metadata (title/author/description/image) carried on the foreign
 * record, so an imported save can show a real title before its body is extracted.
 * Semble cards keep these in content.metadata; a margin note may have target.title;
 * community bookmarks carry none (they rely on extraction).
 */
function extractRecordMetadata(value: ItemValue | null): {
  title?: string;
  author?: string;
  description?: string;
  image?: string;
} {
  if (!value || typeof value !== 'object') return {};
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

  if (value.$type === 'network.cosmik.card') {
    const meta = (value.content as { metadata?: Record<string, unknown> } | undefined)?.metadata;
    if (meta && typeof meta === 'object') {
      return {
        title: str(meta.title),
        author: str(meta.author),
        description: str(meta.description),
        image: str(meta.imageUrl) ?? str(meta.image),
      };
    }
    return {};
  }
  if (value.$type === 'at.margin.note') {
    const target = value.target as { title?: unknown } | undefined;
    return { title: str(target?.title) };
  }
  return {};
}

/** Find an at:// peer identifier stashed in a Semble card's content.metadata bag. */
function extractCanonicalAtUri(value: ItemValue | null): string | undefined {
  const metadata = (value?.content as { metadata?: unknown } | undefined)?.metadata;
  if (!metadata || typeof metadata !== 'object') return undefined;
  for (const v of Object.values(metadata as Record<string, unknown>)) {
    if (typeof v === 'string' && v.startsWith('at://')) return v;
  }
  return undefined;
}

/**
 * Resolve a list of (itemUri, linkUri) pairs into BackedMembers, fetching each item
 * by the DID in its OWN at-uri (cross-repo safe) with per-snapshot caches for PDS
 * resolution and getRecord. Shared by both providers; the only per-provider logic is
 * how the membership record names its item + collection (handled by the callers).
 */
async function resolveMembers(
  pairs: Array<{ itemUri: string; linkUri: string }>
): Promise<{ members: BackedMember[]; skipped: SkippedMember[]; typeMix: Record<string, number> }> {
  // Caches hold the in-flight PROMISE (not the resolved value) so concurrent workers
  // resolving the same DID/item share one fetch instead of racing into duplicates.
  const pdsCache = new Map<string, Promise<string | null>>();
  const itemCache = new Map<string, Promise<ItemValue | null>>();
  const members: BackedMember[] = [];
  const skipped: SkippedMember[] = [];
  const typeMix: Record<string, number> = {};

  const pdsFor = (did: string): Promise<string | null> => {
    let p = pdsCache.get(did);
    if (!p) {
      p = resolvePdsUrl(did);
      pdsCache.set(did, p);
    }
    return p;
  };

  const resolveItem = (itemUri: string): Promise<ItemValue | null> => {
    let p = itemCache.get(itemUri);
    if (!p) {
      p = (async () => {
        const ref = parseAtUri(itemUri);
        if (!ref) return null;
        const pds = await pdsFor(ref.did);
        if (!pds) return null;
        return getRecordPublic(pds, ref.did, ref.collection, ref.rkey);
      })();
      itemCache.set(itemUri, p);
    }
    return p;
  };

  const handle = async ({ itemUri, linkUri }: { itemUri: string; linkUri: string }) => {
    const item = await resolveItem(itemUri);
    if (!item) {
      skipped.push({ reason: 'item-not-resolvable', itemUri, linkUri });
      return;
    }
    const itemType = item.$type ?? 'unknown';
    typeMix[itemType] = (typeMix[itemType] ?? 0) + 1;
    const rawUrl = extractUrlFromRecord(item);
    if (!rawUrl) {
      skipped.push({ reason: `no-url (${itemType})`, itemUri, linkUri });
      return;
    }
    const urlNormalized = normalizeArticleUrl(rawUrl);
    if (!urlNormalized) {
      skipped.push({ reason: 'unnormalizable-url', itemUri, linkUri });
      return;
    }
    members.push({
      url: rawUrl,
      urlNormalized,
      itemUri,
      linkUri,
      itemType,
      canonicalAtUri: extractCanonicalAtUri(item),
      ...extractRecordMetadata(item),
    });
  };

  // Bounded-concurrency worker pool over the membership pairs (see RESOLVE_CONCURRENCY).
  const queue = [...pairs];
  const worker = async () => {
    for (;;) {
      const pair = queue.shift();
      if (!pair) return;
      await handle(pair);
    }
  };
  await Promise.all(Array.from({ length: Math.min(RESOLVE_CONCURRENCY, queue.length) }, worker));

  return { members, skipped, typeMix };
}

/**
 * Snapshot a backed collection into the set of article saves it currently contains.
 * `ownerDid` owns the collection (and its membership records); item records may live
 * elsewhere. A thrown listRecords error or a truncated membership listing yields
 * `complete: false` so the caller refuses to replace the membership table.
 */
export async function snapshotBackedCollection(
  provider: BackingProviderName,
  ownerDid: string,
  collectionUri: string
): Promise<SnapshotResult> {
  const pds = await resolvePdsUrl(ownerDid);
  if (!pds) {
    return { complete: false, members: [], skipped: [], typeMix: {} };
  }

  try {
    let pairs: Array<{ itemUri: string; linkUri: string }>;
    let truncated: boolean;

    if (provider === 'semble') {
      // network.cosmik.collectionLink: nested strong refs { card:{uri}, collection:{uri} }
      const links = await listAllRecordsPublic<{
        card?: { uri?: string };
        collection?: { uri?: string };
      }>(pds, ownerDid, 'network.cosmik.collectionLink');
      truncated = links.truncated;
      pairs = links.records
        .filter((l) => l.value.collection?.uri === collectionUri && l.value.card?.uri)
        .map((l) => ({ itemUri: l.value.card!.uri!, linkUri: l.uri }));
    } else {
      // at.margin.collectionItem: FLAT at-uri strings { annotation, collection }
      const items = await listAllRecordsPublic<{
        annotation?: string;
        collection?: string;
      }>(pds, ownerDid, 'at.margin.collectionItem');
      truncated = items.truncated;
      pairs = items.records
        .filter((it) => it.value.collection === collectionUri && it.value.annotation)
        .map((it) => ({ itemUri: it.value.annotation!, linkUri: it.uri }));
    }

    const { members, skipped, typeMix } = await resolveMembers(pairs);
    return { complete: !truncated, members, skipped, typeMix };
  } catch (err) {
    console.error('[backing] snapshot failed:', err);
    return { complete: false, members: [], skipped: [], typeMix: {} };
  }
}
