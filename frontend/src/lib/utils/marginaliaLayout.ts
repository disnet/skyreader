/**
 * Where the margin brackets go when highlights crowd each other.
 *
 * Two cases, handled differently:
 *
 * - Neighbours that only share a line (one passage ends mid-line and the next
 *   begins on it) split that line between them: the first bracket ends a hair
 *   above its middle and the next starts a hair below, so they stack in one
 *   column like a pair of `}` set one over the other.
 * - Real overlaps (one passage inside another, or two running over each other
 *   for more than a line) nest: the shorter bracket stays next to the text and
 *   the longer one steps out a lane, so its hooks clear the inner one's beak.
 */

export interface BracketSpan {
  top: number;
  bottom: number;
  /** Height of one line of the passage's text, if measured. */
  line?: number;
  /**
   * Where the passage starts and ends in reading order (e.g. the indices of
   * its first and last marks among all marks on the page), if known. Tells
   * passages that merely share a line from one written inside another.
   */
  first?: number;
  last?: number;
}

export interface PlacedBracket {
  top: number;
  bottom: number;
  lane: number;
}

/**
 * Space left between two brackets that split a shared line. Brackets are drawn
 * 2px past each end of their extent, so this leaves 4px of paper between them.
 */
const SPLIT_GAP = 8;
/** Brackets this close still count as touching. */
const TOUCH = 2;
/** Lanes past this one would run into the notes. */
const MAX_LANE = 2;

/**
 * Lays out brackets for `spans` (sorted by top). Returns, for each span in the
 * same order, the extent its bracket should be drawn over and its lane.
 */
export function placeBrackets(spans: readonly BracketSpan[]): PlacedBracket[] {
  const placed = spans.map((s) => ({ top: s.top, bottom: s.bottom, lane: 0 }));

  // Split lines shared by neighbours, judged on the measured extents so one
  // split can't feed into the next.
  for (let i = 0; i < spans.length; i++) {
    const a = spans[i];
    for (let j = i + 1; j < spans.length; j++) {
      const b = spans[j];
      if (b.top >= a.bottom) break;
      const pair = neighbours(i, j, spans);
      if (!pair) continue;
      const [u, l] = pair;
      const upper = spans[u];
      const lower = spans[l];
      const line = Math.max(upper.line ?? 0, lower.line ?? 0);
      if (!line || upper.bottom - lower.top > line * 1.2) continue;
      const mid = (upper.bottom + lower.top) / 2;
      placed[u].bottom = Math.min(placed[u].bottom, mid - SPLIT_GAP / 2);
      placed[l].top = Math.max(placed[l].top, mid + SPLIT_GAP / 2);
    }
  }

  // Nest what still overlaps: shortest first, each one lane outside every
  // shorter bracket it overlaps.
  const order = placed.map((_, i) => i).sort((x, y) => height(placed[x]) - height(placed[y]));
  const done: number[] = [];
  for (const i of order) {
    let lane = 0;
    for (const k of done) {
      if (overlaps(placed[i], placed[k])) lane = Math.max(lane, placed[k].lane + 1);
    }
    placed[i].lane = Math.min(lane, MAX_LANE);
    done.push(i);
  }
  return placed;
}

/**
 * For two passages whose brackets overlap, `[upper, lower]` if they are
 * neighbours (one reads entirely before the other), or null if one sits
 * inside the other.
 */
function neighbours(i: number, j: number, spans: readonly BracketSpan[]): [number, number] | null {
  const a = spans[i];
  const b = spans[j];
  let pair: [number, number] | null;
  if (a.first != null && a.last != null && b.first != null && b.last != null) {
    pair = a.last < b.first ? [i, j] : b.last < a.first ? [j, i] : null;
  } else {
    // Unknown order: only a passage that starts lower and ends lower.
    pair = a.top < b.top && a.bottom < b.bottom ? [i, j] : null;
  }
  if (!pair) return null;
  const [upper, lower] = [spans[pair[0]], spans[pair[1]]];
  return upper.top <= lower.top && upper.bottom <= lower.bottom ? pair : null;
}

function height(s: { top: number; bottom: number }) {
  return s.bottom - s.top;
}

function overlaps(a: { top: number; bottom: number }, b: { top: number; bottom: number }) {
  return a.top < b.bottom + TOUCH && b.top < a.bottom + TOUCH;
}
