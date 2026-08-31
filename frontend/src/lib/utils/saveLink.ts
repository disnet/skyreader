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

/** Toggle `url` in and out of Saved. Resolves once the list reflects the change. */
export async function toggleSavedLink(url: string): Promise<void> {
  const existing = savesStore.getByUrl(url);
  try {
    if (existing) await savesStore.remove(existing.rkey);
    else await savesStore.saveFromUrl(url);
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
      return;
    }
    const id = toastStore.add(existing ? 'Could not remove that save' : 'Could not save that');
    toastStore.update(id, 'error');
  }
}
