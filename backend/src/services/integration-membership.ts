/**
 * Semble / Margin saves — reading and editing collection membership for one URL.
 *
 * The "Save to Semble/Margin" picker used to be write-only: every open created a
 * fresh card/note, so re-saving an article duplicated it and there was no way to
 * see (let alone change) which collections it already lived in. This module is the
 * read-back half plus the membership diff.
 *
 * The PDS is the source of truth, queried per-URL when the picker opens — saves
 * can be created or reorganised in Semble/Margin themselves, so a local cache of
 * "what Skyreader wrote" would lie. Lookup = list the user's item records, match on
 * normalizeArticleUrl, then list membership records pointing at those items. That
 * mirrors `backing/read.ts`'s snapshot, scoped to one URL and to the user's own repo.
 *
 * The repo listings are page-capped, and a long-time Semble/Margin user has more
 * cards than the cap — so on its own the scan would tell them "couldn't check all
 * older saves" on nearly every open. When a listing stops on the cap, the rest is
 * answered by a backlink index (Constellation) queried by URL and by item, filtered
 * to the user's DID. The two halves cover each other's blind spots: the scan reads
 * newest-first, so it holds exactly the recent records the index may not have
 * caught up on yet, and the index reaches the old tail the scan never gets to.
 * The index is only ever a pointer: every record it names is re-read from the
 * user's own PDS and re-checked before it counts.
 *
 * Record shapes (identical to the ones routes/integrations.ts and backing/write.ts
 * write):
 *  - Semble: network.cosmik.card + network.cosmik.collectionLink (nested strongRefs
 *    {uri, cid} to both the card and the collection — sequential writes, the card's
 *    cid isn't known until it's written).
 *  - Margin: at.margin.note (motivation 'bookmarking') + at.margin.collectionItem
 *    (flat at-uri strings, no cids — so a batch applyWrites is safe).
 *
 * Editing membership NEVER deletes the item record: the card/note is a shared
 * object that may carry annotations made elsewhere, same philosophy as
 * `removeMember` in the backing write path. Unchecking every collection leaves the
 * item behind with zero links.
 */

import { generateTid } from '../utils/tid';
import { parseAtUri } from '../utils/canonical-url';
import { normalizeArticleUrl } from '../utils/url-normalize';
import { extractUrlFromRecord } from './backing/read';
import type { PDSClient } from './pds-client';

export type IntegrationProvider = 'semble' | 'margin';

const SEMBLE_CARD = 'network.cosmik.card';
const SEMBLE_LINK = 'network.cosmik.collectionLink';
const MARGIN_NOTE = 'at.margin.note';
const MARGIN_ITEM = 'at.margin.collectionItem';

/** The membership NSID whose records this module is allowed to delete. */
export function membershipCollection(provider: IntegrationProvider): string {
  return provider === 'semble' ? SEMBLE_LINK : MARGIN_ITEM;
}

export function itemCollection(provider: IntegrationProvider): string {
  return provider === 'semble' ? SEMBLE_CARD : MARGIN_NOTE;
}

/** One card/note in the user's repo whose URL matches the one being looked up. */
export interface MembershipItem {
  uri: string;
  cid: string;
  rkey: string;
  createdAt?: string;
}

/** One membership record: an item of ours sitting in a collection. */
export interface Membership {
  collectionUri: string;
  linkUri: string;
  itemUri: string;
}

export interface MembershipLookup {
  items: MembershipItem[];
  memberships: Membership[];
  /** true if a listing stopped on the page cap — older saves may be missing. */
  truncated: boolean;
}

// One page cap for both listings. 5 pages x 100 records is the same bound the
// collection listings already use; `truncated` tells the client when it bit.
const MAX_PAGES = 5;

/**
 * "Which records in `did`'s repo point at `subject` through `source`?" — the one
 * question the capped scans can't afford to answer by listing. `source` is
 * Constellation's `collection:path` form. `complete` is false when the answer may
 * be short (the index failed, timed out, or had more pages than we walk).
 */
export interface BacklinkIndex {
  backlinks(
    subject: string,
    source: string,
    did: string
  ): Promise<{ rkeys: string[]; complete: boolean }>;
}

const CONSTELLATION_BACKLINKS =
  'https://constellation.microcosm.blue/xrpc/blue.microcosm.links.getBacklinks';
/** A URL one person saved more than 300 times is not a case worth paging for. */
const INDEX_PAGES = 3;
const INDEX_TIMEOUT_MS = 4000;

export const constellationIndex: BacklinkIndex = {
  async backlinks(subject, source, did) {
    const collection = source.split(':')[0];
    const rkeys: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < INDEX_PAGES; page++) {
      const u = new URL(CONSTELLATION_BACKLINKS);
      u.searchParams.set('subject', subject);
      u.searchParams.set('source', source);
      u.searchParams.set('did', did);
      u.searchParams.set('limit', '100');
      if (cursor) u.searchParams.set('cursor', cursor);
      let data: {
        records?: Array<{ did?: string; collection?: string; rkey?: string }>;
        cursor?: string | null;
      };
      try {
        const res = await fetch(u.toString(), { signal: AbortSignal.timeout(INDEX_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`constellation getBacklinks -> ${res.status}`);
        data = (await res.json()) as typeof data;
      } catch (err) {
        console.error('[memberships] backlink index lookup failed:', err);
        return { rkeys, complete: false };
      }
      for (const r of data.records ?? []) {
        // The did filter is the index's; re-check it anyway — a record from another
        // repo must never be read back as one of ours.
        if (r.did === did && r.collection === collection && r.rkey) rkeys.push(r.rkey);
      }
      cursor = data.cursor ?? undefined;
      if (!cursor || (data.records ?? []).length === 0) return { rkeys, complete: true };
    }
    return { rkeys, complete: false };
  },
};

/** Where each provider's item records keep the URL, as index sources. */
function itemSources(provider: IntegrationProvider): string[] {
  return provider === 'semble'
    ? [`${SEMBLE_CARD}:content.url`, `${SEMBLE_CARD}:url`]
    : [`${MARGIN_NOTE}:target.source`];
}

/** Where each provider's membership records point at their item. */
function membershipSource(provider: IntegrationProvider): string {
  return provider === 'semble' ? `${SEMBLE_LINK}:card.uri` : `${MARGIN_ITEM}:annotation`;
}

/**
 * The index matches the exact string a record holds, not our normalized form, so
 * ask for the spellings a save of this URL most plausibly carries: as given, as
 * normalized, and the normalized form with its trailing slash back.
 */
function urlSpellings(url: string, normalized: string): string[] {
  const spellings = new Set([url.trim(), normalized]);
  const parsed = new URL(normalized);
  if (parsed.pathname.length > 1 && !parsed.search) spellings.add(`${normalized}/`);
  return [...spellings];
}

/** A delete that 404s is a success: the link is gone, which is what was asked. */
function isRecordNotFound(error: string): boolean {
  return /recordnotfound|could not locate record/i.test(error);
}

function rkeyOf(uri: string): string {
  return parseAtUri(uri)?.rkey ?? '';
}

/** Newest first: TID rkeys sort by creation time, createdAt is the better signal. */
function byNewest(a: MembershipItem, b: MembershipItem): number {
  const at = a.createdAt ?? '';
  const bt = b.createdAt ?? '';
  if (at !== bt) return at < bt ? 1 : -1;
  return a.rkey < b.rkey ? 1 : -1;
}

/**
 * Find every card/note in the user's repo for `url`, plus the collections they
 * currently belong to. Returns empty (not an error) when nothing matches.
 */
export async function findMemberships(
  pds: PDSClient,
  provider: IntegrationProvider,
  url: string,
  options: { did?: string; index?: BacklinkIndex } = {}
): Promise<{ success: true; data: MembershipLookup } | { success: false; error: string }> {
  const target = normalizeArticleUrl(url);
  if (!target) return { success: false, error: 'url is not a usable http(s) URL' };
  const { did } = options;
  const index = options.index ?? constellationIndex;

  const itemsRes = await pds.listAllRecords<{ motivation?: string; createdAt?: string }>(
    itemCollection(provider),
    { maxPages: MAX_PAGES }
  );
  if (!itemsRes.success) return { success: false, error: itemsRes.error };

  const items: MembershipItem[] = [];
  for (const rec of itemsRes.data) {
    const item = matchItem(provider, target, rec);
    if (item) items.push(item);
  }

  // The scan stopped on its cap: the rest of the repo is answered by the index.
  let itemsTruncated = itemsRes.truncated === true;
  if (itemsTruncated && did) {
    const found = await itemsFromIndex(pds, provider, did, url, target, items, index);
    items.push(...found.items);
    if (found.complete) itemsTruncated = false;
  }
  items.sort(byNewest);

  // No item for this URL means no membership can point at one — skip the second
  // listing entirely (the common "never saved" case costs one round trip).
  if (items.length === 0) {
    return { success: true, data: { items, memberships: [], truncated: itemsTruncated } };
  }

  const itemUris = new Set(items.map((i) => i.uri));
  const memberships: Membership[] = [];

  const links = await pds.listAllRecords<Record<string, unknown>>(membershipCollection(provider), {
    maxPages: MAX_PAGES,
  });
  if (!links.success) return { success: false, error: links.error };
  for (const link of links.data) {
    const m = matchMembership(provider, itemUris, link.uri, link.value);
    if (m) memberships.push(m);
  }

  let linksTruncated = links.truncated === true;
  if (linksTruncated && did) {
    const found = await membershipsFromIndex(pds, provider, did, items, memberships, index);
    memberships.push(...found.memberships);
    if (found.complete) linksTruncated = false;
  }

  return {
    success: true,
    data: { items, memberships, truncated: itemsTruncated || linksTruncated },
  };
}

type ListedRecord = { uri: string; cid: string; value: Record<string, unknown> };

/** An item record, if it is a save of `target` (the normalized URL). */
function matchItem(
  provider: IntegrationProvider,
  target: string,
  rec: { uri: string; cid: string; value: unknown }
): MembershipItem | null {
  const value = (rec.value ?? {}) as { motivation?: string; createdAt?: unknown };
  // Margin uses one lexicon for bookmarks AND highlights; only `motivation`
  // separates them, and a highlight on the same article must not read as a save.
  if (provider === 'margin' && value.motivation !== 'bookmarking') return null;
  // listRecords only returns this collection, so stamping $type is safe and lets
  // extractUrlFromRecord pick the right URL field for the shape.
  const recordUrl = extractUrlFromRecord({ ...value, $type: itemCollection(provider) });
  if (!recordUrl || normalizeArticleUrl(recordUrl) !== target) return null;
  return {
    uri: rec.uri,
    cid: rec.cid,
    rkey: rkeyOf(rec.uri),
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : undefined,
  };
}

/** A membership record, if it links one of `itemUris` into a collection. */
function matchMembership(
  provider: IntegrationProvider,
  itemUris: ReadonlySet<string>,
  linkUri: string,
  value: Record<string, unknown>
): Membership | null {
  let itemUri: string | undefined;
  let collectionUri: string | undefined;
  if (provider === 'semble') {
    itemUri = (value.card as { uri?: string } | undefined)?.uri;
    collectionUri = (value.collection as { uri?: string } | undefined)?.uri;
  } else {
    itemUri = typeof value.annotation === 'string' ? value.annotation : undefined;
    collectionUri = typeof value.collection === 'string' ? value.collection : undefined;
  }
  if (!itemUri || !collectionUri || !itemUris.has(itemUri)) return null;
  return { collectionUri, linkUri, itemUri };
}

/**
 * Read one record the index named back from the user's own repo. `null` = it's
 * gone (the index was stale, which is fine); `undefined` = couldn't tell.
 */
async function readBack(
  pds: PDSClient,
  collection: string,
  rkey: string
): Promise<ListedRecord | null | undefined> {
  const res = await pds.getRecord<Record<string, unknown>>(collection, rkey);
  if (res.success) return res.data;
  return isRecordNotFound(res.error) ? null : undefined;
}

async function itemsFromIndex(
  pds: PDSClient,
  provider: IntegrationProvider,
  did: string,
  url: string,
  target: string,
  known: MembershipItem[],
  index: BacklinkIndex
): Promise<{ items: MembershipItem[]; complete: boolean }> {
  const lookups = urlSpellings(url, target).flatMap((subject) =>
    itemSources(provider).map((source) => index.backlinks(subject, source, did))
  );
  const answers = await Promise.all(lookups);
  let complete = answers.every((a) => a.complete);

  const seen = new Set(known.map((i) => i.rkey));
  const rkeys = [...new Set(answers.flatMap((a) => a.rkeys))].filter((r) => !seen.has(r));
  const items: MembershipItem[] = [];
  await Promise.all(
    rkeys.map(async (rkey) => {
      const rec = await readBack(pds, itemCollection(provider), rkey);
      if (rec === undefined) complete = false;
      if (!rec) return;
      const item = matchItem(provider, target, rec);
      if (item) items.push(item);
    })
  );
  return { items, complete };
}

async function membershipsFromIndex(
  pds: PDSClient,
  provider: IntegrationProvider,
  did: string,
  items: MembershipItem[],
  known: Membership[],
  index: BacklinkIndex
): Promise<{ memberships: Membership[]; complete: boolean }> {
  const answers = await Promise.all(
    items.map((item) => index.backlinks(item.uri, membershipSource(provider), did))
  );
  let complete = answers.every((a) => a.complete);

  const seen = new Set(known.map((m) => rkeyOf(m.linkUri)));
  const rkeys = [...new Set(answers.flatMap((a) => a.rkeys))].filter((r) => !seen.has(r));
  const itemUris = new Set(items.map((i) => i.uri));
  const memberships: Membership[] = [];
  await Promise.all(
    rkeys.map(async (rkey) => {
      const rec = await readBack(pds, membershipCollection(provider), rkey);
      if (rec === undefined) complete = false;
      if (!rec) return;
      const m = matchMembership(provider, itemUris, rec.uri, rec.value);
      if (m) memberships.push(m);
    })
  );
  return { memberships, complete };
}

export interface MembershipEditInput {
  url: string;
  /** collections to add the save to; `cid` is a hint, Semble re-resolves it live */
  add: Array<{ uri: string; cid?: string }>;
  /** membership record uris to delete (validated against provider, owner, and URL) */
  remove: string[];
  /** used only when no item exists yet and we fall back to creating one */
  title?: string;
  description?: string;
  author?: string;
  publishedAt?: string;
}

export interface MembershipEditResult {
  /** the card/note the adds attached to (existing or newly created) */
  item?: { uri: string; cid: string; created: boolean };
  added: Array<{ collectionUri: string; linkUri?: string; error?: string }>;
  removed: Array<{ linkUri: string; error?: string }>;
}

export class MembershipEditError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/**
 * Validate a membership uri before it becomes a deleteRecord. This endpoint must
 * not turn into an arbitrary-record deleter: the uri has to parse, live in the
 * caller's own repo, and name exactly this provider's membership lexicon.
 */
function validateRemoval(provider: IntegrationProvider, did: string, linkUri: string): string {
  const ref = parseAtUri(linkUri);
  if (!ref) throw new MembershipEditError(`not an at-uri: ${linkUri}`, 400);
  if (ref.did !== did) throw new MembershipEditError('cannot remove another repo’s record', 403);
  if (ref.collection !== membershipCollection(provider)) {
    throw new MembershipEditError(`not a ${provider} membership record: ${linkUri}`, 400);
  }
  return ref.rkey;
}

/** Create the item record (card/note) for a URL that has none yet. */
async function createItem(
  pds: PDSClient,
  provider: IntegrationProvider,
  input: MembershipEditInput
): Promise<{ uri: string; cid: string }> {
  const rkey = generateTid();
  const nowIso = new Date().toISOString();

  let record: Record<string, unknown>;
  if (provider === 'semble') {
    const metadata: Record<string, string> = {};
    if (input.title) metadata.title = input.title;
    if (input.description) metadata.description = input.description;
    if (input.author) metadata.author = input.author;
    if (input.publishedAt) metadata.publishedDate = input.publishedAt;
    record = {
      $type: SEMBLE_CARD,
      type: 'URL',
      content: {
        url: input.url,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      },
      url: input.url,
      createdAt: nowIso,
    };
  } else {
    const description = input.description?.trim();
    record = {
      $type: MARGIN_NOTE,
      motivation: 'bookmarking',
      target: {
        source: input.url,
        ...(input.title ? { title: input.title } : {}),
      },
      ...(description ? { body: { value: description, format: 'text/plain' } } : {}),
      tags: [],
      generator: { name: 'Skyreader', homepage: 'https://skyreader.app' },
      createdAt: nowIso,
    };
  }

  const res = await pds.putRecord(itemCollection(provider), rkey, record);
  if (!res.success) throw new MembershipEditError(res.error, 502);
  return { uri: res.data.uri, cid: res.data.cid };
}

/**
 * Apply a membership diff for one URL: delete the named membership records, then
 * link the item into the added collections (creating the item first if the URL has
 * never been saved). Per-operation results are returned rather than collapsed —
 * these are N separate PDS writes and a partial failure is reported, not hidden.
 * Membership is re-read on the next open, so a partial apply self-heals.
 */
export async function editMemberships(
  pds: PDSClient,
  did: string,
  provider: IntegrationProvider,
  input: MembershipEditInput
): Promise<MembershipEditResult> {
  const removeRkeys = input.remove.map((uri) => ({
    uri,
    rkey: validateRemoval(provider, did, uri),
  }));

  // Authorize removals against the current server-side view for this URL. Repo +
  // NSID validation alone is insufficient: otherwise a caller could name a link
  // belonging to another article in their own repo. Do this once, before any
  // writes, and reuse the same snapshot for duplicate-add protection below.
  const lookup = await findMemberships(pds, provider, input.url, { did });
  if (!lookup.success) throw new MembershipEditError(lookup.error, 502);
  const allowedRemovals = new Set(lookup.data.memberships.map((m) => m.linkUri));
  const alreadyRemoved = new Set<string>();
  for (const { uri } of removeRkeys) {
    if (allowedRemovals.has(uri)) continue;

    // A membership can disappear after the picker opens. Preserve idempotency
    // without weakening URL authorization: only a confirmed 404 is accepted as
    // already removed; an existing record outside the URL-scoped lookup is still
    // forbidden, and an inconclusive read is an upstream failure.
    const ref = parseAtUri(uri)!;
    const current = await pds.getRecord(ref.collection, ref.rkey);
    if (!current.success && isRecordNotFound(current.error)) {
      alreadyRemoved.add(uri);
      continue;
    }
    if (!current.success) throw new MembershipEditError(current.error, 502);
    throw new MembershipEditError('membership does not belong to this URL', 403);
  }

  const removed: MembershipEditResult['removed'] = [];
  for (const { uri, rkey } of removeRkeys) {
    if (alreadyRemoved.has(uri)) {
      removed.push({ linkUri: uri });
      continue;
    }
    const res = await pds.deleteRecord(membershipCollection(provider), rkey);
    if (res.success || isRecordNotFound(res.error)) {
      removed.push({ linkUri: uri });
    } else {
      removed.push({ linkUri: uri, error: res.error });
    }
  }

  const added: MembershipEditResult['added'] = [];
  if (input.add.length === 0) {
    return { added, removed };
  }

  const existing = lookup.data.items[0];
  const item = existing
    ? { uri: existing.uri, cid: existing.cid, created: false }
    : { ...(await createItem(pds, provider, input)), created: true };

  // Don't create a second link for a collection the item is already in — a stale
  // picker (or a double-click) would otherwise duplicate the membership.
  const removedUris = new Set(removeRkeys.map((r) => r.uri));
  const alreadyIn = new Set(
    lookup.data.memberships
      .filter((m) => m.itemUri === item.uri && !removedUris.has(m.linkUri))
      .map((m) => m.collectionUri)
  );
  const toAdd = input.add.filter((c) => !alreadyIn.has(c.uri));

  if (provider === 'semble') {
    for (const col of toAdd) {
      // collectionLink.collection is a strongRef, so a stale cid from the client's
      // cached picker list would pin an old revision. Re-resolve it live and only
      // fall back to the client's hint if the collection can't be read.
      const cid = (await resolveCid(pds, col.uri)) ?? col.cid;
      if (!cid) {
        added.push({ collectionUri: col.uri, error: 'could not resolve collection cid' });
        continue;
      }
      const nowIso = new Date().toISOString();
      const res = await pds.putRecord(SEMBLE_LINK, generateTid(), {
        $type: SEMBLE_LINK,
        collection: { uri: col.uri, cid },
        card: { uri: item.uri, cid: item.cid },
        addedBy: did,
        addedAt: nowIso,
        createdAt: nowIso,
      });
      added.push(
        res.success
          ? { collectionUri: col.uri, linkUri: res.data.uri }
          : { collectionUri: col.uri, error: res.error }
      );
    }
  } else if (toAdd.length > 0) {
    // Margin's collectionItem carries flat at-uris, so every add goes in one batch.
    const writes = toAdd.map((col) => ({
      $type: 'com.atproto.repo.applyWrites#create' as const,
      collection: MARGIN_ITEM,
      rkey: generateTid(),
      value: {
        $type: MARGIN_ITEM,
        collection: col.uri,
        annotation: item.uri,
        createdAt: new Date().toISOString(),
      },
    }));
    const res = await pds.applyWrites(writes);
    if (res.success) {
      toAdd.forEach((col, i) => {
        added.push({ collectionUri: col.uri, linkUri: res.data.results[i]?.uri });
      });
    } else {
      for (const col of toAdd) added.push({ collectionUri: col.uri, error: res.error });
    }
  }

  return { item, added, removed };
}

/** Current cid of a record in the user's own repo (for the collection strongRef). */
async function resolveCid(pds: PDSClient, uri: string): Promise<string | null> {
  const ref = parseAtUri(uri);
  if (!ref) return null;
  const res = await pds.getRecord(ref.collection, ref.rkey);
  return res.success ? res.data.cid : null;
}
