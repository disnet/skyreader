/**
 * The Save control's panel (Shelf and collections), shared by the card and the
 * reader: Save opens it, saving first when the item isn't saved yet, and the
 * split control's toggle saves or unsaves and puts the panel away.
 */

// Save was pressed and its row hasn't landed yet: the panel says "Saving…"
// instead of reading the gap as an unsave and closing. Bounded, so a save that
// never lands (refused, queued offline) doesn't hold the panel open.
const SAVE_LANDING_MS = 8000;

export interface SavePanelOptions {
  isSaved: () => boolean;
  /** The save as a row the panel can file, once it has landed. */
  shelfSave: () => unknown;
  onToggleSave: () => (() => void) | undefined;
  /** Whether pressing Save opens the panel, rather than only toggling. */
  opensPanel: () => boolean;
  /** Focuses the Save control: Remove takes the panel, and its button, away. */
  focusControl: () => void;
}

export function useSavePanel(options: SavePanelOptions) {
  let open = $state(false);
  let landing = $state(false);

  $effect(() => {
    if (!landing) return;
    if (options.shelfSave()) {
      landing = false;
      return;
    }
    const timer = setTimeout(() => (landing = false), SAVE_LANDING_MS);
    return () => clearTimeout(timer);
  });
  // Unsaved some other way (the `s` key, another device), or the save never
  // landed: nothing left to file.
  $effect(() => {
    if (open && !options.shelfSave() && !landing) open = false;
  });

  return {
    get open() {
      return open;
    },

    /** Save, or the split control's arrow: opens the panel, or puts it away. */
    press() {
      if (open) {
        open = false;
        return;
      }
      const onToggleSave = options.onToggleSave();
      if (!options.opensPanel()) {
        onToggleSave?.();
        return;
      }
      if (!options.isSaved() && onToggleSave) {
        landing = true;
        onToggleSave();
      }
      open = true;
    },

    /** The split Save's toggle: an unsave leaves the panel nothing to file. */
    toggle() {
      open = false;
      landing = false;
      options.onToggleSave()?.();
    },

    /** The panel's Remove. */
    unsave() {
      open = false;
      options.onToggleSave()?.();
      options.focusControl();
    },

    close() {
      open = false;
    },

    /** The control the panel hung from is gone, or holds another item now. */
    reset() {
      open = false;
      landing = false;
    },
  };
}
