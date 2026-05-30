import type { ItemLabel } from '$lib/types';

/**
 * Decide which local article `read` labels to drop during a full read-position
 * sync (reconciling un-reads made on other devices).
 *
 * The backend only returns reads within its retention window, so absence from
 * the server set is ambiguous:
 *   - absent AND recent (readAt >= windowStart) → genuinely un-read elsewhere → remove
 *   - absent AND old   (readAt <  windowStart)  → simply outside the server's window → keep
 *
 * Keeping the old ones is what prevents a windowed full sync from wiping the
 * user's older local read state. Only article `read` labels are considered;
 * starred/archived/tag labels and non-article types are never touched.
 *
 * @returns the `[itemKey, label]` pairs that should be removed locally.
 */
export function staleReadLabelsInWindow(
  labels: Iterable<ItemLabel>,
  serverGuids: Set<string>,
  windowStart: number
): Array<[string, string]> {
  const toRemove: Array<[string, string]> = [];
  for (const lbl of labels) {
    if (lbl.itemType !== 'article' || lbl.label !== 'read') continue;
    const readAt = (lbl.props.readAt as number) || 0;
    if (readAt >= windowStart && !serverGuids.has(lbl.itemKey)) {
      toRemove.push([lbl.itemKey, lbl.label]);
    }
  }
  return toRemove;
}
