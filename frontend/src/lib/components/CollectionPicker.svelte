<script lang="ts">
  // Two modes in one modal. If the article has never been saved to this
  // integration, the picker behaves exactly as it always did: pick collections,
  // create a card/note. If it HAS been saved, the modal opens on the live PDS
  // answer — the collections it's already in are pre-checked, and confirming
  // applies the difference (new links added, unchecked links deleted) instead of
  // creating a second card. Editing never deletes the card/note itself.
  //
  // Membership is read per-open rather than remembered: a save can be created or
  // moved in Semble/Margin themselves, so anything we cached would eventually lie.
  // Offline there's no way to read it, so the picker stays in create mode (a diff
  // computed against stale state would delete the wrong links).
  import Modal from '$lib/components/common/Modal.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { collectionsStore, type IntegrationKind } from '$lib/stores/collections.svelte';
  import { saveBackingStore } from '$lib/stores/saveBacking.svelte';
  import { api } from '$lib/services/api';
  import type {
    SembleCollection,
    MarginCollection,
    IntegrationMemberships,
    CollectionSelection,
    CollectionPickerResult,
  } from '$lib/types';

  interface Props {
    open: boolean;
    integration: IntegrationKind;
    /** the article URL being saved — membership is looked up per-URL */
    url?: string;
    onconfirm: (result: CollectionPickerResult) => void;
    onclose: () => void;
  }

  let { open, integration, url, onconfirm, onclose }: Props = $props();

  let searchQuery = $state('');
  let selectedUris = $state<Set<string>>(new Set());
  let noCollection = $state(false);
  let memberships = $state<IntegrationMemberships | null>(null);
  let membershipsLoading = $state(false);
  // Non-reactive generation counter: changing it must not retrigger the open
  // effect that starts membership requests.
  let membershipRequestId = 0;
  // The lookup is advisory: if it fails we fall back to create mode rather than
  // block the save. A duplicate card is recoverable; a blocked save is annoying.
  let membershipsFailed = $state(false);

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

  // Edit mode = this URL already has a card/note in the user's repo.
  let isEdit = $derived((memberships?.items.length ?? 0) > 0);
  // A capped item listing that found no match is not proof this is a first save.
  // Keep the lookup honest, but don't permanently block established users whose
  // repos are larger than the bounded scan: a possible duplicate is recoverable.
  let lookupIncomplete = $derived(memberships?.truncated === true && !isEdit);
  /** collections the save currently belongs to (the diff baseline) */
  let initialUris = $derived(new Set((memberships?.memberships ?? []).map((m) => m.collectionUri)));

  // The one collection that must not be edited from here: when the Saved list is
  // backed by it, its membership IS the save, and removing the link would silently
  // unsave the article on the next poll. Unknown backing (lookup failed) locks
  // nothing — see saveBacking.svelte.ts.
  let lockedUri = $derived.by(() => {
    const backing = saveBackingStore.backing;
    return backing && backing.provider === integration ? backing.collectionUri : null;
  });

  let addedUris = $derived([...selectedUris].filter((u) => !initialUris.has(u)));
  let removedUris = $derived([...initialUris].filter((u) => !selectedUris.has(u)));
  let changed = $derived(addedUris.length > 0 || removedUris.length > 0);

  let canSave = $derived.by(() => {
    if (membershipsLoading) return false;
    // Until this settles, the row whose membership IS the user's Saved entry is
    // unknown and must not be editable (or removable through "remove all").
    if (!saveBackingStore.loaded) return false;
    if (isEdit) return changed;
    return noCollection || selectedUris.size > 0;
  });

  let saveLabel = $derived.by(() => {
    if (isEdit) return 'Update';
    return selectedUris.size > 0
      ? `Save to ${selectedUris.size} collection${selectedUris.size === 1 ? '' : 's'}`
      : 'Save';
  });

  $effect(() => {
    if (open) {
      collectionsStore.loadAndRefresh(integration);
      saveBackingStore.load();
      loadMemberships(integration, url);
    } else {
      // Reset picker state when modal closes.
      membershipRequestId += 1;
      searchQuery = '';
      selectedUris = new Set();
      noCollection = false;
      memberships = null;
      membershipsLoading = false;
      membershipsFailed = false;
    }
  });

  async function loadMemberships(kind: IntegrationKind, target: string | undefined) {
    const requestId = ++membershipRequestId;
    memberships = null;
    membershipsFailed = false;
    // No URL, or offline: nothing readable, so stay in create mode.
    if (!target || (typeof navigator !== 'undefined' && !navigator.onLine)) {
      membershipsLoading = false;
      return;
    }
    membershipsLoading = true;
    try {
      const res = await api.getIntegrationMemberships(kind, target);
      // The modal may have been closed (or reopened for another article) while the
      // request was in flight — only apply an answer that's still the current one.
      if (requestId !== membershipRequestId || !open || kind !== integration || target !== url)
        return;
      memberships = res;
      selectedUris = new Set(res.memberships.map((m) => m.collectionUri));
    } catch (err) {
      console.error('Failed to load existing saves:', err);
      if (requestId !== membershipRequestId || !open || kind !== integration || target !== url)
        return;
      membershipsFailed = true;
    } finally {
      // A request for an earlier article must not unlock the current picker while
      // its membership lookup is still pending.
      if (requestId === membershipRequestId) membershipsLoading = false;
    }
  }

  function toggleCollection(uri: string) {
    if (uri === lockedUri) return;
    const next = new Set(selectedUris);
    if (next.has(uri)) {
      next.delete(uri);
    } else {
      next.add(uri);
      noCollection = false;
    }
    selectedUris = next;
  }

  /** Create mode: "No collection". Edit mode: "Remove from all collections". */
  function toggleNoCollection() {
    if (isEdit) {
      selectedUris = new Set(lockedUri && initialUris.has(lockedUri) ? [lockedUri] : []);
      return;
    }
    if (noCollection) {
      noCollection = false;
    } else {
      noCollection = true;
      selectedUris = new Set();
    }
  }

  function handleSave() {
    if (!canSave) return;

    if (isEdit) {
      const byUri = new Map(list.map((c) => [c.uri, c]));
      const add: CollectionSelection[] = addedUris.map((uri) => ({
        uri,
        cid: byUri.get(uri)?.cid ?? '',
      }));
      // Every link pointing at a de-selected collection, across all matched items —
      // a URL saved twice can sit in the same collection through two links.
      const remove = (memberships?.memberships ?? [])
        .filter((m) => removedUris.includes(m.collectionUri))
        .map((m) => m.linkUri);
      onconfirm({ mode: 'edit', add, remove });
      return;
    }

    if (noCollection) {
      onconfirm({ mode: 'create', collections: [] });
      return;
    }
    const byUri = new Map(list.map((c) => [c.uri, c]));
    const collections: CollectionSelection[] = [];
    for (const uri of selectedUris) {
      const col = byUri.get(uri);
      if (col) collections.push({ uri: col.uri, cid: col.cid });
    }
    onconfirm({ mode: 'create', collections });
  }
</script>

<Modal
  {open}
  {onclose}
  title={isEdit ? `Saved to ${integrationName}` : `Save to ${integrationName}`}
>
  <div class="picker-body">
    {#if isOffline && list.length === 0}
      <div class="picker-offline">
        You're offline and no collections are cached. You can still save without a collection — it
        will be queued.
      </div>
    {:else if loadError && !isOffline && list.length === 0}
      <div class="picker-error">{loadError}</div>
    {:else if (isLoading || membershipsLoading) && list.length === 0}
      <div class="picker-loading">Loading collections...</div>
    {:else}
      {#if isOffline}
        <div class="picker-offline">Offline — showing cached collections. Save will be queued.</div>
      {/if}

      {#if membershipsLoading}
        <div class="picker-note" aria-live="polite">Checking existing saves…</div>
      {:else if isEdit}
        <div class="picker-note">
          {#if initialUris.size === 0}
            Saved without a collection. Pick where it should live.
          {:else}
            Already in {initialUris.size} collection{initialUris.size === 1 ? '' : 's'}. Changes
            apply on update.
          {/if}
          {#if memberships?.truncated}
            <span class="picker-note-soft">Some older saves may not be shown.</span>
          {/if}
        </div>
      {:else if lookupIncomplete}
        <div class="picker-note">
          Couldn't check all older saves. Saving may create another {integrationName} item.
        </div>
      {:else if membershipsFailed}
        <div class="picker-note">Couldn't check existing saves — saving will create a new one.</div>
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
        class:selected={!isEdit && noCollection}
        onclick={toggleNoCollection}
        type="button"
      >
        <span class="checkbox" aria-hidden="true">
          {#if !isEdit && noCollection}<Icon name="check" size={14} />{/if}
        </span>
        <div class="collection-info">
          <span class="collection-name">
            {isEdit && initialUris.size > 0 ? 'Remove from all collections' : 'No collection'}
          </span>
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
            {@const locked = collection.uri === lockedUri}
            <button
              class="collection-row"
              class:selected={checked}
              class:locked
              onclick={() => toggleCollection(collection.uri)}
              disabled={locked || !saveBackingStore.loaded}
              type="button"
            >
              <span class="checkbox" aria-hidden="true">
                {#if checked}<Icon name="check" size={14} />{/if}
              </span>
              <div class="collection-info">
                <span class="collection-name">{collection.name || 'Untitled'}</span>
                {#if locked}
                  <span class="collection-desc">
                    Managed by your Saved list — {checked ? 'unsave to remove' : 'save to add'}
                  </span>
                {:else if collection.description}
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
    font-size: var(--text-md);
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

  .picker-note {
    padding: 0.5rem 0.25rem;
    font-size: var(--text-md);
    color: var(--color-text-secondary);
  }

  .picker-note-soft {
    display: block;
    font-size: var(--text-sm);
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
    font-size: var(--text-lg);
    color: var(--color-text);
    min-width: 0;
  }

  .refreshing-badge {
    font-size: var(--text-xs);
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

  .collection-row.locked {
    cursor: default;
  }

  .collection-row.locked:hover {
    background: none;
  }

  .collection-row.locked.selected:hover {
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
    font-weight: var(--weight-medium);
    font-size: var(--text-lg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .collection-desc {
    font-size: var(--text-sm);
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
    font-size: var(--text-md);
  }

  .btn {
    padding: 0.5rem 1rem;
    border-radius: 6px;
    font-size: var(--text-lg);
    font-weight: var(--weight-medium);
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
