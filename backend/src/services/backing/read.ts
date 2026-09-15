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
  /** When this article joined the collection, off the MEMBERSHIP record — not the
   *  item's own createdAt, which is when the card was made (the same article can be
   *  filed into a collection long after it was first saved). ISO string; absent when
   *  the record carries no timestamp. */
  addedAt?: string;
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

/**
 * How many outbound fetches one snapshot may spend.
 *
 * A Worker invocation is capped at 1000 subrequests, and D1 statements share that
 * ceiling — but the cost of a snapshot is set by the collection, not by us. With
 * `includeForeign` a room pays roughly two fetches per contributed article (verify
 * the membership record, then resolve the item it points at) on top of Constellation
 * paging, so a few hundred cross-repo contributions is enough to cross the cap. What
 * makes that worth guarding is the failure mode: crossing it THROWS, so the room
 * fails to load entirely rather than coming back short. `complete: false` already
 * means "this list may be short", which is the honest answer here, so spend up to
 * the budget, stop, and say so.
 *
 * 400 leaves the rest of the invocation (the caller's own record reads, the D1 count
 * query) a wide margin, and still resolves a room of ~200 articles in full.
 */
export const SNAPSHOT_SUBREQUESTS = 400;

/**
 * The share of the budget the foreign-membership phase may spend verifying refs.
 *
 * Verification costs one getRecord per Constellation ref, so on a busy room it could
 * eat the whole budget and leave nothing to resolve the articles those refs point at.
 * A room that renders the owner's half is a better answer than one that renders
 * nothing, so the phase that runs first is the one that gets capped.
 */
const FOREIGN_VERIFY_SHARE = 0.5;

/**
 * A snapshot's allowance of outbound fetches, claimed one at a time.
 *
 * `exceeded` is the load-bearing readout, and it is deliberately not "the budget is
 * spent": it only goes true once a claim has actually been REFUSED, so a snapshot
 * that finished on its last permitted fetch still reports itself complete.
 */
class SubrequestBudget {
  private used = 0;
  private denied = 0;

  constructor(
    readonly limit: number,
    private readonly parent?: SubrequestBudget
  ) {}

  /** Claim one fetch. False means the caller must stop and report incompleteness. */
  claim(): boolean {
    if (this.used >= this.limit) {
      this.denied += 1;
      return false;
    }
    // A portion spends its parent's allowance too, so the phase caps compose
    // instead of each phase getting its own fresh 400.
    if (this.parent && !this.parent.claim()) {
      this.denied += 1;
      return false;
    }
    this.used += 1;
    return true;
  }

  /**
   * A sub-allowance drawing on this budget, capped at `share` of its limit.
   *
   * Bounding a phase by how many ITEMS it may touch doesn't bound what it costs:
   * verifying one foreign ref is a getRecord plus, for a contributor we haven't
   * seen, a DID resolution. Capping the spend is the only cap that holds.
   */
  portion(share: number): SubrequestBudget {
    return new SubrequestBudget(Math.max(1, Math.floor(this.limit * share)), this);
  }

  /** True once work was actually turned away — the snapshot is short. */
  get exceeded(): boolean {
    return this.denied > 0;
  }

  get spent(): number {
    return this.used;
  }

  get refused(): number {
    return this.denied;
  }
}

/**
 * DID -> PDS for one snapshot: cached, and charged to the budget once per DID.
 *
 * Shared across BOTH phases (foreign verification and item resolution), which the
 * two private caches it replaces were not — a DID that contributed a link and owned
 * the item it pointed at used to be resolved twice, for two subrequests and one
 * answer. A cache hit costs nothing, since the fetch was already paid for.
 *
 * Out of budget resolves to null, which every call site already treats as "couldn't
 * reach this repo" and folds into `complete: false`.
 */
type PdsResolver = (did: string, budget: SubrequestBudget) => Promise<string | null>;

function pdsResolver(): PdsResolver {
  const cache = new Map<string, Promise<string | null>>();
  return (did, budget) => {
    let pending = cache.get(did);
    if (!pending) {
      pending = budget.claim() ? resolvePdsUrl(did) : Promise.resolve(null);
      cache.set(did, pending);
    }
    return pending;
  };
}

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
  collection: string,
  budget?: SubrequestBudget
): Promise<{ records: RawRecord<T>[]; truncated: boolean }> {
  const all: RawRecord<T>[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    // Running out of budget mid-listing IS truncation — the same state the page cap
    // below reports, reached for a different reason. Callers with no budget (the
    // Margin highlight import) page to MAX_PAGES as before.
    if (budget && !budget.claim()) return { records: all, truncated: true };
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

export async function getRecordPublic(
  pds: string,
  repo: string,
  collection: string,
  rkey: string
): Promise<ItemValue | null> {
  return (await getRecordPublicWithCid(pds, repo, collection, rkey))?.value ?? null;
}

/**
 * getRecordPublic, keeping the record's cid. Needed wherever a strongRef is written
 * at a record in a repo we can't read with the session (a Semble collectionLink
 * pointing at someone else's open collection).
 */
export async function getRecordPublicWithCid(
  pds: string,
  repo: string,
  collection: string,
  rkey: string
): Promise<{ value: ItemValue; cid: string } | null> {
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
  const data = (await res.json()) as { value?: ItemValue; cid?: string };
  if (!data.value) return null;
  return { value: data.value, cid: data.cid ?? '' };
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
  // Margin's own bookmark record (still defined in paddinglabs/margin, and what
  // Skyreader's Margin export wrote before it moved to notes): the URL sits at
  // the top level as `source`, not under target.
  if (type === 'at.margin.bookmark') {
    return typeof value.source === 'string' ? value.source : null;
  }
  // Generic fallback for an unknown item type — try the usual URL-bearing fields.
  return (
    (typeof value.subject === 'string' ? value.subject : undefined) ??
    (typeof value.url === 'string' ? value.url : undefined) ??
    (typeof value.source === 'string' ? value.source : undefined) ??
    content?.url ??
    target?.source ??
    null
  );
}

/**
 * Pull display metadata (title/author/description/image) carried on the foreign
 * record, so an imported save can show a real title before its body is extracted.
 * Semble cards keep these in content.metadata; a margin note may have target.title and a
 * margin bookmark carries title/description at the top level; community bookmarks carry
 * none (they rely on extraction).
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
  if (value.$type === 'at.margin.bookmark') {
    return { title: str(value.title), description: str(value.description) };
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
  pairs: MembershipPair[],
  budget: SubrequestBudget,
  pdsFor: PdsResolver
): Promise<{ members: BackedMember[]; skipped: SkippedMember[]; typeMix: Record<string, number> }> {
  // The cache holds the in-flight PROMISE (not the resolved value) so concurrent
  // workers resolving the same item share one fetch instead of racing into
  // duplicates. PDS resolution is cached the same way one level up, across phases.
  const itemCache = new Map<string, Promise<ItemValue | null>>();
  const members: BackedMember[] = [];
  const skipped: SkippedMember[] = [];
  const typeMix: Record<string, number> = {};

  const resolveItem = (itemUri: string): Promise<ItemValue | null> => {
    let p = itemCache.get(itemUri);
    if (!p) {
      p = (async () => {
        const ref = parseAtUri(itemUri);
        if (!ref) return null;
        const pds = await pdsFor(ref.did, budget);
        if (!pds) return null;
        // Out of budget: the item is skipped like any other unresolvable one, and
        // snapshotBackedCollection reads `budget.exceeded` to mark the snapshot
        // short. This is the one place a skip is NOT the collection's own fault.
        if (!budget.claim()) return null;
        return getRecordPublic(pds, ref.did, ref.collection, ref.rkey);
      })();
      itemCache.set(itemUri, p);
    }
    return p;
  };

  const handle = async ({ itemUri, linkUri, addedAt }: MembershipPair) => {
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
      addedAt,
      canonicalAtUri: extractCanonicalAtUri(item),
      ...extractRecordMetadata(item),
    });
  };

  await mapPool(pairs, RESOLVE_CONCURRENCY, handle);

  return { members, skipped, typeMix };
}

/** Bounded-concurrency worker pool (see RESOLVE_CONCURRENCY). */
async function mapPool<T>(items: T[], limit: number, run: (item: T) => Promise<void>) {
  const queue = [...items];
  const worker = async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
}

/**
 * How each provider's membership record names the collection it belongs to and the
 * item it carries. `backlinkPath` is the same reference expressed as a Constellation
 * JSON path, which is how membership written by a repo OTHER than the owner's is
 * discovered (see `listForeignMembership`).
 */
interface MembershipShape {
  collection: string;
  backlinkPath: string;
  collectionUriOf(value: Record<string, unknown>): string | undefined;
  itemUriOf(value: Record<string, unknown>): string | undefined;
  /** when the article joined the collection (see BackedMember.addedAt) */
  addedAtOf(value: Record<string, unknown>): string | undefined;
}

/** One membership record, reduced to what a snapshot needs from it. */
interface MembershipPair {
  itemUri: string;
  linkUri: string;
  addedAt?: string;
}

const isoStr = (v: unknown): string | undefined =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : undefined;

const MEMBERSHIP: Record<BackingProviderName, MembershipShape> = {
  // network.cosmik.collectionLink: nested strong refs { card:{uri}, collection:{uri} }
  semble: {
    collection: 'network.cosmik.collectionLink',
    backlinkPath: '.collection.uri',
    collectionUriOf: (v) => (v.collection as { uri?: string } | undefined)?.uri,
    itemUriOf: (v) => (v.card as { uri?: string } | undefined)?.uri,
    // Semble writes both, identically; addedAt is the one that names the act.
    addedAtOf: (v) => isoStr(v.addedAt) ?? isoStr(v.createdAt),
  },
  // at.margin.collectionItem: FLAT at-uri strings { annotation, collection }
  margin: {
    collection: 'at.margin.collectionItem',
    backlinkPath: '.collection',
    collectionUriOf: (v) => (typeof v.collection === 'string' ? v.collection : undefined),
    itemUriOf: (v) => (typeof v.annotation === 'string' ? v.annotation : undefined),
    addedAtOf: (v) => isoStr(v.createdAt),
  },
};

const CONSTELLATION_BASE = 'https://constellation.microcosm.blue';
const FOREIGN_PAGES = 5;
const FOREIGN_PAGE_LIMIT = 100;

/**
 * Membership records held in OTHER repos than the collection owner's — what an open
 * collection accumulates when someone else adds to it, since a contributor can only
 * ever write into their own repo.
 *
 * Constellation is the only way to find these (there is no repo to list), so this is
 * opt-in per snapshot: for a backed SAVES collection the owner's repo is the whole
 * truth and a stranger's link must not inject rows into the user's Saved list. Rooms
 * ask for it, because there the point is that the list is co-curated.
 *
 * Constellation is an index, not the authority: every record it names is fetched and
 * re-checked against the collection uri before it counts. Bounded by pages AND by a
 * portion of the snapshot's fetch budget, with `complete: false` on any failure or
 * either bound, so the caller can say the list may be short rather than silently
 * dropping other people's contributions.
 */
async function listForeignMembership(
  shape: MembershipShape,
  collectionUri: string,
  ownerDid: string,
  budget: SubrequestBudget,
  pdsFor: PdsResolver
): Promise<{ pairs: MembershipPair[]; complete: boolean }> {
  // Everything this phase spends comes out of a portion of the snapshot's budget,
  // so a flood of contributions can't leave nothing to resolve the articles those
  // contributions point at (see FOREIGN_VERIFY_SHARE).
  const phase = budget.portion(FOREIGN_VERIFY_SHARE);
  const refs: Array<{ did: string; rkey: string }> = [];
  let cursor: string | undefined;
  let complete = true;

  for (let page = 0; page < FOREIGN_PAGES; page++) {
    if (!phase.claim()) {
      complete = false;
      break;
    }
    const u = new URL(`${CONSTELLATION_BASE}/links`);
    u.searchParams.set('target', collectionUri);
    u.searchParams.set('collection', shape.collection);
    u.searchParams.set('path', shape.backlinkPath);
    u.searchParams.set('limit', String(FOREIGN_PAGE_LIMIT));
    if (cursor) u.searchParams.set('cursor', cursor);
    let data: { linking_records?: Array<{ did?: string; rkey?: string }>; cursor?: string } | null;
    try {
      const res = await fetch(u.toString());
      if (!res.ok) throw new Error(`constellation /links -> ${res.status}`);
      data = (await res.json()) as typeof data;
    } catch (err) {
      console.error('[backing] foreign membership lookup failed:', err);
      return { pairs: [], complete: false };
    }
    const records = data?.linking_records ?? [];
    for (const r of records) {
      // The owner's own links come from listRecords, which is authoritative and
      // needs no per-record fetch.
      if (r.did && r.rkey && r.did !== ownerDid) refs.push({ did: r.did, rkey: r.rkey });
    }
    cursor = data?.cursor ?? undefined;
    if (!cursor || records.length === 0) break;
    if (page === FOREIGN_PAGES - 1) complete = false;
  }

  if (refs.length === 0) return { pairs: [], complete };

  const pairs: MembershipPair[] = [];
  await mapPool(refs, RESOLVE_CONCURRENCY, async (ref) => {
    try {
      const pds = await pdsFor(ref.did, phase);
      if (!pds) {
        complete = false;
        return;
      }
      if (!phase.claim()) {
        complete = false;
        return;
      }
      const value = await getRecordPublic(pds, ref.did, shape.collection, ref.rkey);
      if (!value) return; // deleted since Constellation indexed it
      if (shape.collectionUriOf(value) !== collectionUri) return; // stale index entry
      const itemUri = shape.itemUriOf(value);
      if (itemUri)
        pairs.push({
          itemUri,
          linkUri: `at://${ref.did}/${shape.collection}/${ref.rkey}`,
          addedAt: shape.addedAtOf(value),
        });
    } catch (err) {
      // Transient — same stance as the owner-side snapshot: report incompleteness
      // rather than presenting a short list as the whole collection.
      console.error('[backing] foreign membership record failed:', err);
      complete = false;
    }
  });

  return { pairs, complete };
}

/**
 * Oldest addition first — the order a collection was actually built in, which is
 * the only order both repos agree on: owner membership arrives in listRecords
 * order, foreign membership arrives from Constellation, and `resolveMembers`
 * finishes them out of order anyway (bounded concurrency). A member whose record
 * carries no timestamp sorts last rather than pretending to be the oldest, and
 * `linkUri` breaks ties so the same collection always resolves to the same order.
 */
function sortByAddedAt(members: BackedMember[]): BackedMember[] {
  const at = (m: BackedMember) => (m.addedAt ? Date.parse(m.addedAt) : Number.POSITIVE_INFINITY);
  return members.sort((a, b) => at(a) - at(b) || a.linkUri.localeCompare(b.linkUri));
}

export interface SnapshotOptions {
  /** Also count membership written by repos other than the owner's (see
   *  `listForeignMembership`). Off by default: backed saves are owner-only. */
  includeForeign?: boolean;
  /** Override the per-snapshot fetch budget (see SNAPSHOT_SUBREQUESTS). Callers
   *  normally leave this alone; tests set it small to exercise the short path. */
  maxSubrequests?: number;
}

/**
 * Snapshot a backed collection into the set of article saves it currently contains.
 * `ownerDid` owns the collection (and, by default, its membership records); item
 * records may live elsewhere. A thrown listRecords error, a truncated membership
 * listing, or a collection too large to resolve inside one snapshot's fetch budget
 * yields `complete: false` so the caller refuses to replace the membership table.
 */
export async function snapshotBackedCollection(
  provider: BackingProviderName,
  ownerDid: string,
  collectionUri: string,
  options: SnapshotOptions = {}
): Promise<SnapshotResult> {
  // One budget and one DID cache for the whole snapshot, so every phase draws on
  // the same allowance and no DID is resolved twice across them.
  const budget = new SubrequestBudget(options.maxSubrequests ?? SNAPSHOT_SUBREQUESTS);
  const pdsFor = pdsResolver();

  const pds = await pdsFor(ownerDid, budget);
  if (!pds) {
    return { complete: false, members: [], skipped: [], typeMix: {} };
  }
  const shape = MEMBERSHIP[provider];

  try {
    const owned = await listAllRecordsPublic<Record<string, unknown>>(
      pds,
      ownerDid,
      shape.collection,
      budget
    );
    const pairs: MembershipPair[] = owned.records.flatMap((l) => {
      if (shape.collectionUriOf(l.value) !== collectionUri) return [];
      const itemUri = shape.itemUriOf(l.value);
      return itemUri ? [{ itemUri, linkUri: l.uri, addedAt: shape.addedAtOf(l.value) }] : [];
    });
    let complete = !owned.truncated;

    if (options.includeForeign) {
      const foreign = await listForeignMembership(shape, collectionUri, ownerDid, budget, pdsFor);
      const seen = new Set(pairs.map((p) => p.linkUri));
      for (const pair of foreign.pairs) {
        if (!seen.has(pair.linkUri)) pairs.push(pair);
      }
      if (!foreign.complete) complete = false;
    }

    const { members, skipped, typeMix } = await resolveMembers(pairs, budget, pdsFor);

    // The catch-all for every phase: item resolution reports a budget refusal as a
    // skipped member, not as incompleteness, so the budget itself is what says the
    // list may be short.
    if (budget.exceeded) {
      complete = false;
      console.warn('[backing] snapshot hit its subrequest budget', {
        collectionUri,
        limit: budget.limit,
        spent: budget.spent,
        refused: budget.refused,
        resolved: members.length,
      });
    }

    return { complete, members: sortByAddedAt(members), skipped, typeMix };
  } catch (err) {
    console.error('[backing] snapshot failed:', err);
    return { complete: false, members: [], skipped: [], typeMix: {} };
  }
}
