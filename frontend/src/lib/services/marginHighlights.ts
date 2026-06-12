import { api, ScopeUpgradeError } from '$lib/services/api';
import { syncQueue, type MarginNotePayload } from '$lib/services/sync-queue';
import { syncStore } from '$lib/stores/sync.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
import type { Highlight } from '$lib/types';

// Shared Margin (at.margin.note) sync for highlights. Used both by the in-reader
// highlight popover (useHighlights) and the standalone Highlights view, so the
// dedup-key format and note payload stay identical across the two write paths —
// otherwise an offline save queued from one and deleted from the other could
// orphan a note on the PDS.

export function marginDedupKey(itemKey: string, highlightId: string): string {
  return `margin-note:${itemKey}:${highlightId}`;
}

function notePayload(
  itemKey: string,
  highlight: Highlight,
  source: string,
  title: string | undefined,
  rkey?: string
): MarginNotePayload {
  return {
    kind: 'note',
    itemKey,
    highlightId: highlight.id,
    source,
    title,
    exact: highlight.selector.exact,
    prefix: highlight.selector.prefix,
    suffix: highlight.selector.suffix,
    note: highlight.note,
    ...(rkey ? { rkey } : {}),
  };
}

/**
 * Push a single highlight to the user's Margin (at.margin.note) and record the
 * resulting uri/rkey locally. No-op if it's already saved. Surfaces progress via
 * toasts and falls back to the offline sync queue. Returns true once the highlight
 * is saved (or queued), false on a hard failure (e.g. missing source URL).
 */
export async function saveHighlightToMargin(
  itemKey: string,
  highlight: Highlight,
  source: string | null | undefined,
  title?: string
): Promise<boolean> {
  if (highlight.marginUri) return true; // already saved
  if (!source) {
    const id = toastStore.add('No article URL to save to Margin');
    toastStore.update(id, 'error');
    return false;
  }

  if (!syncStore.isOnline) {
    await syncQueue.enqueue('create', 'integration', marginDedupKey(itemKey, highlight.id), {
      ...notePayload(itemKey, highlight, source, title),
      source,
    });
    const id = toastStore.add('Queued save to Margin');
    toastStore.update(id, 'success');
    return true;
  }

  const id = toastStore.add('Saving to Margin...');
  try {
    const result = await api.createMarginNote({
      source,
      title,
      exact: highlight.selector.exact,
      prefix: highlight.selector.prefix,
      suffix: highlight.selector.suffix,
      note: highlight.note,
    });
    await itemLabelsStore.setHighlightMargin(itemKey, highlight.id, {
      uri: result.uri,
      rkey: result.rkey,
    });
    toastStore.update(id, 'success', 'Saved to Margin');
    return true;
  } catch (err) {
    if (err instanceof ScopeUpgradeError) {
      toastStore.update(id, 'error', 'Log in again to grant Margin permissions');
      return false;
    }
    console.error('Failed to save highlight to Margin, queueing:', err);
    await syncQueue.enqueue('create', 'integration', marginDedupKey(itemKey, highlight.id), {
      ...notePayload(itemKey, highlight, source, title),
      source,
    });
    toastStore.update(id, 'success', 'Queued save to Margin');
    return true;
  }
}

/**
 * Delete the Margin note backing a highlight (if any). Cancels any still-queued
 * save first so it can't create an orphan note. Does NOT remove the local
 * highlight — pair with {@link itemLabelsStore.removeHighlight} (see
 * {@link deleteHighlight}).
 */
export async function removeHighlightFromMargin(
  itemKey: string,
  highlight: Highlight
): Promise<void> {
  // Drop any still-queued (unsynced) save so it never creates an orphan note.
  await syncQueue.cancelPending('integration', marginDedupKey(itemKey, highlight.id));
  if (!highlight.marginRkey) return; // never synced — nothing on the PDS

  if (!syncStore.isOnline) {
    await syncQueue.enqueue(
      'delete',
      'integration',
      marginDedupKey(itemKey, highlight.id),
      notePayload(itemKey, highlight, highlight.marginUri ?? '', undefined, highlight.marginRkey)
    );
    return;
  }
  try {
    await api.deleteMarginNote(highlight.marginRkey);
  } catch (err) {
    console.error('Failed to delete Margin note, queueing:', err);
    await syncQueue.enqueue(
      'delete',
      'integration',
      marginDedupKey(itemKey, highlight.id),
      notePayload(itemKey, highlight, highlight.marginUri ?? '', undefined, highlight.marginRkey)
    );
  }
}

/**
 * Update the note body on an already-synced Margin note (same rkey). The passed
 * highlight must carry the new `note` value. No-op if the highlight was never
 * pushed to Margin. Falls back to the offline sync queue. Returns true once the
 * update is applied (or queued).
 */
export async function updateHighlightNoteOnMargin(
  itemKey: string,
  highlight: Highlight,
  source: string | null | undefined,
  title?: string
): Promise<boolean> {
  if (!highlight.marginRkey) return true; // not on the PDS — nothing to update
  if (!source) return false;

  if (!syncStore.isOnline) {
    await syncQueue.enqueue(
      'update',
      'integration',
      marginDedupKey(itemKey, highlight.id),
      notePayload(itemKey, highlight, source, title, highlight.marginRkey)
    );
    return true;
  }

  try {
    await api.updateMarginNote(highlight.marginRkey, {
      source,
      title,
      exact: highlight.selector.exact,
      prefix: highlight.selector.prefix,
      suffix: highlight.selector.suffix,
      note: highlight.note,
    });
    return true;
  } catch (err) {
    console.error('Failed to update Margin note, queueing:', err);
    await syncQueue.enqueue(
      'update',
      'integration',
      marginDedupKey(itemKey, highlight.id),
      notePayload(itemKey, highlight, source, title, highlight.marginRkey)
    );
    return true;
  }
}

/**
 * Remove a highlight entirely: delete its Margin note (if synced) and drop the
 * local record.
 */
export async function deleteHighlight(itemKey: string, highlight: Highlight): Promise<void> {
  await removeHighlightFromMargin(itemKey, highlight);
  await itemLabelsStore.removeHighlight(itemKey, highlight.id);
}
