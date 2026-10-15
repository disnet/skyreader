<script lang="ts">
  // "Add to collection" for one save, mounted once in AppShell and driven by
  // shelfStore.pickerSave, so every surface that holds a save can offer it.
  // Each checkbox applies at once (no confirm step): membership is cheap to undo
  // and the list is short. Making a collection here also files the save in it.
  import Modal from '$lib/components/common/Modal.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { shelfStore } from '$lib/stores/shelf.svelte';

  let save = $derived(shelfStore.pickerSave);
  let memberOf = $derived(new Set(save ? shelfStore.collectionIdsFor(save) : []));
  let newName = $state('');
  let busy = $state(false);

  async function toggle(id: string) {
    if (!save || busy) return;
    busy = true;
    try {
      if (memberOf.has(id)) await shelfStore.removeItem(id, save.rkey);
      else await shelfStore.addItem(id, save);
    } finally {
      busy = false;
    }
  }

  async function createAndAdd(e: SubmitEvent) {
    e.preventDefault();
    if (!save || busy || !newName.trim()) return;
    busy = true;
    try {
      const id = await shelfStore.create(newName);
      if (id) {
        newName = '';
        await shelfStore.addItem(id, save);
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

<Modal open={save !== null} onclose={close} title="Add to collection" maxWidth="400px">
  {#if save}
    <p class="subject">{save.title || save.url || 'Untitled'}</p>

    {#if shelfStore.collections.length > 0}
      <ul class="list">
        {#each shelfStore.collections as collection (collection.id)}
          <li>
            <label class="row">
              <input
                type="checkbox"
                checked={memberOf.has(collection.id)}
                disabled={busy || !shelfStore.canWrite}
                onchange={() => toggle(collection.id)}
              />
              <span class="name">{collection.name}</span>
              <span class="count">{collection.items.length}</span>
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
        disabled={busy || !shelfStore.canWrite}
      />
      <button type="submit" class="new-btn" disabled={busy || !newName.trim()}>Add</button>
    </form>

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
