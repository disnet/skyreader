import type { Highlight, ItemLabelType, ReviewIntent, SavedItem } from '$lib/types';

/**
 * What kind of label row a save's highlights belong on. A save is the same
 * item the reader met in the feed, in the reader or as a bare URL, and the
 * label type has to name which — `resolveHighlightSource` looks in a different
 * cache for each.
 */
export function savedItemLabelType(save: Pick<SavedItem, 'source'>): ItemLabelType {
  if (save.source === 'document') return 'document';
  if (save.source === 'feed') return 'article';
  return 'saved';
}

export interface HighlightAliasResolution {
  canonicalKey: string;
  keys: string[];
}

export interface HighlightSource {
  key: string;
  updatedAt: number;
  highlights: Highlight[];
}

export type HighlightMutation =
  | { type: 'add'; highlight: Highlight }
  | { type: 'remove'; highlightId: string }
  | { type: 'note'; highlightId: string; note?: string }
  | { type: 'selector'; highlightId: string; selector: Highlight['selector'] }
  | {
      type: 'margin';
      highlightId: string;
      margin: { uri: string; rkey: string } | null;
    }
  | { type: 'reviewed'; highlightId: string; at: number }
  | { type: 'intent'; highlightId: string; intent: ReviewIntent | null };

/** Resolve every persisted key for one save, preferring its article guid. */
export function resolveHighlightAliases(
  itemKey: string,
  saves: Pick<SavedItem, 'itemGuid' | 'uri'>[]
): HighlightAliasResolution {
  const save = saves.find((item) => item.itemGuid === itemKey || item.uri === itemKey);
  if (!save) return { canonicalKey: itemKey, keys: [itemKey] };

  const canonicalKey = save.itemGuid || save.uri || itemKey;
  const keys = [canonicalKey, save.itemGuid, save.uri, itemKey].filter(
    (key, index, all): key is string => Boolean(key) && all.indexOf(key) === index
  );
  return { canonicalKey, keys };
}

/**
 * Merge alias rows by highlight id. A newer label wins when the same id exists
 * in more than one row, which makes a migrated canonical row authoritative
 * over a stale alias later returned by delta sync.
 */
export function unionHighlightSources(sources: HighlightSource[]): Highlight[] {
  const byId = new Map<string, Highlight>();
  for (const source of [...sources].sort((a, b) => a.updatedAt - b.updatedAt)) {
    for (const highlight of source.highlights) byId.set(highlight.id, highlight);
  }
  return [...byId.values()];
}

function sameSelector(a: Highlight['selector'], b: Highlight['selector']): boolean {
  return (
    a.exact === b.exact &&
    (a.prefix ?? '') === (b.prefix ?? '') &&
    (a.suffix ?? '') === (b.suffix ?? '')
  );
}

/** Apply every highlight mutation to the same alias-aware union used by reads. */
export function mutateHighlightUnion(
  highlights: Highlight[],
  mutation: HighlightMutation
): { highlights: Highlight[]; changed: boolean } {
  if (mutation.type === 'add') {
    const withoutDuplicate = highlights.filter((entry) => entry.id !== mutation.highlight.id);
    return { highlights: [...withoutDuplicate, mutation.highlight], changed: true };
  }

  const index = highlights.findIndex((entry) => entry.id === mutation.highlightId);
  if (index === -1) return { highlights, changed: false };
  if (mutation.type === 'remove') {
    return {
      highlights: highlights.filter((entry) => entry.id !== mutation.highlightId),
      changed: true,
    };
  }

  const next = [...highlights];
  const current = next[index];
  if (mutation.type === 'note') {
    const trimmed = mutation.note?.trim();
    if (trimmed) next[index] = { ...current, note: trimmed };
    else {
      const { note: _note, ...withoutNote } = current;
      next[index] = withoutNote;
    }
  } else if (mutation.type === 'selector') {
    // Re-bounding to the same text is a no-op, and it happens routinely: the
    // touch adjust flow commits on collapse, so tapping away without dragging
    // anything arrives here with the original selector. Without this guard that
    // would cost a full union write plus a Margin round-trip for nothing.
    if (sameSelector(current.selector, mutation.selector)) {
      return { highlights, changed: false };
    }
    next[index] = { ...current, selector: mutation.selector };
  } else if (mutation.type === 'intent') {
    if ((current.reviewIntent ?? null) === mutation.intent) {
      return { highlights, changed: false };
    }
    if (mutation.intent === null) {
      const { reviewIntent: _intent, ...atDefaultPace } = current;
      next[index] = atDefaultPace;
    } else {
      next[index] = { ...current, reviewIntent: mutation.intent };
    }
  } else if (mutation.type === 'reviewed') {
    // Only ever moves forward: an out-of-order write (a slow device flushing an
    // older review) must not make a highlight look due again.
    if (typeof current.lastReviewedAt === 'number' && current.lastReviewedAt >= mutation.at) {
      return { highlights, changed: false };
    }
    next[index] = { ...current, lastReviewedAt: mutation.at };
  } else if (mutation.margin) {
    next[index] = {
      ...current,
      marginUri: mutation.margin.uri,
      marginRkey: mutation.margin.rkey,
    };
  } else {
    const { marginUri: _uri, marginRkey: _rkey, ...withoutMargin } = current;
    next[index] = withoutMargin;
  }
  return { highlights: next, changed: true };
}
