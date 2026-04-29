<script lang="ts">
  import Modal from '$lib/components/common/Modal.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { collectionsStore, type IntegrationKind } from '$lib/stores/collections.svelte';
  import type { SembleCollection, MarginCollection } from '$lib/types';

  export interface CollectionSelection {
    uri: string;
    cid: string;
  }

  interface Props {
    open: boolean;
    integration: IntegrationKind;
    onselect: (collections: CollectionSelection[]) => void;
    onclose: () => void;
  }

  let { open, integration, onselect, onclose }: Props = $props();

  let searchQuery = $state('');
  let selectedUris = $state<Set<string>>(new Set());
  let noCollection = $state(false);

  let list = $derived<(SembleCollection | MarginCollection)[]>(
    collectionsStore.collections[integration]
  );
  let isLoading = $derived(collectionsStore.loading[integration]);
  let isRefreshing = $derived(collectionsStore.refreshing[integration]);
  let loadError = $derived(collectionsStore.error[integration]);
  let isOffline = $derived(loadError === 'offline');

  let filtered = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter((c) => {
      const name = (c.name || '').toLowerCase();
      const desc = (c.description || '').toLowerCase();
      return name.includes(q) || desc.includes(q);
    });
  });

  let integrationName = $derived(integration === 'semble' ? 'Semble' : 'Margin');
  let canSave = $derived(noCollection || selectedUris.size > 0);
  let saveLabel = $derived(
    selectedUris.size > 0
      ? `Save to ${selectedUris.size} collection${selectedUris.size === 1 ? '' : 's'}`
      : 'Save'
  );

  $effect(() => {
    if (open) {
      collectionsStore.loadAndRefresh(integration);
    } else {
      // Reset picker state when modal closes.
      searchQuery = '';
      selectedUris = new Set();
      noCollection = false;
    }
  });

  function toggleCollection(uri: string) {
    const next = new Set(selectedUris);
    if (next.has(uri)) {
      next.delete(uri);
    } else {
      next.add(uri);
      noCollection = false;
    }
    selectedUris = next;
  }

  function toggleNoCollection() {
    if (noCollection) {
      noCollection = false;
    } else {
      noCollection = true;
      selectedUris = new Set();
    }
  }

  function handleSave() {
    if (!canSave) return;
    if (noCollection) {
      onselect([]);
      return;
    }
    const byUri = new Map(list.map((c) => [c.uri, c]));
    const result: CollectionSelection[] = [];
    for (const uri of selectedUris) {
      const col = byUri.get(uri);
      if (col) result.push({ uri: col.uri, cid: col.cid });
    }
    onselect(result);
  }
</script>

<Modal {open} {onclose} title="Save to {integrationName}">
  <div class="picker-body">
    {#if isOffline && list.length === 0}
      <div class="picker-offline">
        You're offline and no collections are cached. You can still save without a collection — it
        will be queued.
      </div>
    {:else if loadError && !isOffline && list.length === 0}
      <div class="picker-error">{loadError}</div>
    {:else if isLoading && list.length === 0}
      <div class="picker-loading">Loading collections...</div>
    {:else}
      {#if isOffline}
        <div class="picker-offline">Offline — showing cached collections. Save will be queued.</div>
      {/if}

      <div class="search-row">
        <span class="search-icon"><Icon name="search" size={16} /></span>
        <input
          type="text"
          placeholder="Search collections..."
          bind:value={searchQuery}
          class="search-input"
          aria-label="Search collections"
        />
        {#if isRefreshing}
          <span class="refreshing-badge" aria-live="polite">Refreshing…</span>
        {/if}
      </div>

      <button
        class="collection-row no-collection"
        class:selected={noCollection}
        onclick={toggleNoCollection}
        type="button"
      >
        <span class="checkbox" aria-hidden="true">
          {#if noCollection}<Icon name="check" size={14} />{/if}
        </span>
        <div class="collection-info">
          <span class="collection-name">No collection</span>
        </div>
      </button>

      <div class="collection-divider"></div>

      <div class="collections-list">
        {#if filtered.length === 0}
          <div class="empty-state">
            {searchQuery ? 'No collections match your search.' : 'No collections found.'}
          </div>
        {:else}
          {#each filtered as collection (collection.uri)}
            {@const checked = selectedUris.has(collection.uri)}
            <button
              class="collection-row"
              class:selected={checked}
              onclick={() => toggleCollection(collection.uri)}
              type="button"
            >
              <span class="checkbox" aria-hidden="true">
                {#if checked}<Icon name="check" size={14} />{/if}
              </span>
              <div class="collection-info">
                <span class="collection-name">{collection.name || 'Untitled'}</span>
                {#if collection.description}
                  <span class="collection-desc">{collection.description}</span>
                {/if}
              </div>
            </button>
          {/each}
        {/if}
      </div>
    {/if}
  </div>

  {#snippet footer()}
    <button class="btn btn-secondary" onclick={onclose} type="button">Cancel</button>
    <button class="btn btn-primary" onclick={handleSave} disabled={!canSave} type="button">
      {saveLabel}
    </button>
  {/snippet}
</Modal>

<style>
  .picker-body {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .picker-loading,
  .picker-error,
  .picker-offline {
    padding: 0.75rem;
    font-size: 0.85rem;
    border-radius: 6px;
    margin-bottom: 0.5rem;
  }

  .picker-loading {
    text-align: center;
    padding: 2rem 0;
    color: var(--color-text-secondary);
  }

  .picker-error {
    text-align: center;
    color: var(--color-error, #e53e3e);
  }

  .picker-offline {
    color: var(--color-text-secondary);
    background: var(--color-bg-secondary, rgba(0, 0, 0, 0.03));
  }

  .search-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    margin-bottom: 0.5rem;
    background: var(--color-bg);
  }

  .search-icon {
    color: var(--color-text-secondary);
    flex-shrink: 0;
    display: flex;
    align-items: center;
  }

  .search-input {
    flex: 1;
    border: none;
    outline: none;
    background: transparent;
    font-size: 0.9rem;
    color: var(--color-text);
    min-width: 0;
  }

  .refreshing-badge {
    font-size: 0.75rem;
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }

  .collection-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.6rem 0.5rem;
    border: none;
    background: none;
    cursor: pointer;
    text-align: left;
    border-radius: 6px;
    color: var(--color-text);
  }

  .collection-row:hover {
    background: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
  }

  .collection-row.selected {
    background: var(--color-accent-subtle, rgba(59, 130, 246, 0.08));
  }

  .checkbox {
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    border: 1.5px solid var(--color-border);
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-accent, #3b82f6);
  }

  .collection-row.selected .checkbox {
    border-color: var(--color-accent, #3b82f6);
    background: var(--color-accent-subtle, rgba(59, 130, 246, 0.12));
  }

  .collection-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .collection-name {
    font-weight: 500;
    font-size: 0.9rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .collection-desc {
    font-size: 0.8rem;
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .collection-divider {
    height: 1px;
    background: var(--color-border);
    margin: 0.5rem 0;
  }

  .collections-list {
    max-height: 50vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  .empty-state {
    padding: 1.5rem 0.5rem;
    text-align: center;
    color: var(--color-text-secondary);
    font-size: 0.85rem;
  }

  .btn {
    padding: 0.5rem 1rem;
    border-radius: 6px;
    font-size: 0.9rem;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
  }

  .btn-secondary {
    background: transparent;
    color: var(--color-text);
    border-color: var(--color-border);
  }

  .btn-secondary:hover {
    background: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
  }

  .btn-primary {
    background: var(--color-accent, #3b82f6);
    color: white;
  }

  .btn-primary:hover:not(:disabled) {
    filter: brightness(1.05);
  }

  .btn-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
