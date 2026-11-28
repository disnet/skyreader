// "Come back to this": the picker's state, so every surface that holds a save
// (or can make one) offers the same dialog (ResurfacePicker, mounted once in
// AppShell). The label itself lives in itemLabels (`getResurface`).
import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import type { SavedItem } from '$lib/types';
import { savedItemLabelKeys } from '$lib/utils/savedPile';
import { formatResurfaceDay, type ResurfaceProps } from '$lib/utils/resurface';

// A save made from the picker (a feed post, say) lands a moment later; wait for
// its row this long before giving up, as the Save panel does.
const SAVE_LANDING_MS = 8000;

export interface ResurfaceTarget {
  title: string;
  /** The save, once there is one. Read again after `save` runs. */
  getSave: () => SavedItem | undefined;
  /** Saves the item first, for one that isn't saved yet. */
  save?: () => void;
}

let target = $state<ResurfaceTarget | null>(null);

function waitForSave(t: ResurfaceTarget): Promise<SavedItem | undefined> {
  const started = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      const save = t.getSave();
      if (save || Date.now() - started > SAVE_LANDING_MS) resolve(save);
      else setTimeout(check, 100);
    };
    check();
  });
}

export const resurfaceStore = {
  get target() {
    return target;
  },

  /** When this save comes back, or null. */
  get(save: SavedItem): ResurfaceProps | null {
    return itemLabelsStore.getResurface(savedItemLabelKeys(save));
  },

  open(t: ResurfaceTarget) {
    target = t;
  },

  /** For a save the caller already holds. */
  openFor(save: SavedItem) {
    target = { title: save.title || save.url || 'Untitled', getSave: () => save };
  },

  close() {
    target = null;
  },

  /** Ask for the target to come back at `at`, saving it first if need be. */
  async set(t: ResurfaceTarget, at: number) {
    let save = t.getSave();
    const saving = !save && Boolean(t.save);
    if (saving) {
      t.save!();
      save = await waitForSave(t);
    }
    if (!save) {
      const id = toastStore.add('');
      toastStore.update(id, 'error', "Couldn't save it, so it can't come back yet");
      return;
    }
    await itemLabelsStore.setResurface(savedItemLabelKeys(save), at);
    const day = formatResurfaceDay(at, Date.now());
    const id = toastStore.add('');
    toastStore.update(
      id,
      'success',
      saving ? `Saved. It'll come back on ${day}.` : `It'll come back on ${day}.`
    );
  },

  async clear(save: SavedItem) {
    await itemLabelsStore.setResurface(savedItemLabelKeys(save), null);
  },
};
