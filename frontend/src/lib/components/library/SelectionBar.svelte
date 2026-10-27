<script lang="ts">
  // The Library's select mode, as a bar floating over the list: how many are
  // selected, Select all over the whole list in view (every page, not only the
  // ones scrolled into view), and what to do with them. Collections are the bulk
  // edit: "Add to collection" opens the same picker an item's menu does, for the
  // whole selection; in a collection, "Remove" takes the selection out of it.
  // "Delete" deletes the selected saves themselves, after a confirm. In the
  // Queue's Inbox, "Archive" archives them, as an item's own Archive does.
  import { onMount } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { librarySelection } from '$lib/stores/librarySelection.svelte';
  import { shelfStore } from '$lib/stores/shelf.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { saveBackingStore } from '$lib/stores/saveBacking.svelte';
  import { archiveSaves } from '$lib/stores/feedView.svelte';
  import type { SavedItem, ShelfCollection } from '$lib/types';

  interface Props {
    /** Every save the list in view holds, in its order. */
    saves: SavedItem[];
    /** The collection the list is, when it's one: offers Remove from it. */
    collection?: ShelfCollection | null;
    /** Offer Archive: the Queue's Inbox, where everything listed is unarchived. */
    archivable?: boolean;
  }

  let { saves, collection = null, archivable = false }: Props = $props();

  let selected = $derived(librarySelection.selectedIn(saves));
  let allSelected = $derived(saves.length > 0 && selected.length === saves.length);
  let busy = $state(false);

  async function removeFromCollection() {
    if (!collection || selected.length === 0 || busy) return;
    busy = true;
    try {
      const ok = await shelfStore.removeItems(
        collection.id,
        selected.map((s) => s.rkey)
      );
      if (ok) librarySelection.clear();
    } finally {
      busy = false;
    }
  }

  async function archiveSelected() {
    if (selected.length === 0 || busy) return;
    busy = true;
    const chosen = selected;
    const what = chosen.length === 1 ? '1 item' : `${chosen.length.toLocaleString()} items`;
    const toast = toastStore.add(`Archiving ${what}…`);
    try {
      await archiveSaves(chosen);
      // Only what was archived: the reader may have started another selection.
      librarySelection.deselect(chosen.map((s) => s.rkey));
      toastStore.update(toast, 'success', `Archived ${what}`);
    } finally {
      busy = false;
    }
  }

  async function deleteSelected() {
    if (selected.length === 0 || busy) return;
    busy = true;
    // What's selected now is what the confirm names and what gets deleted.
    const rkeys = selected.map((s) => s.rkey);
    const n = rkeys.length;
    const what = n === 1 ? '1 item' : `${n.toLocaleString()} items`;
    try {
      // With Semble or Margin backing the Saved list is that public collection,
      // so a delete reaches it too: say so before it happens (waiting for the
      // lookup if it hasn't come back yet).
      if (!saveBackingStore.loaded) await saveBackingStore.load();
      const provider = saveBackingStore.backing?.provider;
      const backedBy = provider === 'semble' ? 'Semble' : provider === 'margin' ? 'Margin' : null;
      const ok = confirm(
        `Delete ${what} from your Library?` +
          (backedBy
            ? `\n\n${n === 1 ? 'It also comes' : 'They also come'} out of your ${backedBy} collection.`
            : '') +
          `\n\nThis can't be undone.`
      );
      if (!ok) return;
      const toast = toastStore.add(`Deleting ${what}…`);
      await savesStore.removeMany(rkeys, (done) => {
        if (n > 1)
          toastStore.update(toast, 'pending', `Deleting ${what}… ${done.toLocaleString()} done`);
      });
      shelfStore.forgetSaves(rkeys);
      // Only what was deleted: the reader may have started another selection.
      librarySelection.deselect(rkeys);
      toastStore.update(toast, 'success', n === 1 ? 'Deleted 1 item' : `Deleted ${what}`);
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    // The picker lists collections; have them ready before it opens.
    void shelfStore.load();
    // Delete's confirm names the backing collection, when there is one.
    void saveBackingStore.load();
    // Escape ends select mode only when nothing else claims it. Whether a dialog
    // (the picker) was open is noted in the capture phase, before its own
    // handler closes it; the decision waits for the bubble phase, so a handler
    // that takes the key (the saved search, a menu) can preventDefault first.
    let dialogOpen = false;
    const noteDialog = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dialogOpen = Boolean(shelfStore.pickerSaves || document.querySelector('[role="dialog"]'));
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || dialogOpen) return;
      librarySelection.end();
    };
    window.addEventListener('keydown', noteDialog, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', noteDialog, true);
      window.removeEventListener('keydown', onKey);
    };
  });
</script>

<div class="selection-bar" role="toolbar" aria-label="Selection">
  <span class="count" aria-live="polite">
    {selected.length === 0 ? 'Select items' : `${selected.length.toLocaleString()} selected`}
  </span>
  <button
    class="text-btn"
    onclick={() => (allSelected ? librarySelection.clear() : librarySelection.selectAll(saves))}
    disabled={saves.length === 0}
  >
    {#if allSelected}Select none{:else}Select all<span class="all-count">
        {saves.length.toLocaleString()}</span
      >{/if}
  </button>
  <span class="spacer"></span>
  {#if collection}
    <button
      class="action-btn"
      onclick={removeFromCollection}
      disabled={selected.length === 0 || busy || !shelfStore.canWrite}
      title={`Remove from “${collection.name}”`}
    >
      <Icon name="minus" size={14} />
      Remove
    </button>
  {/if}
  {#if archivable}
    <button class="action-btn" onclick={archiveSelected} disabled={selected.length === 0 || busy}>
      <Icon name="archive" size={14} />
      Archive
    </button>
  {/if}
  <button
    class="action-btn danger"
    onclick={deleteSelected}
    disabled={selected.length === 0 || busy}
    aria-label="Delete"
  >
    <Icon name="trash" size={14} />
    <span class="long">Delete</span>
  </button>
  <button
    class="action-btn primary"
    onclick={() => shelfStore.openPicker(selected)}
    disabled={selected.length === 0 || busy}
  >
    <Icon name="folder-plus" size={14} />
    <span class="long">Add to collection</span><span class="short">Add</span>
  </button>
  <button class="icon-btn" onclick={() => librarySelection.end()} aria-label="Done selecting">
    <Icon name="x" size={16} />
  </button>
</div>

<style>
  /* Floats over the list (one of the few things here with a shadow: it overlaps
     what scrolls under it), above the phone's bottom bar. */
  .selection-bar {
    position: fixed;
    left: 50%;
    bottom: calc(1rem + var(--safe-area-bottom));
    z-index: 20;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: min(40rem, calc(100vw - 2rem));
    box-sizing: border-box;
    padding: 0.5rem 0.5rem 0.5rem 1rem;
    border: 1px solid var(--color-border);
    border-radius: 10px;
    background: var(--color-bg);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
    font-size: var(--text-sm);
  }

  .count {
    font-weight: var(--weight-medium);
    color: var(--color-text);
    white-space: nowrap;
  }

  .spacer {
    flex: 1;
  }

  .text-btn,
  .action-btn,
  .icon-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    border: none;
    border-radius: 6px;
    background: none;
    font: inherit;
    white-space: nowrap;
    cursor: pointer;
  }

  .text-btn {
    padding: 0.375rem 0.25rem;
    color: var(--color-primary);
  }

  .action-btn {
    padding: 0.4rem 0.75rem;
    border: 1px solid var(--color-border);
    color: var(--color-text);
  }

  .action-btn.danger {
    color: var(--color-error);
  }

  .action-btn.primary {
    border-color: var(--color-primary);
    background: var(--color-primary);
    color: #fff;
  }

  .icon-btn {
    padding: 0.375rem;
    color: var(--color-text-secondary);
  }

  .text-btn:hover:not(:disabled) {
    text-decoration: underline;
  }

  .action-btn:not(.primary):hover:not(:disabled),
  .icon-btn:hover {
    background: var(--color-bg-secondary);
  }

  button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  button:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  @media (max-width: 1000px) {
    .selection-bar {
      bottom: calc(var(--bottom-bar-height) + var(--safe-area-bottom) + 0.75rem);
    }
  }

  .short {
    display: none;
  }

  /* A phone: shorter words, no icons (Delete keeps its trash can, and only
     that), and a second line when
     the actions don't fit (a collection's Remove, or the Inbox's Archive, with
     Delete and Add). */
  @media (max-width: 30rem) {
    .selection-bar {
      gap: 0.375rem;
      padding-left: 0.75rem;
    }

    .all-count,
    .long,
    .action-btn:not(.danger) :global(svg) {
      display: none;
    }

    .short {
      display: inline;
    }

    .action-btn {
      padding: 0.4rem 0.625rem;
    }
  }

  @media (max-width: 30rem) {
    .selection-bar {
      flex-wrap: wrap;
      row-gap: 0.25rem;
    }
  }

  @media (prefers-color-scheme: dark) {
    .selection-bar {
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    }
  }
</style>
