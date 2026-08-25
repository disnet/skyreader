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
  url: string
): Promise<{ success: true; data: MembershipLookup } | { success: false; error: string }> {
  const target = normalizeArticleUrl(url);
  if (!target) return { success: false, error: 'url is not a usable http(s) URL' };

  const itemsRes = await pds.listAllRecords<{ motivation?: string; createdAt?: string }>(
    itemCollection(provider),
    { maxPages: MAX_PAGES }
  );
  if (!itemsRes.success) return { success: false, error: itemsRes.error };

  const items: MembershipItem[] = [];
  for (const rec of itemsRes.data) {
    // Margin uses one lexicon for bookmarks AND highlights; only `motivation`
    // separates them, and a highlight on the same article must not read as a save.
    if (provider === 'margin' && rec.value.motivation !== 'bookmarking') continue;
    // listRecords only returns this collection, so stamping $type is safe and lets
    // extractUrlFromRecord pick the right URL field for the shape.
    const recordUrl = extractUrlFromRecord({ ...rec.value, $type: itemCollection(provider) });
    if (!recordUrl || normalizeArticleUrl(recordUrl) !== target) continue;
    items.push({
      uri: rec.uri,
      cid: rec.cid,
      rkey: rkeyOf(rec.uri),
      createdAt: typeof rec.value.createdAt === 'string' ? rec.value.createdAt : undefined,
    });
  }
  items.sort(byNewest);

  let truncated = itemsRes.truncated === true;

  // No item for this URL means no membership can point at one — skip the second
  // listing entirely (the common "never saved" case costs one round trip).
  if (items.length === 0) {
    return { success: true, data: { items, memberships: [], truncated } };
  }

  const itemUris = new Set(items.map((i) => i.uri));
  const memberships: Membership[] = [];

  if (provider === 'semble') {
    const links = await pds.listAllRecords<{
      card?: { uri?: string };
      collection?: { uri?: string };
    }>(SEMBLE_LINK, { maxPages: MAX_PAGES });
    if (!links.success) return { success: false, error: links.error };
    truncated = truncated || links.truncated === true;
    for (const link of links.data) {
      const cardUri = link.value.card?.uri;
      const collectionUri = link.value.collection?.uri;
      if (!cardUri || !collectionUri || !itemUris.has(cardUri)) continue;
      memberships.push({ collectionUri, linkUri: link.uri, itemUri: cardUri });
    }
  } else {
    const links = await pds.listAllRecords<{ annotation?: string; collection?: string }>(
      MARGIN_ITEM,
      { maxPages: MAX_PAGES }
    );
    if (!links.success) return { success: false, error: links.error };
    truncated = truncated || links.truncated === true;
    for (const link of links.data) {
      const noteUri = link.value.annotation;
      const collectionUri = link.value.collection;
      if (!noteUri || !collectionUri || !itemUris.has(noteUri)) continue;
      memberships.push({ collectionUri, linkUri: link.uri, itemUri: noteUri });
    }
  }

  return { success: true, data: { items, memberships, truncated } };
}

export interface MembershipEditInput {
  url: string;
  /** collections to add the save to; `cid` is a hint, Semble re-resolves it live */
  add: Array<{ uri: string; cid?: string }>;
  /** membership record uris to delete (validated against provider + owner) */
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

  const removed: MembershipEditResult['removed'] = [];
  for (const { uri, rkey } of removeRkeys) {
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

  // The adds need an item to point at. Re-run the lookup server-side rather than
  // trusting a client-supplied uri — a stale client (or one whose save landed
  // elsewhere) then still does the right thing instead of linking the wrong card.
  const lookup = await findMemberships(pds, provider, input.url);
  if (!lookup.success) throw new MembershipEditError(lookup.error, 502);

  const existing = lookup.data.items[0];
  const item = existing
    ? { uri: existing.uri, cid: existing.cid, created: false }
    : { ...(await createItem(pds, provider, input)), created: true };

  // Don't create a second link for a collection the item is already in — a stale
  // picker (or a double-click) would otherwise duplicate the membership.
  const alreadyIn = new Set(
    lookup.data.memberships.filter((m) => m.itemUri === item.uri).map((m) => m.collectionUri)
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
