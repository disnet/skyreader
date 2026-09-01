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
  // When the USER made this change, unix ms (absent on a backend that predates
  // user-time LWW). Compared against local intent before the row is applied.
  client_updated_at?: number | null;
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
 * Live rows become `read` label puts. Tombstones become removals — EXCEPT where
 * this device holds NEWER intent for the same item, in which case the remote row
 * is dropped and the local state stands. "Newer intent" generalizes the original
 * in-flight guard from "a push is still in the air" to the honest comparison —
 * user-action time — because the two devices' writes are ordered by when the
 * user acted, not by which HTTP request the server saw last:
 *
 *  - a tombstone is dropped when a local mark-read is in flight, OR when the
 *    local `read` label's own timestamp is newer than the tombstone's
 *    `client_updated_at`;
 *  - a live row is dropped when this device recorded an un-read for that item
 *    more recently than the row's `client_updated_at` (`unreadIntentAt`), which
 *    is the mirror case: the server hasn't seen our un-read yet, so its copy is
 *    stale by definition.
 *
 * A backend that doesn't send `client_updated_at` degrades to the old
 * in-flight-only behaviour rather than guessing.
 *
 * Each (user, item, 'read') is a single backend row, so a given item_guid
 * appears at most once per batch — puts and deletes never collide on a key, and
 * applying them in either order is equivalent.
 */
export function planReadDelta(
  positions: ReadDeltaPosition[],
  opts: {
    isInFlight: (key: string) => boolean;
    now: number;
    // Local `read` label's updatedAt (unix ms), or undefined when unlabeled.
    localReadAt?: (key: string) => number | undefined;
    // When this device last marked the item unread (unix ms), if recently.
    unreadIntentAt?: (key: string) => number | undefined;
  }
): ReadDeltaPlan {
  const puts: ItemLabel[] = [];
  const deletes: Array<[string, string]> = [];

  for (const p of positions) {
    const itemType: ItemLabelType = p.item_type === 'document' ? 'document' : 'article';
    const remoteAt = typeof p.client_updated_at === 'number' ? p.client_updated_at : undefined;

    if (p.deleted) {
      // Optimistic-race guard: skip removals for items with an in-flight local
      // mark-read (covers both the article debounce buffer and in-flight
      // document pushes — see isMarkReadInFlight in the store).
      if (opts.isInFlight(p.item_guid)) continue;
      const localAt = opts.localReadAt?.(p.item_guid);
      if (remoteAt !== undefined && localAt !== undefined && localAt > remoteAt) continue;
      deletes.push([p.item_guid, 'read']);
    } else {
      const unreadAt = opts.unreadIntentAt?.(p.item_guid);
      if (remoteAt !== undefined && unreadAt !== undefined && unreadAt > remoteAt) continue;
      puts.push({
        itemKey: p.item_guid,
        itemType,
        label: 'read',
        props: { readAt: p.read_at ?? opts.now },
        createdAt: typeof p.read_at === 'number' ? p.read_at : opts.now,
        // The user's action time when the server knows it, so a later comparison
        // against another device's row is apples-to-apples. Falls back to
        // arrival time on a backend that doesn't report it.
        updatedAt: remoteAt ?? opts.now,
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
 *
 * Only used for the legacy numeric cursor. The compound `(updated_at, id)`
 * cursor is opaque to the client, so its monotonicity is the server's
 * guarantee: an empty page echoes back the caller's own cursor rather than a
 * clock reading, and the client persists it only after the batch is durable.
 */
export function advanceCursor(current: number, incoming: number | null | undefined): number | null {
  if (incoming && incoming > current) return incoming;
  return null;
}

/** The subset of a `readProgress` label's props this merge is ordered by. */
export interface ReadProgressProps {
  paragraphIndex?: number;
  totalParagraphs?: number;
  lastReadAt?: number;
}

/**
 * Which of {local, remote} `readProgress` to keep.
 *
 * The delta used to overwrite local progress unconditionally, so a device that
 * had just scrolled — with its 500 ms debounce still pending — was silently
 * rewound to another device's older position, and then republished that older
 * position as authoritative when the debounce fired.
 *
 * `lastReadAt` is the ordering, never `paragraphIndex`: position may legitimately
 * move backwards when someone re-reads, and treating "further along" as "newer"
 * would make a re-read impossible to sync. Ties go to the remote row so a
 * re-pull is idempotent.
 */
export function mergeReadProgress(
  local: ReadProgressProps | undefined,
  remote: ReadProgressProps
): 'local' | 'remote' {
  const localAt = local?.lastReadAt;
  const remoteAt = remote.lastReadAt;
  if (typeof localAt !== 'number') return 'remote';
  if (typeof remoteAt !== 'number') return 'local';
  return localAt > remoteAt ? 'local' : 'remote';
}
