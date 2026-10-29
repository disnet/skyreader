<script lang="ts">
  // "Add to collection" for one save, or for the Library's selection, mounted
  // once in AppShell and driven by shelfStore.pickerSaves, so every surface that
  // holds a save can offer it. Each checkbox applies at once (no confirm step):
  // membership is cheap to undo and the list is short. With several saves a
  // collection holding some of them shows mixed; ticking it files the rest,
  // unticking takes them all out. Making a collection here also files the saves.
  // Pinned collections come first, as on the Shelf's row.
  import Modal from '$lib/components/common/Modal.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { MAX_COLLECTION_ITEMS, shelfStore } from '$lib/stores/shelf.svelte';
  import type { ShelfCollection } from '$lib/types';
  import { pinnedFirst } from '$lib/utils/shelf';

  let saves = $derived(shelfStore.pickerSaves);
  let rkeys = $derived(new Set(saves?.map((s) => s.rkey) ?? []));
  let newName = $state('');
  let busy = $state(false);
  // More saves than any collection holds: say so up front rather than make an
  // empty collection and then refuse to fill it.
  let tooMany = $derived(rkeys.size > MAX_COLLECTION_ITEMS);

  /** How many of the saves this collection already holds. */
  function heldIn(collection: ShelfCollection): number {
    let n = 0;
    for (const item of collection.items) if (rkeys.has(item.rkey)) n++;
    return n;
  }

  /** Why the rest of the saves can't go in, or null when they fit. */
  function fullNote(collection: ShelfCollection, held: number): string | null {
    const missing = rkeys.size - held;
    if (missing === 0) return null;
    const room = shelfStore.roomIn(collection.id);
    if (missing <= room) return null;
    return room === 0 ? 'Full' : `Room for ${room.toLocaleString()}`;
  }

  async function toggle(collection: ShelfCollection, input: HTMLInputElement) {
    if (!saves || busy) return;
    busy = true;
    try {
      if (heldIn(collection) === rkeys.size) {
        await shelfStore.removeItems(collection.id, [...rkeys]);
      } else {
        await shelfStore.addItems(collection.id, saves);
      }
    } finally {
      busy = false;
      // A refused change leaves the store as it was, so nothing re-renders the
      // box the browser already flipped: put it back to what's true.
      const held = heldIn(collection);
      input.checked = held > 0 && held === rkeys.size;
      input.indeterminate = held > 0 && held < rkeys.size;
    }
  }

  async function createAndAdd(e: SubmitEvent) {
    e.preventDefault();
    // Not while collections load: the fresh list would replace the new one.
    if (!saves || busy || tooMany || shelfStore.loading || !newName.trim()) return;
    busy = true;
    try {
      const id = await shelfStore.create(newName);
      if (id) {
        newName = '';
        await shelfStore.addItems(id, saves);
      }
    } finally {
      busy = false;
    }
  }

  function close() {
    newName = '';
    shelfStore.closePicker();
  }
</script>

<Modal open={saves !== null} onclose={close} title="Add to collection" maxWidth="400px">
  {#if saves}
    <p class="subject">
      {#if saves.length === 1}
        {saves[0].title || saves[0].url || 'Untitled'}
      {:else}
        {saves.length.toLocaleString()} items
      {/if}
    </p>

    {#if shelfStore.collections.length > 0}
      <ul class="list">
        {#each pinnedFirst(shelfStore.collections) as collection (collection.id)}
          {@const held = heldIn(collection)}
          {@const note = fullNote(collection, held)}
          <li>
            <label class="row" class:full={note !== null}>
              <input
                type="checkbox"
                checked={held > 0 && held === rkeys.size}
                indeterminate={held > 0 && held < rkeys.size}
                disabled={busy || !shelfStore.canWrite || (held === 0 && note !== null)}
                onchange={(e) => toggle(collection, e.currentTarget)}
              />
              <span class="name">{collection.name}</span>
              {#if note}<span class="count full-note">{note}</span>{/if}
              <span class="count">{collection.items.length.toLocaleString()}</span>
            </label>
          </li>
        {/each}
      </ul>
    {:else if !shelfStore.loading}
      <p class="empty">No collections yet. Name one to start.</p>
    {/if}

    <form class="new" onsubmit={createAndAdd}>
      <Icon name="folder-plus" size={16} />
      <input
        class="new-input"
        type="text"
        placeholder="New collection"
        maxlength="100"
        bind:value={newName}
        disabled={busy || tooMany || shelfStore.loading || !shelfStore.canWrite}
      />
      <button
        type="submit"
        class="new-btn"
        disabled={busy || tooMany || shelfStore.loading || !newName.trim()}>Add</button
      >
    </form>

    {#if tooMany}
      <p class="note">
        A collection holds up to {MAX_COLLECTION_ITEMS.toLocaleString()} items. Select fewer to add them.
      </p>
    {/if}

    {#if !shelfStore.canWrite}
      <p class="note">Collections need an account and a connection.</p>
    {/if}
  {/if}
</Modal>

<style>
  .subject {
    margin: 0 0 0.75rem;
    font-size: var(--text-md);
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .list {
    list-style: none;
    margin: 0 0 0.75rem;
    padding: 0;
    max-height: 50vh;
    overflow-y: auto;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.5rem 0.25rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: var(--text-md);
    color: var(--color-text);
  }

  .row:hover {
    background: var(--color-bg-secondary);
  }

  .row input {
    accent-color: var(--color-primary);
    margin: 0;
  }

  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .count {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .row.full {
    cursor: default;
  }

  .empty,
  .note {
    margin: 0 0 0.75rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .note {
    margin: 0.75rem 0 0;
  }

  .new {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--color-text-secondary);
    border-top: 1px solid var(--color-border);
    padding-top: 0.75rem;
  }

  .new-input {
    flex: 1;
    min-width: 0;
    padding: 0.4rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font-size: var(--text-md);
    background: var(--color-bg);
    color: var(--color-text);
  }

  .new-input:focus {
    outline: none;
    border-color: var(--color-primary);
  }

  .new-btn {
    padding: 0.4rem 0.75rem;
    border: none;
    border-radius: 6px;
    background: var(--color-primary);
    color: #fff;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    cursor: pointer;
  }

  .new-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* iOS Safari zooms the viewport when a focused input is smaller than 16px. */
  @media (hover: none) and (pointer: coarse) {
    .new-input {
      font-size: 1rem;
    }
  }
</style>
