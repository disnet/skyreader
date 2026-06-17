/**
 * External-backed saves — Phase 3/4 WRITE path (adopt).
 *
 * When backing is on, a save creates a membership in the user's foreign collection
 * instead of the app.skyreader.feed.saved export, and an unsave removes that
 * membership (never the item). Shapes are extracted from the proven handlers in
 * routes/integrations.ts. See docs/plans/EXTERNAL_BACKED_SAVES_PLAN.md (Phases 3-4).
 *
 * Two foreign-record realities shape this:
 *  - SEMBLE is sequential: the collectionLink carries a strongRef to the card
 *    ({uri, cid}), and the card cid isn't known until the card is written — so we
 *    can't batch both in one applyWrites. Card first, then link; if the link fails,
 *    we clean up the orphan card.
 *  - MARGIN is atomic: collectionItem.annotation is a flat at-uri string (no cid),
 *    and the note's uri is derivable from the rkey we pick — so both records go in
 *    one applyWrites batch.
 *
 * Margin lexicon note: current OAuth scopes grant repo:at.margin.note but NOT
 * repo:community.lexicon.bookmarks.bookmark, so the scope-compatible save we can
 * write today is an at.margin.note (motivation:'bookmarking'), which our read path
 * already resolves. Phase 0 live data shows Margin's own ecosystem uses the
 * community bookmark lexicon for saves; switching to it needs that scope + the
 * deferred auth probe. Tracked as the Phase 1 "Margin write half" open question.
 */

import { generateTid } from '../../utils/tid';
import { parseAtUri } from '../../utils/canonical-url';
import type { PDSClient } from '../pds-client';
import type { BackingProviderName } from './read';

const SEMBLE_CARD = 'network.cosmik.card';
const SEMBLE_LINK = 'network.cosmik.collectionLink';
const SEMBLE_COLLECTION = 'network.cosmik.collection';
const MARGIN_NOTE = 'at.margin.note';
const MARGIN_ITEM = 'at.margin.collectionItem';
const MARGIN_COLLECTION = 'at.margin.collection';

/** Everything createMember needs about a save to project it into a collection. */
export interface CreateMemberInput {
  /** the web URL keyed on (article URL, or a document's resolved blogs URL) */
  url: string;
  title?: string;
  description?: string;
  author?: string;
  publishedAt?: string;
  /** a native atproto record this save points at (a document's recordUri) — Semble
   *  stashes it in card metadata for an at:// round-trip; Margin keeps it D1-side. */
  canonicalAtUri?: string;
}

/** The two foreign at-uris we record for a member: the item, and the membership. */
export interface MemberHandles {
  /** card / note — the item record (never deleted on unsave) */
  itemUri: string;
  /** collectionLink / collectionItem — the membership (deleted on unsave) */
  linkUri: string;
}

class BackingWriteError extends Error {}

/**
 * Create a new backing collection record ("Skyreader Saves" by default). Record
 * shapes confirmed against live records (2026-06-18):
 *  - network.cosmik.collection: { name, createdAt, updatedAt, accessType, collaborators }
 *  - at.margin.collection:      { name, createdAt, icon }
 * Returns the new collection's at-uri to write into the `backing` setting.
 */
export async function createCollection(
  pds: PDSClient,
  provider: BackingProviderName,
  name: string
): Promise<{ uri: string }> {
  const rkey = generateTid();
  const nowIso = new Date().toISOString();
  const collection = provider === 'semble' ? SEMBLE_COLLECTION : MARGIN_COLLECTION;
  const record =
    provider === 'semble'
      ? {
          $type: SEMBLE_COLLECTION,
          name,
          accessType: 'CLOSED',
          collaborators: [],
          createdAt: nowIso,
          updatedAt: nowIso,
        }
      : {
          $type: MARGIN_COLLECTION,
          name,
          icon: 'icon:folder',
          createdAt: nowIso,
        };
  const res = await pds.putRecord(collection, rkey, record);
  if (!res.success) throw new BackingWriteError(`collection create failed: ${res.error}`);
  return { uri: res.data.uri };
}

/**
 * Existing collection names in the user's repo for this provider. Used at enable time
 * to avoid creating a second collection that collides with one the user already has
 * (e.g. a prior "Skyreader Saves" left behind by toggling backing off then on).
 * Best-effort: a list failure returns [] so enable still proceeds with the default name.
 */
export async function listCollectionNames(
  pds: PDSClient,
  provider: BackingProviderName
): Promise<string[]> {
  const collection = provider === 'semble' ? SEMBLE_COLLECTION : MARGIN_COLLECTION;
  const res = await pds.listAllRecords<{ name?: string }>(collection, { maxPages: 5 });
  if (!res.success) {
    console.error(`[backing] could not list ${collection} for dedup:`, res.error);
    return [];
  }
  return res.data
    .map((r) => r.value.name)
    .filter((n): n is string => typeof n === 'string' && n.trim() !== '');
}

/**
 * Create the foreign item + membership records for a save in the given collection.
 * Returns the two at-uris to persist in backed_collection_members.
 */
export async function createMember(
  pds: PDSClient,
  did: string,
  provider: BackingProviderName,
  collectionUri: string,
  input: CreateMemberInput
): Promise<MemberHandles> {
  return provider === 'semble'
    ? createSembleMember(pds, did, collectionUri, input)
    : createMarginMember(pds, did, collectionUri, input);
}

async function createSembleMember(
  pds: PDSClient,
  did: string,
  collectionUri: string,
  input: CreateMemberInput
): Promise<MemberHandles> {
  // collectionLink.collection is a strongRef — resolve the collection's current cid.
  const collectionCid = await resolveCid(pds, did, collectionUri);
  if (!collectionCid) throw new BackingWriteError('could not resolve backing collection cid');

  const metadata: Record<string, string> = {};
  if (input.title) metadata.title = input.title;
  if (input.description) metadata.description = input.description;
  if (input.author) metadata.author = input.author;
  if (input.publishedAt) metadata.publishedDate = input.publishedAt;
  // Stash a canonical at:// peer identifier (documents) so atproto-aware apps can
  // round-trip to the native record. content.url stays the web URL for the graph.
  if (input.canonicalAtUri) metadata.skyreaderRecord = input.canonicalAtUri;

  const cardRkey = generateTid();
  const card = {
    $type: SEMBLE_CARD,
    type: 'URL',
    content: {
      url: input.url,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    },
    url: input.url,
    createdAt: new Date().toISOString(),
  };
  const cardRes = await pds.putRecord(SEMBLE_CARD, cardRkey, card);
  if (!cardRes.success) throw new BackingWriteError(`card write failed: ${cardRes.error}`);

  const linkRkey = generateTid();
  const link = {
    $type: SEMBLE_LINK,
    collection: { uri: collectionUri, cid: collectionCid },
    card: { uri: cardRes.data.uri, cid: cardRes.data.cid },
    addedBy: did,
    addedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
  const linkRes = await pds.putRecord(SEMBLE_LINK, linkRkey, link);
  if (!linkRes.success) {
    // Clean up the orphan card so a failed link doesn't litter the repo (and so a
    // retry doesn't accumulate duplicate cards). Best-effort.
    await pds.deleteRecord(SEMBLE_CARD, cardRkey).catch(() => {});
    throw new BackingWriteError(`collectionLink write failed: ${linkRes.error}`);
  }

  return { itemUri: cardRes.data.uri, linkUri: linkRes.data.uri };
}

async function createMarginMember(
  pds: PDSClient,
  did: string,
  collectionUri: string,
  input: CreateMemberInput
): Promise<MemberHandles> {
  // annotation is a flat at-uri string and the note's uri is derivable from its
  // rkey, so both records create atomically in one applyWrites batch.
  const noteRkey = generateTid();
  const itemRkey = generateTid();
  const noteUri = `at://${did}/${MARGIN_NOTE}/${noteRkey}`;

  const note = {
    $type: MARGIN_NOTE,
    motivation: 'bookmarking',
    target: {
      source: input.url,
      ...(input.title ? { title: input.title } : {}),
    },
    ...(input.description ? { body: { value: input.description, format: 'text/plain' } } : {}),
    tags: [],
    generator: { name: 'Skyreader', homepage: 'https://skyreader.app' },
    createdAt: new Date().toISOString(),
  };
  const collectionItem = {
    $type: MARGIN_ITEM,
    collection: collectionUri,
    annotation: noteUri,
    createdAt: new Date().toISOString(),
  };

  const res = await pds.applyWrites([
    {
      $type: 'com.atproto.repo.applyWrites#create',
      collection: MARGIN_NOTE,
      rkey: noteRkey,
      value: note,
    },
    {
      $type: 'com.atproto.repo.applyWrites#create',
      collection: MARGIN_ITEM,
      rkey: itemRkey,
      value: collectionItem,
    },
  ]);
  if (!res.success) throw new BackingWriteError(`margin applyWrites failed: ${res.error}`);

  // applyWrites returns results in op order: [note, collectionItem].
  const itemUri = res.data.results[0]?.uri ?? noteUri;
  const linkUri = res.data.results[1]?.uri ?? `at://${did}/${MARGIN_ITEM}/${itemRkey}`;
  return { itemUri, linkUri };
}

/**
 * Remove a save's membership from the collection — the link/item record ONLY, never
 * the card/note item. The item is a shared object that may belong to other
 * collections or carry annotations made elsewhere; unsave = leave the collection.
 */
export async function removeMember(
  pds: PDSClient,
  provider: BackingProviderName,
  handles: { linkUri: string }
): Promise<void> {
  const ref = parseAtUri(handles.linkUri);
  if (!ref) throw new BackingWriteError(`bad membership uri: ${handles.linkUri}`);
  const res = await pds.deleteRecord(ref.collection, ref.rkey);
  if (!res.success) throw new BackingWriteError(`membership delete failed: ${res.error}`);
}

/** Resolve a record's current cid via the user's own repo (for the collection
 *  strongRef). The backing collection lives in the user's repo, so getRecord —
 *  which targets the session's own did — is correct. */
async function resolveCid(pds: PDSClient, _did: string, uri: string): Promise<string | null> {
  const ref = parseAtUri(uri);
  if (!ref) return null;
  const res = await pds.getRecord(ref.collection, ref.rkey);
  return res.success ? res.data.cid : null;
}
