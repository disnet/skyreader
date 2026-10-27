import { resolveHighlightAliases, savedItemLabelType } from '$lib/utils/highlightAliases';
import { tidToTimestamp } from '$lib/utils/tid';
import type { Highlight, ItemLabelType, MarginHighlightNote, SavedItem } from '$lib/types';

// The pure half of the Margin highlight ingest: notes in, per-item groups of new
// highlights out. Kept clear of the stores so it is directly unit-testable — the
// store/network half lives in services/marginHighlightImport.ts.

/** The save fields both passes below need: the alias keys, plus its kind. */
type SaveRef = Pick<SavedItem, 'itemGuid' | 'uri' | 'source'>;

/**
 * The label type a matched note's group is written under.
 *
 * A note matched to a save is the same item that save is, so it gets that
 * save's label type — writing every import as `'article'` would file a
 * highlight on a saved document under a type the document lookup never reads.
 * An unmatched note has no local item of any kind to take a type from, so it
 * keeps `'article'`; `persistHighlightUnion` will inherit the real type from
 * the canonical row once the re-key pass finds it a home.
 */
function groupItemType(save: SaveRef | undefined): ItemLabelType {
  return save ? savedItemLabelType(save) : 'article';
}

/** The save a server-side match points at, if the client still holds it. */
function findSave(matchKey: string | null, saves: SaveRef[]): SaveRef | undefined {
  if (!matchKey) return undefined;
  return saves.find((item) => item.itemGuid === matchKey || item.uri === matchKey);
}

/** One item's worth of new highlights — written as a single union write. */
export interface MarginImportGroup {
  itemKey: string;
  itemType: ItemLabelType;
  highlights: Highlight[];
}

/**
 * What one call to the import actually did.
 *
 * A single `null` used to stand for "off", "offline", "polled recently", "the
 * grant lapsed" and "the request failed" alike, so every surface had to guess —
 * and the settings toggle guessed wrong, telling a reader whose Margin grant had
 * expired that Skyreader couldn't reach the network. Naming the outcomes lets
 * each surface say the true thing, or stay quiet.
 */
export type MarginImportOutcome =
  | {
      status: 'imported';
      imported: number;
      /** Notes edited on Margin, applied here. */
      updated: number;
      /** Imported highlights removed because their note was deleted on Margin. */
      removed: number;
      /** Highlights made here, unpublished because their note was deleted on Margin. */
      unpublished: number;
      truncated: boolean;
    }
  | { status: 'skipped'; reason: 'disabled' | 'offline' | 'throttled' | 'stores-loading' }
  /** The Margin grant is gone; the import switched itself off. */
  | { status: 'scope-expired' }
  | { status: 'failed' };

/** Where one locally-held highlight lives, for the re-key pass below. */
export interface MarginHighlightLocation {
  itemKey: string;
  highlight: Highlight;
}

/** Move an already-imported highlight onto the key its article now has. */
export interface MarginRekeyGroup {
  from: string;
  to: string;
  itemType: ItemLabelType;
  highlights: Highlight[];
}

/** The prefix `marginHighlightId` mints, and the only mark of an imported highlight. */
const MARGIN_IMPORT_ID_PREFIX = 'margin:';

/**
 * An imported highlight's id is derived from the Margin rkey, not random.
 *
 * Two devices can both poll before either one's label write has synced down, so
 * both see an empty `knownRkeys` for the same note and both import it. Ids are
 * what `unionHighlightSources` merges on, so a random id would let the two
 * copies survive each other permanently and show the passage twice. Deriving it
 * from the rkey makes the import idempotent across devices and re-polls.
 */
export function marginHighlightId(note: MarginHighlightNote): string {
  return `${MARGIN_IMPORT_ID_PREFIX}${note.rkey}`;
}

/**
 * Did the import mint this highlight, or did Skyreader make it and push it out?
 *
 * `marginRkey` can't answer that — Skyreader stamps it on its own highlights the
 * moment they're saved to Margin, so it means "there is a record for this", not
 * "this came from there". The id is what distinguishes them.
 */
export function isImportedFromMargin(highlight: Pick<Highlight, 'id'>): boolean {
  return highlight.id.startsWith(MARGIN_IMPORT_ID_PREFIX);
}

/**
 * Turn fetched Margin notes into per-item groups of new highlights.
 *
 * - Dedups against every `marginRkey` already known locally, which automatically
 *   skips everything Skyreader itself pushed out.
 * - A note matched to a save resolves to that save's canonical highlight key, so
 *   the import lands on the same row as an in-reader highlight of the same
 *   article. An unmatched note is keyed by its normalized URL and carries
 *   `sourceUrl`/`sourceTitle` so it can still render and open.
 */
export function planMarginHighlightImport(
  notes: MarginHighlightNote[],
  existing: { highlight: Highlight }[],
  saves: SaveRef[],
  makeId: (note: MarginHighlightNote) => string = marginHighlightId
): MarginImportGroup[] {
  const knownRkeys = new Set(
    existing
      .map((entry) => entry.highlight.marginRkey)
      .filter((rkey): rkey is string => Boolean(rkey))
  );
  const groups = new Map<string, MarginImportGroup>();

  for (const note of notes) {
    if (!note.rkey || knownRkeys.has(note.rkey)) continue;
    // A duplicate rkey inside one poll would otherwise import twice.
    knownRkeys.add(note.rkey);

    const matchKey = note.match?.itemGuid || note.match?.uri || null;
    const save = findSave(matchKey, saves);
    const itemKey = matchKey
      ? resolveHighlightAliases(matchKey, saves).canonicalKey
      : note.urlNormalized;

    const createdAt = note.createdAt ? Date.parse(note.createdAt) : NaN;
    const highlight: Highlight = {
      id: makeId(note),
      selector: note.selector,
      createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
      ...(note.note ? { note: note.note } : {}),
      marginUri: note.uri,
      marginRkey: note.rkey,
      sourceUrl: note.url,
      ...(note.title ? { sourceTitle: note.title } : {}),
    };

    const group = groups.get(itemKey);
    if (group) group.highlights.push(highlight);
    else groups.set(itemKey, { itemKey, itemType: groupItemType(save), highlights: [highlight] });
  }

  return [...groups.values()];
}

/**
 * Imported highlights whose article has since been saved.
 *
 * A note with no `match` is keyed by its normalized URL, because the client has
 * neither the saves table nor the normalization — the server does that join. If
 * the reader saves the article later the match does show up on the next poll,
 * but the import is idempotent on the rkey and would skip the note forever,
 * stranding the highlight under a URL key: invisible on the article in the
 * reader, and a group of its own on /highlights.
 *
 * So each poll also asks where its known notes actually live, and moves the ones
 * that now have a canonical home. Only ever *toward* a match — a note that loses
 * one (the reader unsaved the article) stays put rather than shuttling back and
 * forth with every poll.
 */
export function planMarginHighlightRekeys(
  notes: MarginHighlightNote[],
  existing: MarginHighlightLocation[],
  saves: SaveRef[]
): MarginRekeyGroup[] {
  const byRkey = new Map<string, MarginHighlightLocation>();
  for (const entry of existing) {
    // Only highlights the import minted are ever moved. One Skyreader made and
    // pushed out carries a marginRkey too, and its key is the article it was
    // made on — re-keying that onto a later save of the same URL would tear the
    // highlight off the article it belongs to and out of the reader's view.
    if (!isImportedFromMargin(entry.highlight)) continue;
    const rkey = entry.highlight.marginRkey;
    if (rkey && !byRkey.has(rkey)) byRkey.set(rkey, entry);
  }

  const groups = new Map<string, MarginRekeyGroup>();
  for (const note of notes) {
    const matchKey = note.match?.itemGuid || note.match?.uri || null;
    if (!matchKey) continue;
    const local = byRkey.get(note.rkey);
    if (!local) continue;

    const to = resolveHighlightAliases(matchKey, saves).canonicalKey;
    // Resolve the current key too: a highlight sitting on the save's record uri
    // when `to` is that save's guid is already home, and moving it would be churn.
    if (resolveHighlightAliases(local.itemKey, saves).canonicalKey === to) continue;

    const key = `${local.itemKey} -> ${to}`;
    const group = groups.get(key);
    if (group) group.highlights.push(local.highlight);
    else {
      groups.set(key, {
        from: local.itemKey,
        to,
        itemType: groupItemType(findSave(matchKey, saves)),
        highlights: [local.highlight],
      });
    }
  }

  return [...groups.values()];
}

/**
 * How long a note record has to have existed before its absence from a listing
 * counts as a deletion. A listing is a snapshot: a highlight published from
 * another device after it was taken (and whose link has already synced here)
 * is missing from it without having been deleted.
 */
export const MARGIN_DELETE_GRACE_MS = 10 * 60 * 1000;

/** What one poll's listing says about the highlights already linked to Margin. */
export interface MarginSyncListing {
  notes: MarginHighlightNote[];
  /** Every note record listed, highlight or not. Absent from an older backend. */
  rkeys?: string[];
  /** Whose repo was listed. Absent from an older backend. */
  did?: string;
  truncated: boolean;
  /** When the listing was requested (ms). */
  listedAt: number;
}

/** One change Margin's side asks of a highlight Skyreader already holds. */
export type MarginSyncChange =
  /** The note was edited (or cleared) on Margin. */
  | { kind: 'note'; itemKey: string; highlightId: string; note: string | undefined }
  /** An imported highlight whose note was deleted on Margin: it goes. */
  | { kind: 'remove'; itemKey: string; highlightId: string }
  /** A highlight made here whose note was deleted on Margin: it stays, unpublished. */
  | { kind: 'unlink'; itemKey: string; highlightId: string };

function sameNote(a: string | undefined, b: string | undefined): boolean {
  return (a?.trim() || '') === (b?.trim() || '');
}

/** The repo an at:// uri names, or null when it doesn't parse. */
function uriAuthority(uri: string | undefined): string | null {
  const match = uri?.match(/^at:\/\/([^/]+)\//);
  return match ? match[1] : null;
}

/**
 * Bring highlights already linked to a Margin note in line with that note.
 *
 * The import only ever adds, so on its own a note edited or deleted on Margin
 * never reached Skyreader. This is the other half, and it mirrors how a linked
 * Shelf collection reconciles: Margin's side is read back, and what changed over
 * there is applied here.
 *
 * - A note edited on Margin replaces the highlight's note.
 * - A note deleted on Margin removes a highlight the import made, and only
 *   unlinks one made in Skyreader: that highlight was the reader's before it
 *   was ever published, and deleting the public copy reads as "unpublish".
 *
 * Absence is only trusted when the listing could prove it: never from a
 * truncated listing or one without the full rkey list, never for a record
 * whose rkey doesn't date it or that is younger than the grace window, and
 * never for a note in another repo. A record that is still listed but no longer
 * parses as a highlight is left alone. Highlights named in `pendingIds` have a
 * Margin write of the reader's own still queued, and ones that differ from
 * `before` (how they stood when the listing was requested) changed here since;
 * both are skipped entirely.
 */
export function planMarginHighlightSync(
  listing: MarginSyncListing,
  existing: MarginHighlightLocation[],
  pendingIds: ReadonlySet<string>,
  before: ReadonlyMap<string, Pick<Highlight, 'note' | 'marginRkey'>>,
  graceMs: number = MARGIN_DELETE_GRACE_MS
): MarginSyncChange[] {
  const byRkey = new Map<string, MarginHighlightNote>();
  for (const note of listing.notes) {
    if (note.rkey && !byRkey.has(note.rkey)) byRkey.set(note.rkey, note);
  }
  const listed = listing.rkeys ? new Set(listing.rkeys) : null;

  const changes: MarginSyncChange[] = [];
  const seen = new Set<string>();
  for (const { itemKey, highlight } of existing) {
    const rkey = highlight.marginRkey;
    if (!rkey || pendingIds.has(highlight.id)) continue;
    // Changed here while the listing was out (or new since): the listing is
    // older than the reader's change, so it has nothing to say about it.
    const then = before.get(highlight.id);
    if (!then || then.marginRkey !== rkey || !sameNote(then.note, highlight.note)) continue;
    // One highlight can surface under two alias rows; act on it once.
    const seenKey = `${itemKey}\0${highlight.id}`;
    if (seen.has(seenKey)) continue;
    seen.add(seenKey);

    const note = byRkey.get(rkey);
    if (note) {
      if (!sameNote(highlight.note, note.note)) {
        changes.push({ kind: 'note', itemKey, highlightId: highlight.id, note: note.note });
      }
      continue;
    }

    if (!listed || listing.truncated || listed.has(rkey)) continue;
    const authority = uriAuthority(highlight.marginUri);
    if (listing.did && authority && authority !== listing.did) continue;
    const madeAt = tidToTimestamp(rkey);
    if (madeAt === null || madeAt > listing.listedAt - graceMs) continue;

    changes.push({
      kind: isImportedFromMargin(highlight) ? 'remove' : 'unlink',
      itemKey,
      highlightId: highlight.id,
    });
  }
  return changes;
}
