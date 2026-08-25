import { api, ScopeUpgradeError } from '$lib/services/api';
import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
import { preferences } from '$lib/stores/preferences.svelte';
import { savesStore } from '$lib/stores/saves.svelte';
import { syncStore } from '$lib/stores/sync.svelte';
import { planMarginHighlightImport } from '$lib/utils/marginHighlightImport';

// Opt-in ingest of the reader's own Margin highlights, so the review deck covers
// everything they've highlighted across the Atmosphere and not only what they
// highlighted in Skyreader.
//
// Imported highlights carry `marginUri`/`marginRkey` exactly like one Skyreader
// pushed out, which is what makes the lifecycle symmetric: re-polls dedup on the
// rkey, note edits update the same record, and deleting one deletes the Margin
// record (so it doesn't resurrect on the next poll).

/** Don't re-poll the PDS more than this often, however many surfaces ask. */
const POLL_INTERVAL_MS = 15 * 60 * 1000;

let lastPollAt = 0;
let inFlight: Promise<MarginImportResult | null> | null = null;

export interface MarginImportResult {
  imported: number;
  /** The poll hit the page cap — some Margin highlights weren't read yet. */
  truncated: boolean;
}

/**
 * Poll Margin and merge anything new into the highlight store. Minute-gated, so
 * every surface that cares can call it on mount. Returns null when it didn't
 * run (disabled, offline, or polled recently).
 */
export async function maybeImportMarginHighlights(
  options: { force?: boolean } = {}
): Promise<MarginImportResult | null> {
  if (!preferences.marginHighlightImport) return null;
  if (!syncStore.isOnline) return null;
  if (!options.force && Date.now() - lastPollAt < POLL_INTERVAL_MS) return null;
  // Concurrent callers (the list and the deck mount together) share one poll.
  if (inFlight) return inFlight;

  lastPollAt = Date.now();
  inFlight = (async () => {
    try {
      const { notes, truncated } = await api.listMarginHighlights();
      const groups = planMarginHighlightImport(
        notes,
        itemLabelsStore.allHighlights,
        savesStore.articles
      );

      let imported = 0;
      for (const group of groups) {
        // One union write per item, not per highlight — a heavily-annotated
        // article can arrive with dozens at once.
        await itemLabelsStore.addHighlights(group.itemKey, group.itemType, group.highlights);
        imported += group.highlights.length;
      }
      return { imported, truncated };
    } catch (error) {
      if (error instanceof ScopeUpgradeError) {
        // The grant lapsed — stop asking until the user turns it back on.
        preferences.setMarginHighlightImport(false);
        return null;
      }
      console.error('Failed to import Margin highlights:', error);
      // Let the next surface retry rather than sitting out the whole interval.
      lastPollAt = 0;
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Test seam: forget the poll gate. */
export function resetMarginHighlightImportGate(): void {
  lastPollAt = 0;
  inFlight = null;
}
