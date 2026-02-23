<script lang="ts">
  import { filteredViewsStore } from '$lib/stores/filteredViews.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import Modal from '$lib/components/common/Modal.svelte';
  import type { SubscriptionSourceType } from '$lib/types';
  import { subscriptionSourceKey, migrateLegacyView } from '$lib/utils/sourceKeys';
  import { getFaviconUrl } from '$lib/utils/favicon';

  const TYPE_OPTIONS: { value: SubscriptionSourceType; label: string }[] = [
    { value: 'rss', label: 'Feeds' },
    { value: 'atproto.shares', label: 'Shares' },
    { value: 'atproto.documents', label: 'Documents' },
  ];

  interface Props {
    open: boolean;
    editingViewId: number | null;
    onclose: () => void;
  }

  let { open, editingViewId, onclose }: Props = $props();

  // Form state
  let name = $state('');
  let sourceMode = $state<'all' | 'include'>('all');
  let sourceKeys = $state<Set<string>>(new Set());
  let readFilter = $state<'all' | 'unread' | 'read'>('all');
  let sortOrder = $state<'newest' | 'oldest'>('newest');
  let typeFilter = $state<Set<SubscriptionSourceType>>(new Set());
  let saving = $state(false);
  let error = $state<string | null>(null);

  // Search state for filtering source lists
  let feedSearch = $state('');

  // Filtered subscriptions based on search
  let filteredSubscriptions = $derived(
    feedSearch
      ? subscriptionsStore.subscriptions.filter((sub) => {
          const term = feedSearch.toLowerCase();
          return (
            (sub.customTitle || sub.title).toLowerCase().includes(term) ||
            (sub.feedUrl?.toLowerCase().includes(term) ?? false)
          );
        })
      : subscriptionsStore.subscriptions
  );

  function toggleTypeFilter(type: SubscriptionSourceType) {
    const next = new Set(typeFilter);
    if (next.has(type)) {
      next.delete(type);
    } else {
      next.add(type);
    }
    typeFilter = next;
  }

  // Helper to get all account DIDs for legacy migration
  function getAllFollowDids(): string[] {
    const dids = new Set<string>();
    for (const sub of subscriptionsStore.subscriptions) {
      if (sub.sourceType?.startsWith('atproto.') && sub.subjectDid) {
        dids.add(sub.subjectDid);
      }
    }
    return [...dids];
  }

  // Reset form when modal opens or editingViewId changes
  $effect(() => {
    if (open) {
      if (editingViewId != null) {
        const view = filteredViewsStore.getById(editingViewId);
        if (view) {
          name = view.name;
          readFilter = view.readFilter;
          sortOrder = view.sortOrder;
          typeFilter = new Set(view.typeFilter ?? []);

          if (view.sourceMode != null) {
            // New format (coerce any stale 'exclude' to 'include')
            sourceMode = view.sourceMode === 'all' ? 'all' : 'include';
            sourceKeys = sourceMode === 'all' ? new Set() : new Set(view.sourceKeys ?? []);
          } else {
            // Legacy format — migrate
            const allSubIds = subscriptionsStore.subscriptions
              .map((s) => s.id)
              .filter((id): id is number => id != null);
            const allDids = getAllFollowDids();
            const migrated = migrateLegacyView(
              {
                showArticles: view.showArticles,
                showShares: view.showShares,
                showDocuments: view.showDocuments,
                feedMode: view.feedMode,
                feedIds: view.feedIds,
                accountMode: view.accountMode,
                accountDids: view.accountDids,
              },
              allSubIds,
              allDids
            );
            sourceMode = migrated.sourceMode;
            sourceKeys = new Set(migrated.sourceKeys);
          }
          feedSearch = '';
          return;
        }
      }
      // New view defaults
      name = '';
      sourceMode = 'all';
      sourceKeys = new Set();
      readFilter = 'all';
      sortOrder = 'newest';
      typeFilter = new Set();
      feedSearch = '';
    }
  });

  function handleClose() {
    error = null;
    saving = false;
    onclose();
  }

  function toggleSourceKey(key: string) {
    const next = new Set(sourceKeys);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    sourceKeys = next;
  }

  async function handleSave() {
    if (!name.trim()) {
      error = 'Name is required';
      return;
    }

    error = null;
    saving = true;

    try {
      const viewData = {
        name: name.trim(),
        sourceMode,
        sourceKeys: Array.from(sourceKeys),
        readFilter,
        sortOrder,
        typeFilter: typeFilter.size > 0 ? Array.from(typeFilter) : undefined,
      };

      if (editingViewId != null) {
        await filteredViewsStore.update(editingViewId, viewData);
      } else {
        await filteredViewsStore.create(viewData);
      }

      handleClose();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to save view';
    } finally {
      saving = false;
    }
  }
</script>

<Modal {open} onclose={handleClose} title={editingViewId != null ? 'Edit View' : 'Create View'}>
  <form
    class="form"
    onsubmit={(e) => {
      e.preventDefault();
      handleSave();
    }}
  >
    <!-- Name -->
    <div class="form-group">
      <label for="view-name">Name</label>
      <input id="view-name" type="text" bind:value={name} placeholder="My view" required />
    </div>

    <!-- Sources -->
    <div class="form-group">
      <span class="form-label">Sources</span>
      <div class="radio-group">
        <label class="radio-label">
          <input type="radio" bind:group={sourceMode} value="all" />
          All sources
        </label>
        <label class="radio-label">
          <input type="radio" bind:group={sourceMode} value="include" />
          Include only
        </label>
      </div>

      {#if sourceMode === 'include'}
        <!-- Subscriptions -->
        {#if subscriptionsStore.subscriptions.length > 0}
          <div class="source-group-header">Subscriptions</div>
          <input
            type="text"
            placeholder="Search subscriptions..."
            bind:value={feedSearch}
            class="search-input"
          />
          <div class="checklist">
            {#each filteredSubscriptions as sub (sub.id)}
              {@const key = subscriptionSourceKey(sub)}
              {#if key}
                {@const iconUrl =
                  sub.customIconUrl || getFaviconUrl(sub.siteUrl || sub.feedUrl || '')}
                <label class="checklist-item">
                  <input
                    type="checkbox"
                    checked={sourceKeys.has(key)}
                    onchange={() => toggleSourceKey(key)}
                  />
                  {#if iconUrl}
                    <img src={iconUrl} alt="" class="checklist-icon" />
                  {/if}
                  <span class="checklist-label">{sub.customTitle || sub.title}</span>
                </label>
              {/if}
            {/each}
            {#if feedSearch && filteredSubscriptions.length === 0}
              <div class="no-results">No subscriptions match</div>
            {/if}
          </div>
        {/if}
      {/if}
    </div>

    <!-- Type Filter -->
    <div class="form-group">
      <span class="form-label">Content Types</span>
      <div class="checklist type-checklist">
        {#each TYPE_OPTIONS as opt}
          <label class="checklist-item">
            <input
              type="checkbox"
              checked={typeFilter.has(opt.value)}
              onchange={() => toggleTypeFilter(opt.value)}
            />
            <span class="checklist-label">{opt.label}</span>
          </label>
        {/each}
      </div>
      <span class="form-hint">Leave all unchecked to show all types</span>
    </div>

    <!-- Read State -->
    <div class="form-group">
      <span class="form-label">Read State</span>
      <div class="radio-group">
        <label class="radio-label">
          <input type="radio" bind:group={readFilter} value="all" />
          All
        </label>
        <label class="radio-label">
          <input type="radio" bind:group={readFilter} value="unread" />
          Unread only
        </label>
        <label class="radio-label">
          <input type="radio" bind:group={readFilter} value="read" />
          Read only
        </label>
      </div>
    </div>

    <!-- Sort Order -->
    <div class="form-group">
      <span class="form-label">Sort Order</span>
      <div class="radio-group">
        <label class="radio-label">
          <input type="radio" bind:group={sortOrder} value="newest" />
          Newest first
        </label>
        <label class="radio-label">
          <input type="radio" bind:group={sortOrder} value="oldest" />
          Oldest first
        </label>
      </div>
    </div>

    {#if error}
      <p class="error-message">{error}</p>
    {/if}

    <div class="button-row">
      <button type="button" class="btn-secondary" onclick={handleClose} disabled={saving}>
        Cancel
      </button>
      <button type="submit" class="btn-primary" disabled={saving}>
        {#if saving}
          Saving...
        {:else if editingViewId != null}
          Save
        {:else}
          Create
        {/if}
      </button>
    </div>
  </form>
</Modal>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .form-group label[for],
  .form-label {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--color-text);
  }

  .form-group input[type='text'] {
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font-size: 0.875rem;
    background: var(--color-bg);
    color: var(--color-text);
  }

  .form-group input[type='text']:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.1);
  }

  .radio-group {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
  }

  .radio-label {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.875rem;
    font-weight: 400;
    color: var(--color-text);
    cursor: pointer;
  }

  .source-group-header {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-top: 0.5rem;
  }

  .search-input {
    width: 100%;
    padding: 0.375rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: 0.8125rem;
    background: var(--color-bg);
    color: var(--color-text);
    outline: none;
    margin-top: 0.25rem;
    box-sizing: border-box;
  }

  .search-input:focus {
    border-color: var(--color-primary);
  }

  .search-input::placeholder {
    color: var(--color-text-secondary, #999);
  }

  .no-results {
    padding: 0.375rem;
    font-size: 0.8125rem;
    color: var(--color-text-secondary, #999);
    text-align: center;
  }

  .checklist {
    max-height: 160px;
    overflow-y: auto;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 0.5rem;
    margin-top: 0.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .type-checklist {
    max-height: none;
  }

  .form-hint {
    font-size: 0.75rem;
    color: var(--color-text-secondary);
  }

  .checklist-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.375rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
  }

  .checklist-item:hover {
    background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
  }

  .checklist-icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    border-radius: 2px;
  }

  .checklist-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .error-message {
    color: var(--color-error);
    font-size: 0.875rem;
    margin: 0;
  }

  .button-row {
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
    margin-top: 0.5rem;
  }

  .btn-primary,
  .btn-secondary {
    padding: 0.5rem 1rem;
    border-radius: 6px;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-primary {
    background: var(--color-primary);
    color: white;
    border: none;
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--color-primary-dark, #0056b3);
  }

  .btn-primary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .btn-secondary {
    background: var(--color-bg);
    color: var(--color-text);
    border: 1px solid var(--color-border);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--color-bg-secondary);
  }

  .btn-secondary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
