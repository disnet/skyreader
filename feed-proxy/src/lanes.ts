/**
 * Source lanes for network-wide article mentions (Phase 5).
 *
 * Constellation indexes the whole firehose into a backlink graph, so an article
 * URL is the target of many record types. Rather than a flat 'who linked this'
 * count, we bucket each meaningful `(collection, path)` source into a named
 * **lane** with its own honest verb — a linkblog *note*, a Bluesky *post*, a
 * margin.at *highlight*, a Semble *save* are four different things, and lumping
 * them into one number ('linked this') is dishonest (saving ≠ discussing).
 *
 * The whitelist is **path-precise, not collection-precise**: verified live,
 * `/links/all` surfaces pure noise even inside a laned collection — a Bluesky
 * post's `.text` / `.embed.images[].alt` / `.bridgyOriginalUrl`, and whole
 * collections that merely log the URL as an HTTP *referrer* (a game's
 * `net.anisota.beta.game.session.sessionContext.referrer`, 300+ DIDs, nobody
 * discussing anything). A lane counts a path only if its collection is laned
 * AND the path isn't excluded.
 *
 * All four NSIDs/paths verified live against constellation.microcosm.blue
 * (2026-06-01). The registry is the only hardcoded surface; Constellation
 * reports which sources actually exist per URL.
 */

export type LaneId = 'linkblog' | 'bluesky' | 'margin' | 'semble';

export interface Lane {
  id: LaneId;
  /** Display label (capitalized noun) for the expanded breakdown. */
  label: string;
  /** Honest mechanical verb for the expanded breakdown ('N people <verb> this'). */
  verb: string;
  /** Singular source noun for the inline lead line ('3 <noun>s'); +s pluralizes. */
  noun: string;
  /** Frontend icon name (Icon.svelte). */
  icon: string;
  /** Record collections (NSIDs) whose link paths belong to this lane. */
  collections: string[];
  /**
   * Exact paths within those collections to ignore — incidental URL mentions
   * that aren't a real reference (alt text, bridge metadata, bare body text).
   */
  excludePaths?: string[];
}

// Priority order = lead-lane order on the card: commentary before marks.
export const LANES: Lane[] = [
  {
    id: 'linkblog',
    label: 'Blogs',
    verb: 'noted',
    noun: 'linkblog note',
    icon: 'standard-site',
    // site.standard.document links an article via the website-card ref
    // (.links[].uri) or an inline body facet — both are real references.
    collections: ['site.standard.document'],
  },
  {
    id: 'bluesky',
    label: 'Bluesky',
    verb: 'posted',
    noun: 'Bluesky post',
    icon: 'bluesky',
    collections: ['app.bsky.feed.post'],
    // Real links live in the embed/facet paths; these three are incidental.
    excludePaths: ['.text', '.embed.images[].alt', '.bridgyOriginalUrl'],
  },
  {
    id: 'margin',
    label: 'margin.at',
    verb: 'saved',
    noun: 'margin.at save',
    icon: 'margin',
    // at.margin.note → .target.source is the annotated page.
    collections: ['at.margin.note'],
  },
  {
    id: 'semble',
    label: 'Semble',
    verb: 'saved',
    noun: 'Semble save',
    icon: 'semble',
    // Semble writes the shared Cosmik card lexicon (.content.url / .url).
    collections: ['network.cosmik.card'],
  },
];

// collection NSID → lane, for O(1) bucketing of /links/all sources.
const COLLECTION_TO_LANE = new Map<string, Lane>();
for (const lane of LANES) {
  for (const collection of lane.collections) COLLECTION_TO_LANE.set(collection, lane);
}

/**
 * Resolve which lane (if any) a `(collection, path)` source counts toward.
 * Returns `null` for un-laned collections and excluded noise paths.
 */
export function laneForSource(collection: string, path: string): Lane | null {
  const lane = COLLECTION_TO_LANE.get(collection);
  if (!lane) return null;
  if (lane.excludePaths?.includes(path)) return null;
  return lane;
}
