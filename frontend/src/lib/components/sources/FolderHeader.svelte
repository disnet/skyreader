<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';
  import { folderTarget } from '$lib/utils/folders';

  // A folder's heading on the Sources page, with Rename. Renaming to another
  // folder's name (in any case) merges the two, and the form says so first.
  interface Props {
    name: string;
    /** Sources shown under this heading. */
    count: number;
    /** Every folder the reader has, with how many sources each holds. */
    folders: Map<string, number>;
    onRename: (to: string) => Promise<void>;
  }

  let { name, count, folders, onRename }: Props = $props();

  let editing = $state(false);
  let draft = $state('');
  let saving = $state(false);
  let inputRef = $state<HTMLInputElement | null>(null);

  let target = $derived(folderTarget(draft, folders.keys(), name));
  // Held while saving: a big rename's first batch makes `target` a folder.
  let mergingAtSave = $state<boolean | null>(null);
  let merging = $derived(mergingAtSave ?? (target !== name && folders.has(target)));
  let unchanged = $derived(!draft.trim() || draft.trim() === name || target === name);
  let total = $derived(folders.get(name) ?? count);

  function start() {
    draft = name;
    editing = true;
  }

  function cancel() {
    editing = false;
  }

  async function save() {
    if (unchanged || saving) return;
    saving = true;
    mergingAtSave = merging;
    try {
      await onRename(target);
      editing = false;
    } finally {
      saving = false;
      mergingAtSave = null;
    }
  }

  $effect(() => {
    if (editing && inputRef) {
      inputRef.focus();
      inputRef.select();
    }
  });
</script>

{#if editing}
  <form
    class="folder-rename"
    onsubmit={(e) => {
      e.preventDefault();
      save();
    }}
  >
    <div class="rename-row">
      <Icon name="folder" size={13} />
      <input
        class="rename-input"
        type="text"
        aria-label="Folder name"
        maxlength={128}
        bind:value={draft}
        bind:this={inputRef}
        disabled={saving}
        onkeydown={(e) => {
          if (e.key === 'Escape') cancel();
        }}
      />
      <button class="rename-save" type="submit" disabled={unchanged || saving}>
        {merging ? 'Merge' : 'Save'}
      </button>
      <button class="rename-cancel" type="button" onclick={cancel} disabled={saving}>Cancel</button>
    </div>
    {#if merging}
      <p class="rename-hint">
        {total === 1 ? 'Its source moves' : `Its ${total} sources move`} into “{target}”, and this
        folder goes away.
      </p>
    {/if}
  </form>
{:else}
  <h3 class="folder-label">
    <Icon name="folder" size={13} />
    <span class="folder-name">{name}</span>
    <span class="folder-count">{count}</span>
    <button class="rename-btn" type="button" onclick={start} aria-label="Rename folder {name}">
      Rename
    </button>
  </h3>
{/if}

<style>
  .folder-label {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin: 0 0 0.375rem;
    padding: 0 0.25rem;
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    color: var(--color-text-secondary);
  }

  .folder-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .folder-count {
    font-weight: var(--weight-regular);
    font-variant-numeric: tabular-nums;
  }

  .rename-btn {
    margin-left: auto;
    padding: 0.125rem 0.25rem;
    border: none;
    background: none;
    color: var(--color-text-secondary);
    font: inherit;
    font-weight: var(--weight-regular);
    cursor: pointer;
    border-radius: 4px;
  }

  .rename-btn:hover,
  .rename-btn:focus-visible {
    color: var(--color-primary);
  }

  .folder-rename {
    margin: 0 0 0.375rem;
    padding: 0 0.25rem;
  }

  .rename-row {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    color: var(--color-text-secondary);
  }

  .rename-input {
    flex: 1;
    min-width: 0;
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-sm);
    outline: none;
  }

  /* iOS Safari zooms the viewport when a focused input is smaller than 16px. */
  @media (hover: none) and (pointer: coarse) {
    .rename-input {
      font-size: 1rem;
    }
  }

  .rename-input:focus {
    border-color: var(--color-primary);
  }

  .rename-save,
  .rename-cancel {
    padding: 0.25rem 0.625rem;
    border-radius: 6px;
    font-size: var(--text-xs);
    cursor: pointer;
  }

  .rename-save {
    border: 1px solid var(--color-primary);
    background: var(--color-primary);
    color: #fff;
  }

  .rename-save:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .rename-cancel {
    border: 1px solid var(--color-border);
    background: none;
    color: var(--color-text-secondary);
  }

  .rename-hint {
    margin: 0.375rem 0 0 1.25rem;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }
</style>
