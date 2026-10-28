import { api, ScopeUpgradeError } from '$lib/services/api';
import { auth } from '$lib/stores/auth.svelte';
import { marginSyncStore } from '$lib/stores/marginSync.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
import { preferences } from '$lib/stores/preferences.svelte';
import { savesStore } from '$lib/stores/saves.svelte';
import { syncStore } from '$lib/stores/sync.svelte';
import { syncQueue } from '$lib/services/sync-queue';
import { marginRkeysWrittenSince } from '$lib/services/marginWrites';
import { updateHighlightNoteOnMargin } from '$lib/services/marginHighlights';
import {
  planMarginHighlightImport,
  planMarginHighlightRekeys,
  planMarginHighlightSync,
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
//
// Each poll also syncs the other way for every highlight linked to a Margin note,
// imported or published from here: a note edited on Margin updates the
// highlight, and one deleted on Margin removes an imported highlight or
// unpublishes one made here (see planMarginHighlightSync).

/** A Margin write started this long before a listing may still be missing from it. */
const WRITE_SETTLE_MS = 60 * 1000;

/** Don't re-poll the PDS more than this often, however many surfaces ask. */
const POLL_INTERVAL_MS = 15 * 60 * 1000;

let lastPollAt = 0;
let inFlight: Promise<MarginImportOutcome> | null = null;

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
    marginSyncStore.clearTruncated();
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
  const did = auth.user?.did;
  marginSyncStore.started();
  inFlight = (async (): Promise<MarginImportOutcome> => {
    try {
      // What every highlight looked like as the listing was asked for. A note
      // edited here while it was out may not have reached Margin in time to be
      // in it, and reading the listing back would undo that edit.
      const before = new Map(
        itemLabelsStore.allHighlights.map(({ highlight }) => [highlight.id, highlight])
      );
      const listedAt = Date.now();
      // A write still queued now may drain while the listing is out, and then
      // be gone from the queue by the time it lands: ask before and after.
      const pendingBefore = await syncQueue.pendingMarginNoteHighlightIds();
      const listing = await api.listMarginHighlights();
      const { notes, truncated } = listing;

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

      // Last, so it sees every highlight in its final home. Read the queue now,
      // not before the fetch: a write queued while it was out is just as much
      // the reader's change.
      const pending = await syncQueue.pendingMarginNoteHighlightIds();
      for (const id of pendingBefore) pending.add(id);
      // Switched off (or signed out) while the listing was out: an import is
      // harmless to finish, but removals are not something to do unasked.
      const accountChanged = Boolean(
        listing.did && auth.user?.did && listing.did !== auth.user.did
      );
      if (!preferences.marginHighlightImport || auth.isGuest || accountChanged) {
        return { status: 'imported', imported, updated: 0, removed: 0, unpublished: 0, truncated };
      }
      const changes = planMarginHighlightSync(
        // Date rkeys by the server's clock when it says; ours may be off.
        { ...listing, listedAt: listing.listedAt ?? listedAt },
        itemLabelsStore.allHighlights,
        // A write sent just before the listing may not be in it yet.
        { ids: pending, rkeys: marginRkeysWrittenSince(listedAt - WRITE_SETTLE_MS) },
        before
      );
      let updated = 0;
      let removed = 0;
      let unpublished = 0;
      // Note changes ride one write per item, like the import: a first poll
      // after this shipped records Margin's note on every linked highlight.
      const synced = new Map<
        string,
        Parameters<typeof itemLabelsStore.setHighlightsMarginSynced>[1]
      >();
      for (const change of changes) {
        if (change.kind === 'note' || change.kind === 'synced') {
          const entries = synced.get(change.itemKey) ?? [];
          entries.push({
            highlightId: change.highlightId,
            rkey: change.rkey,
            note: change.note,
            applyNote: change.kind === 'note',
          });
          synced.set(change.itemKey, entries);
          if (change.kind === 'note') updated++;
        } else if (change.kind === 'push') {
          const highlight = itemLabelsStore
            .getHighlights(change.itemKey)
            .find((h) => h.id === change.highlightId);
          if (highlight) {
            await updateHighlightNoteOnMargin(
              change.itemKey,
              highlight,
              change.source,
              change.title
            );
          }
        } else if (change.kind === 'remove') {
          // Only the local copy: the note is already gone from Margin.
          await itemLabelsStore.removeHighlight(change.itemKey, change.highlightId);
          removed++;
        } else {
          await itemLabelsStore.setHighlightMargin(change.itemKey, change.highlightId, null);
          unpublished++;
        }
      }
      for (const [itemKey, entries] of synced) {
        await itemLabelsStore.setHighlightsMarginSynced(itemKey, entries);
      }

      announceRemovals(removed, unpublished);
      return { status: 'imported', imported, updated, removed, unpublished, truncated };
    } catch (error) {
      if (error instanceof ScopeUpgradeError) {
        // The grant lapsed — stop asking until the user turns it back on, and
        // say so, so the surface that asked doesn't call it a network blip.
        // The api's scope-upgrade banner says so wherever the reader is (the
        // poll runs app-wide); the sync line on /highlights and in Settings
        // says what stopped.
        preferences.setMarginHighlightImport(false);
        marginSyncStore.markLapsed();
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
  void inFlight.then((outcome) => {
    if (outcome.status === 'scope-expired') return;
    marginSyncStore.finished(did, outcome.status === 'imported' ? outcome : null);
  });

  return inFlight;
}

/**
 * Highlights don't vanish without a word. A note edit taken from Margin
 * explains itself on sight; a highlight gone from the list, or one that
 * stopped reading "On Margin", doesn't.
 */
function announceRemovals(removed: number, unpublished: number): void {
  const parts: string[] = [];
  if (removed > 0) {
    parts.push(
      `${removed} highlight${removed === 1 ? '' : 's'} deleted on Margin ${
        removed === 1 ? 'was' : 'were'
      } removed`
    );
  }
  if (unpublished > 0) {
    parts.push(
      `${unpublished} highlight${unpublished === 1 ? '' : 's'} deleted on Margin ${
        unpublished === 1 ? 'is' : 'are'
      } now private here`
    );
  }
  if (parts.length === 0) return;
  // A sentence about something that happened off-screen needs reading time.
  const id = toastStore.add(parts.join('. '));
  toastStore.update(id, 'success', undefined, undefined, 6000);
}

/** Test seam: forget the poll gate. */
export function resetMarginHighlightImportGate(): void {
  lastPollAt = 0;
  inFlight = null;
  marginSyncStore.clearTruncated();
}
