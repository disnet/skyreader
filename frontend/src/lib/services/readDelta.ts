// Pure decision logic for the forward read delta and inline read annotation.
//
// Extracted from itemLabels.svelte.ts so the correctness-critical parts — the
// optimistic-race guard (a stale tombstone must not clear an in-flight local
// read), the additive-only merge invariant (annotation never clears), and the
// forward-only cursor advance — are unit-testable without the runes runtime,
// Dexie, or the network. The store imports these and applies the returned plans
// to its label maps + IndexedDB; this module makes no side effects.

import type { ItemLabel, ItemLabelType } from '$lib/types';

// One row from GET /api/reading/positions (the forward read delta). The backend
// returns live rows AND tombstones (deleted=true) for both item types since the
// client's cursor.
export interface ReadDeltaPosition {
  item_guid: string;
  item_type: 'article' | 'document';
  read_at: number | string | null;
  rkey: string | null;
  deleted: boolean;
}

export interface ReadDeltaPlan {
  // Live `read` rows to upsert into the label store.
  puts: ItemLabel[];
  // Tombstoned (un-read) items to remove, as [itemKey, 'read'] pairs.
  deletes: Array<[string, string]>;
}

/**
 * Reconcile a forward read-delta batch into add/remove operations.
 *
 * Live rows become `read` label puts. Tombstones become removals — EXCEPT for
 * any key with an in-flight local mark-read: a stale tombstone from the delta
 * must not clear a fresh local read whose push hasn't reached the server yet
 * (the optimistic-UI race). Such removals are dropped; the local read stands.
 *
 * Each (user, item, 'read') is a single backend row, so a given item_guid
 * appears at most once per batch — puts and deletes never collide on a key, and
 * applying them in either order is equivalent.
 */
export function planReadDelta(
  positions: ReadDeltaPosition[],
  opts: { isInFlight: (key: string) => boolean; now: number }
): ReadDeltaPlan {
  const puts: ItemLabel[] = [];
  const deletes: Array<[string, string]> = [];

  for (const p of positions) {
    const itemType: ItemLabelType = p.item_type === 'document' ? 'document' : 'article';
    if (p.deleted) {
      // Optimistic-race guard: skip removals for items with an in-flight local
      // mark-read (covers both the article debounce buffer and in-flight
      // document pushes — see isMarkReadInFlight in the store).
      if (opts.isInFlight(p.item_guid)) continue;
      deletes.push([p.item_guid, 'read']);
    } else {
      puts.push({
        itemKey: p.item_guid,
        itemType,
        label: 'read',
        props: { readAt: p.read_at ?? opts.now },
        createdAt: typeof p.read_at === 'number' ? p.read_at : opts.now,
        updatedAt: opts.now,
      });
    }
  }

  return { puts, deletes };
}

/**
 * Inline read annotation: which keys need a `read` label added.
 *
 * Additive only — skips keys already labeled read and never returns removals.
 * Freshly-fetched items have no prior local label to protect, and clears are the
 * forward delta's job (cross-device un-read), so the merge stays race-free with a
 * just-marked-read item (Invariant 2: merge never clears).
 */
export function planAnnotatedReads(
  keys: string[],
  itemType: ItemLabelType,
  opts: { hasRead: (key: string) => boolean; now: number }
): ItemLabel[] {
  const puts: ItemLabel[] = [];
  for (const key of keys) {
    if (opts.hasRead(key)) continue;
    puts.push({
      itemKey: key,
      itemType,
      label: 'read',
      props: { readAt: opts.now },
      createdAt: opts.now,
      updatedAt: opts.now,
    });
  }
  return puts;
}

/**
 * Forward-only cursor advance: returns the cursor to persist, or null if the
 * incoming cursor does not move strictly past the current one (so the delta
 * cursor never rewinds, even if a stale/empty response comes back).
 */
export function advanceCursor(current: number, incoming: number | null | undefined): number | null {
  if (incoming && incoming > current) return incoming;
  return null;
}
