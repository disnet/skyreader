import { api, ScopeUpgradeError } from '$lib/services/api';
import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
import { preferences } from '$lib/stores/preferences.svelte';
import { savesStore } from '$lib/stores/saves.svelte';
import { syncStore } from '$lib/stores/sync.svelte';
import {
  planMarginHighlightImport,
  planMarginHighlightRekeys,
  type MarginImportOutcome,
} from '$lib/utils/marginHighlightImport';

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
let inFlight: Promise<MarginImportOutcome> | null = null;
let lastTruncated = false;

export type { MarginImportOutcome };

/**
 * Poll Margin and merge anything new into the highlight store. Minute-gated, so
 * every surface that cares can call it on mount. Every non-import outcome says
 * which one it was, so a surface can tell "polled recently" from "your Margin
 * grant lapsed" instead of blaming the network for both.
 */
export async function maybeImportMarginHighlights(
  options: { force?: boolean } = {}
): Promise<MarginImportOutcome> {
  if (!preferences.marginHighlightImport) {
    // Nothing is being imported, so nothing is partial.
    lastTruncated = false;
    return { status: 'skipped', reason: 'disabled' };
  }
  if (!syncStore.isOnline) return { status: 'skipped', reason: 'offline' };

  // The import unions against the highlights it can see and writes the result
  // back as the item's whole set, so running before the local read has landed
  // would import against an empty corpus and overwrite an item's existing
  // highlights with only the imported ones.
  //
  // The gate lives here rather than in each caller because every caller shares
  // one in-flight poll, so a single ungated one defeats everybody else's gate —
  // which is exactly how the settings toggle got past it. It sits above the
  // interval stamp so a skipped attempt doesn't burn the next fifteen minutes:
  // whichever surface is waiting on the stores will call again once they land.
  if (itemLabelsStore.isLoading || savesStore.loading) {
    return { status: 'skipped', reason: 'stores-loading' };
  }

  // Concurrent callers share one poll. This has to sit above the interval gate,
  // not below it: `lastPollAt` is stamped before the request goes out, so a
  // second caller arriving while the first is still in flight would otherwise be
  // told it was throttled and go on to report a stale `truncated`, skip its
  // redeal, or — from the settings toggle — say Margin was unreachable while the
  // poll it should have joined was succeeding.
  if (inFlight) return inFlight;

  if (!options.force && Date.now() - lastPollAt < POLL_INTERVAL_MS) {
    return { status: 'skipped', reason: 'throttled' };
  }

  lastPollAt = Date.now();
  inFlight = (async (): Promise<MarginImportOutcome> => {
    try {
      const { notes, truncated } = await api.listMarginHighlights();
      lastTruncated = truncated;

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

      // Notes imported before their article was saved landed on a URL key. Now
      // that the server can join them to a save, move them onto it. Read the
      // corpus again rather than reusing the snapshot above: the writes just
      // made are part of what may need moving.
      const rekeys = planMarginHighlightRekeys(
        notes,
        itemLabelsStore.allHighlights,
        savesStore.articles
      );
      for (const group of rekeys) {
        // Add before remove. Interrupted halfway, a duplicate is visible and
        // heals on the next poll; the other order can lose the only copy.
        await itemLabelsStore.addHighlights(group.to, group.itemType, group.highlights);
        for (const highlight of group.highlights) {
          await itemLabelsStore.removeHighlight(group.from, highlight.id);
        }
      }

      return { status: 'imported', imported, truncated };
    } catch (error) {
      if (error instanceof ScopeUpgradeError) {
        // The grant lapsed — stop asking until the user turns it back on, and
        // say so, so the surface that asked doesn't call it a network blip.
        preferences.setMarginHighlightImport(false);
        return { status: 'scope-expired' };
      }
      console.error('Failed to import Margin highlights:', error);
      // Let the next surface retry rather than sitting out the whole interval.
      lastPollAt = 0;
      return { status: 'failed' };
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Did the last poll that actually reached the PDS hit the page cap?
 *
 * Kept here rather than read off a single call's return, because most calls
 * short-circuit on the interval gate — and the corpus is no less partial for
 * some other surface having done the fetching. Without this, the notice on
 * `/highlights` would stay hidden in exactly the case it exists for.
 */
export function marginImportTruncated(): boolean {
  return lastTruncated;
}

/** Test seam: forget the poll gate. */
export function resetMarginHighlightImportGate(): void {
  lastPollAt = 0;
  inFlight = null;
  lastTruncated = false;
}
