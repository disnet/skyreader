<script lang="ts">
  import Modal from '$lib/components/common/Modal.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { api } from '$lib/services/api';
  import type { SembleCollection, MarginCollection } from '$lib/types';

  export interface CollectionSelection {
    uri: string;
    cid: string;
  }

  interface Props {
    open: boolean;
    integration: 'semble' | 'margin';
    onselect: (collection: CollectionSelection | null) => void;
    onclose: () => void;
  }

  let { open, integration, onselect, onclose }: Props = $props();

  let collections = $state<(SembleCollection | MarginCollection)[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);

  let offline = $state(false);

  $effect(() => {
    if (open) {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        offline = true;
        collections = [];
        loading = false;
        error = null;
      } else {
        offline = false;
        loadCollections();
      }
    } else {
      collections = [];
      error = null;
      offline = false;
    }
  });

  async function loadCollections() {
    loading = true;
    error = null;
    try {
      if (integration === 'semble') {
        const result = await api.listSembleCollections();
        collections = result.collections;
      } else {
        const result = await api.listMarginCollections();
        collections = result.collections;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load collections';
    } finally {
      loading = false;
    }
  }

  function handleSelect(collection: SembleCollection | MarginCollection) {
    onselect({ uri: collection.uri, cid: collection.cid });
  }

  function handleSkip() {
    onselect(null);
  }

  let integrationName = $derived(integration === 'semble' ? 'Semble' : 'Margin');
</script>

<Modal {open} {onclose} title="Save to {integrationName}">
  {#if loading}
    <div class="picker-loading">Loading collections...</div>
  {:else if error && !offline}
    <div class="picker-error">{error}</div>
  {:else}
    {#if offline}
      <div class="picker-offline">
        You're offline. The save will be queued and synced when you reconnect.
      </div>
    {/if}
    <button class="collection-option no-collection" onclick={handleSkip}>
      <div class="collection-info">
        <span class="collection-name">No collection</span>
        <span class="collection-desc">Save without adding to a collection</span>
      </div>
      <span class="collection-arrow"><Icon name="chevron-right" size={16} /></span>
    </button>
    {#if collections.length > 0}
      <div class="collection-divider"></div>
      <div class="collections-list">
        {#each collections as collection}
          <button class="collection-option" onclick={() => handleSelect(collection)}>
            <div class="collection-info">
              <span class="collection-name">{collection.name || 'Untitled'}</span>
              {#if collection.description}
                <span class="collection-desc">{collection.description}</span>
              {/if}
            </div>
            <span class="collection-arrow"><Icon name="chevron-right" size={16} /></span>
          </button>
        {/each}
      </div>
    {/if}
  {/if}
</Modal>

<style>
  .picker-loading {
    text-align: center;
    padding: 2rem 0;
    color: var(--color-text-secondary);
  }

  .picker-error {
    text-align: center;
    padding: 2rem 0;
    color: var(--color-error, #e53e3e);
  }

  .picker-offline {
    padding: 0.75rem;
    margin-bottom: 0.5rem;
    font-size: 0.85rem;
    color: var(--color-text-secondary);
    background: var(--color-bg-secondary, rgba(0, 0, 0, 0.03));
    border-radius: 6px;
  }

  .collection-option {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.75rem 0.5rem;
    border: none;
    background: none;
    cursor: pointer;
    text-align: left;
    border-radius: 6px;
    color: var(--color-text);
  }

  .collection-option:hover {
    background: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
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

  .collection-arrow {
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  .collection-divider {
    height: 1px;
    background: var(--color-border);
    margin: 0.25rem 0;
  }

  .collections-list {
    max-height: 300px;
    overflow-y: auto;
  }
</style>
