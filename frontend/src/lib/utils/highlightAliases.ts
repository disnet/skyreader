import type { Highlight, SavedItem } from '$lib/types';

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
  | {
      type: 'margin';
      highlightId: string;
      margin: { uri: string; rkey: string } | null;
    }
  | { type: 'reviewed'; highlightId: string; at: number }
  | { type: 'retire'; highlightId: string; at: number | null };

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
  } else if (mutation.type === 'retire') {
    const retired = typeof current.reviewRetiredAt === 'number';
    if (retired === (mutation.at !== null)) return { highlights, changed: false };
    if (mutation.at === null) {
      const { reviewRetiredAt: _retired, ...backInRotation } = current;
      next[index] = backInRotation;
    } else {
      next[index] = { ...current, reviewRetiredAt: mutation.at };
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
