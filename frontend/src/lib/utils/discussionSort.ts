// How the merged discussion is ordered.
//
// The stream is one conversation spread across several networks, and the panel
// previews only its first few rows before a fold — so the order decides what a
// reader actually sees. It leads with the references that carried: most-liked
// first, recency as the tiebreak.
//
// Only the Bluesky lane publishes a per-entry engagement number (see the proxy's
// bsky-appview.ts); a linkblog note, a margin.at annotation and a Semble card
// each *are* one save, with nothing second-order attached. Those rank as 0, which
// leaves them in exactly the order they had before — newest-first among
// themselves, beneath whatever the network actually amplified.
//
// Pure, so the ordering is testable without mounting anything.
import type { LanePersonVM } from '$lib/components/articleCardView.types';

/**
 * Newest first; an undated reference (a record with no timestamp we could parse)
 * sorts to the end rather than pretending to be new.
 */
export function newestFirst(a: LanePersonVM, b: LanePersonVM): number {
  const at = a.createdAt ? Date.parse(a.createdAt) : NaN;
  const bt = b.createdAt ? Date.parse(b.createdAt) : NaN;
  if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
  if (Number.isNaN(at)) return 1;
  if (Number.isNaN(bt)) return -1;
  return bt - at;
}

/**
 * Most-liked first, then newest first. `?? 0` covers both a lane with no metric
 * and a cached payload from before the field existed, so either way the entry
 * keeps its old relative position instead of being pushed anywhere new.
 */
export function byEngagement(a: LanePersonVM, b: LanePersonVM): number {
  const diff = (b.likeCount ?? 0) - (a.likeCount ?? 0);
  return diff !== 0 ? diff : newestFirst(a, b);
}
