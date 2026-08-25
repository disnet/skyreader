import { resolveHighlightAliases } from '$lib/utils/highlightAliases';
import type { Highlight, ItemLabelType, MarginHighlightNote, SavedItem } from '$lib/types';

// The pure half of the Margin highlight ingest: notes in, per-item groups of new
// highlights out. Kept clear of the stores so it is directly unit-testable — the
// store/network half lives in services/marginHighlightImport.ts.

/** One item's worth of new highlights — written as a single union write. */
export interface MarginImportGroup {
  itemKey: string;
  itemType: ItemLabelType;
  highlights: Highlight[];
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
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
  saves: Pick<SavedItem, 'itemGuid' | 'uri'>[],
  makeId: () => string = generateId
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
    const itemKey = matchKey
      ? resolveHighlightAliases(matchKey, saves).canonicalKey
      : note.urlNormalized;

    const createdAt = note.createdAt ? Date.parse(note.createdAt) : NaN;
    const highlight: Highlight = {
      id: makeId(),
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
    else groups.set(itemKey, { itemKey, itemType: 'article', highlights: [highlight] });
  }

  return [...groups.values()];
}
