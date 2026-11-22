// Save an arbitrary web URL into the reader's own Saved list, from anywhere a
// link to someone else's article shows up (a Semble connection, a link menu).
//
// Saving fetches and extracts the article first, so it is genuinely slow enough
// to need a pending state — callers hold one while this runs. Success is visible
// in the control itself (the bookmark fills), so only the failure has to say
// anything; a toast for the happy path would be noise on a reading surface.
import { savesStore } from '$lib/stores/saves.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import { UrlSaveLimitError } from '$lib/services/api';
import { saveLimitLine } from '$lib/utils/limitCopy';
import { failedSaveLine, blockedSaveAction, extensionCanHelp } from '$lib/utils/saveAnywhere';

/** Toggle `url` in and out of Saved. Resolves once the list reflects the change. */
export async function toggleSavedLink(url: string, title?: string): Promise<void> {
  const existing = savesStore.getByUrl(url);
  if (!existing) {
    await saveLink(url, { title });
    return;
  }
  try {
    await savesStore.remove(existing.rkey);
  } catch {
    const id = toastStore.add('Could not remove that save');
    toastStore.update(id, 'error');
  }
}

/**
 * Save `url`, saying so only when something went wrong. `from` is the article
 * it was saved out of, kept as where the save came from. Resolves true once
 * the save is in the list.
 */
export async function saveLink(
  url: string,
  hint: { title?: string; from?: { url: string; title?: string } } = {}
): Promise<boolean> {
  try {
    const saved = await savesStore.saveFromUrl(url, hint);
    // The article couldn't be fetched, so only the link was kept. That is
    // worth a word — the bookmark filling alone would promise the full text —
    // and the way to get the text is the same one a blocked save always offered.
    if (saved.fetchFailed) {
      const id = toastStore.add(failedSaveLine(saved.fetchFailed));
      toastStore.update(
        id,
        'success',
        undefined,
        extensionCanHelp(saved.fetchFailed) ? blockedSaveAction() : undefined
      );
    }
    return true;
  } catch (err) {
    // The monthly save cap is a different kind of failure from "that didn't
    // work": it has a reason, a reset date, and something the reader can do
    // about it, so it gets the real sentence and a way out.
    if (err instanceof UrlSaveLimitError) {
      const id = toastStore.add(saveLimitLine(err.limit, err.resetsAt));
      toastStore.update(id, 'error', undefined, {
        label: 'Become a Supporter',
        href: '/supporter',
      });
      return false;
    }
    const id = toastStore.add('Could not save that');
    toastStore.update(id, 'error');
    return false;
  }
}
