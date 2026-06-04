<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';

  interface Props {
    selectionCount: number;
    folders: string[];
    hasCategory: boolean;
    onAssignToFolder: (folderName: string) => void;
    onRemoveFromFolder: () => void;
    onBulkDelete: () => void;
    onClearSelection: () => void;
  }

  let {
    selectionCount,
    folders,
    hasCategory,
    onAssignToFolder,
    onRemoveFromFolder,
    onBulkDelete,
    onClearSelection,
  }: Props = $props();

  let dropdownOpen = $state(false);
  let showNewFolderInput = $state(false);
  let newFolderName = $state('');
  let wrapperRef = $state<HTMLDivElement | null>(null);
  let newFolderInputRef = $state<HTMLInputElement | null>(null);

  function selectFolder(name: string) {
    onAssignToFolder(name);
    dropdownOpen = false;
    showNewFolderInput = false;
    newFolderName = '';
  }

  function confirmNewFolder() {
    const trimmed = newFolderName.trim();
    if (!trimmed) return;
    selectFolder(trimmed);
  }

  function handleClickOutside(e: MouseEvent) {
    if (wrapperRef && !wrapperRef.contains(e.target as Node)) {
      dropdownOpen = false;
      showNewFolderInput = false;
      newFolderName = '';
    }
  }

  $effect(() => {
    if (dropdownOpen) {
      document.addEventListener('click', handleClickOutside, true);
      return () => document.removeEventListener('click', handleClickOutside, true);
    }
  });

  $effect(() => {
    if (showNewFolderInput && newFolderInputRef) {
      newFolderInputRef.focus();
    }
  });
</script>

<div class="bulk-bar">
  <span class="bulk-count">{selectionCount} selected</span>
  <div class="bulk-actions">
    <div class="assign-wrapper" bind:this={wrapperRef}>
      <button class="bulk-btn" onclick={() => (dropdownOpen = !dropdownOpen)}>
        <Icon name="folder-plus" size={14} />
        Add to folder
      </button>
      {#if dropdownOpen}
        <div class="assign-dropdown">
          {#each folders as folder (folder)}
            <button class="assign-item" onclick={() => selectFolder(folder)}>
              {folder}
            </button>
          {/each}
          {#if hasCategory}
            <button
              class="assign-item remove-folder-btn"
              onclick={() => {
                onRemoveFromFolder();
                dropdownOpen = false;
              }}
            >
              <Icon name="x" size={12} />
              Remove from folder
            </button>
          {/if}
          {#if !showNewFolderInput}
            <button class="assign-item new-folder-btn" onclick={() => (showNewFolderInput = true)}>
              <Icon name="plus" size={12} />
              New folder…
            </button>
          {:else}
            <div class="new-folder-row">
              <input
                type="text"
                class="new-folder-input"
                placeholder="Folder name"
                bind:value={newFolderName}
                bind:this={newFolderInputRef}
                onkeydown={(e) => {
                  if (e.key === 'Enter') confirmNewFolder();
                  if (e.key === 'Escape') {
                    showNewFolderInput = false;
                    newFolderName = '';
                  }
                }}
              />
              <button
                class="new-folder-confirm"
                disabled={!newFolderName.trim()}
                onclick={confirmNewFolder}
              >
                <Icon name="check" size={12} />
              </button>
            </div>
          {/if}
        </div>
      {/if}
    </div>
    <button class="bulk-btn danger" onclick={onBulkDelete}>
      <Icon name="trash" size={14} />
      Remove
    </button>
  </div>
  <button class="bulk-clear" onclick={onClearSelection}>
    <Icon name="x" size={14} />
  </button>
</div>

<style>
  .bulk-bar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
    background: var(--color-primary);
    color: #fff;
    border-radius: 10px;
    margin-bottom: 1rem;
    font-size: var(--text-sm);
    position: fixed;
    bottom: 1.5rem;
    left: calc(var(--sidebar-width, 320px) + (100% - var(--sidebar-width, 320px)) / 2);
    transform: translateX(-50%);
    max-width: 600px;
    width: calc(100% - var(--sidebar-width, 320px) - 2rem);
    z-index: 50;
  }

  .bulk-count {
    font-weight: var(--weight-medium);
  }

  .bulk-actions {
    display: flex;
    gap: 0.375rem;
    flex: 1;
  }

  .bulk-btn {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0.5rem;
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 6px;
    background: none;
    color: #fff;
    cursor: pointer;
    font-size: var(--text-xs);
  }

  .bulk-btn:hover {
    background: rgba(255, 255, 255, 0.15);
  }

  .bulk-btn.danger:hover {
    background: rgba(220, 38, 38, 0.3);
  }

  .bulk-clear {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.7);
    cursor: pointer;
    padding: 0.25rem;
    display: flex;
    align-items: center;
    border-radius: 4px;
  }

  .bulk-clear:hover {
    color: #fff;
  }

  .assign-wrapper {
    position: relative;
  }

  .assign-dropdown {
    position: absolute;
    bottom: 100%;
    left: 0;
    margin-bottom: 0.25rem;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    padding: 0.25rem;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    z-index: 100;
    min-width: 180px;
  }

  .assign-item {
    display: block;
    width: 100%;
    padding: 0.375rem 0.5rem;
    border: none;
    background: none;
    text-align: left;
    cursor: pointer;
    font-size: var(--text-sm);
    color: var(--color-text);
    border-radius: 4px;
  }

  .assign-item:hover {
    background: var(--color-bg-hover);
  }

  .remove-folder-btn {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    color: var(--color-text-secondary);
    border-top: 1px solid var(--color-border);
    margin-top: 0.25rem;
    padding-top: 0.5rem;
    border-radius: 0;
  }

  .new-folder-btn {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    color: var(--color-text-secondary);
    border-top: 1px solid var(--color-border);
    margin-top: 0.25rem;
    padding-top: 0.5rem;
    border-radius: 0 0 4px 4px;
  }

  .new-folder-row {
    display: flex;
    gap: 0.25rem;
    padding: 0.25rem;
    border-top: 1px solid var(--color-border);
    margin-top: 0.25rem;
    padding-top: 0.5rem;
  }

  .new-folder-input {
    flex: 1;
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--text-sm);
    background: var(--color-bg);
    color: var(--color-text);
    outline: none;
  }

  .new-folder-input:focus {
    border-color: var(--color-primary);
  }

  .new-folder-confirm {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.25rem 0.375rem;
    border: 1px solid var(--color-primary);
    border-radius: 4px;
    background: var(--color-primary);
    color: #fff;
    cursor: pointer;
    font-size: var(--text-xs);
  }

  .new-folder-confirm:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  @media (max-width: 1000px) {
    .bulk-bar {
      left: 50%;
      width: calc(100% - 2rem);
      bottom: calc(var(--bottom-bar-height) + var(--safe-area-bottom) + 0.75rem);
    }
  }

  @media (prefers-color-scheme: dark) {
    .assign-dropdown {
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }
  }
</style>
