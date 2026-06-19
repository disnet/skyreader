<script lang="ts">
  // Save backing engine picker — choose where the user's Saved list lives:
  // Skyreader (D1 only, private) or a Semble/Margin foreign collection (public).
  // Shared by the Settings page and the first-run empty state so the two stay
  // in step. Owns its own backing/scope/collection state and loads on mount.
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { syncStore } from '$lib/stores/sync.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { collectionsStore } from '$lib/stores/collections.svelte';
  import { api, RateLimitError, ScopeUpgradeError } from '$lib/services/api';
  import Icon from '$lib/components/Icon.svelte';
  import type { SaveBacking } from '$lib/types';

  let {
    backing = $bindable({ provider: 'skyreader' }),
    allowExport = true,
    returnUrl = '/settings',
  }: {
    /** Current backing; bindable so the parent can reflect public/private state. */
    backing?: SaveBacking;
    /** Offer "copy my existing saves into this collection" (off for first-run). */
    allowExport?: boolean;
    /** Where to return after a scope-grant re-auth. */
    returnUrl?: string;
  } = $props();

  let loaded = $state(false);
  let scopeStatus = $state<{ semble: boolean; margin: boolean }>({ semble: false, margin: false });
  let configuring = $state<'semble' | 'margin' | null>(null); // provider being set up
  let chosenCollectionUri = $state(''); // '' = create a new default "Skyreader Saves"
  let exportExisting = $state(true);
  let backingBusy = $state(false);
  let backingError = $state<string | null>(null);
  let backingSuccess = $state<string | null>(null);
  // Live progress while copying existing saves into the collection (null when not running).
  let backingExportProgress = $state<{ current: number; total: number } | null>(null);

  const providerLabel = (p: 'semble' | 'margin') => (p === 'semble' ? 'Semble' : 'Margin');

  // Collection picker: users may have a lot of collections, so filter by name and
  // cap how many radios we render at once (search to reach the rest).
  const COLLECTION_DISPLAY_LIMIT = 8;
  let collectionSearch = $state('');
  const allCollections = $derived(configuring ? collectionsStore.collections[configuring] : []);
  const filteredCollections = $derived.by(() => {
    const q = collectionSearch.trim().toLowerCase();
    if (!q) return allCollections;
    return allCollections.filter((c) => (c.name || '').toLowerCase().includes(q));
  });
  const visibleCollections = $derived.by(() => {
    const list = filteredCollections;
    if (list.length <= COLLECTION_DISPLAY_LIMIT) return list;
    const head = list.slice(0, COLLECTION_DISPLAY_LIMIT);
    // Keep the currently-chosen collection visible even if it'd fall past the cap.
    const chosen = chosenCollectionUri && list.find((c) => c.uri === chosenCollectionUri);
    if (chosen && !head.some((c) => c.uri === chosen.uri)) {
      return [chosen, ...head.slice(0, COLLECTION_DISPLAY_LIMIT - 1)];
    }
    return head;
  });
  const hiddenCount = $derived(filteredCollections.length - visibleCollections.length);

  onMount(async () => {
    if (!syncStore.isOnline) {
      loaded = true;
      return;
    }
    try {
      const settings = await api.getSettings();
      backing = settings.backing;
    } catch (error) {
      console.error('Failed to load backing:', error);
    }
    // Scope status gates the engine picker (writing to Semble/Margin needs grants).
    try {
      const status = await api.getIntegrationStatus();
      scopeStatus = status.scopeStatus;
    } catch (error) {
      console.error('Failed to load integration status:', error);
    }
    loaded = true;
  });

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function startConfigure(provider: 'semble' | 'margin') {
    backingError = null;
    backingSuccess = null;
    configuring = provider;
    chosenCollectionUri = '';
    collectionSearch = '';
    exportExisting = true;
    collectionsStore.loadAndRefresh(provider);
  }

  function cancelConfigure() {
    configuring = null;
    backingError = null;
  }

  async function reauthForScopes() {
    await auth.logout();
    goto(`/auth/login?returnUrl=${encodeURIComponent(returnUrl)}`);
  }

  async function handleEnableBacking() {
    if (!configuring || backingBusy) return;
    if (!syncStore.isOnline) {
      backingError = 'You are offline. Connect to the internet to change this.';
      return;
    }
    const provider = configuring;
    const copyExisting = allowExport && exportExisting;
    backingBusy = true;
    backingError = null;
    backingSuccess = null;
    backingExportProgress = null;
    try {
      const res = await api.setBacking({
        action: 'enable',
        provider,
        collectionUri: chosenCollectionUri || undefined,
      });
      backing = res.backing;

      // Copy existing saves in batches so the user sees progress instead of a long
      // silent wait. The cursor advances by `scanned` (not `exported`), so skipped or
      // already-backed saves still move it forward — the loop always terminates.
      let exported = 0;
      if (copyExisting) {
        backingExportProgress = { current: 0, total: 0 };
        let offset = 0;
        const maxBatches = 4000; // safety backstop (≥ any real library at 25/batch)
        for (let i = 0; i < maxBatches; i++) {
          let batch;
          try {
            batch = await api.exportSavesBatch(offset);
          } catch (err) {
            if (err instanceof RateLimitError) {
              await sleep(Math.min(err.retryAfter, 300) * 1000);
              continue; // retry the same offset after the cooldown
            }
            throw err;
          }
          exported += batch.exported;
          offset += batch.scanned;
          backingExportProgress = { current: Math.min(offset, batch.total), total: batch.total };
          if (batch.scanned === 0 || offset >= batch.total) break;
        }
      }

      configuring = null;
      backingExportProgress = null;
      backingSuccess = exported
        ? `Your saves are backed by ${providerLabel(provider)}. ${exported} existing ${exported === 1 ? 'save' : 'saves'} copied in.`
        : `Your saves are backed by ${providerLabel(provider)}.`;
      // Refresh the Saved list so it reflects the collection.
      try {
        await savesStore.load();
      } catch {
        // best-effort; the saved view reloads on next open
      }
    } catch (err) {
      backingExportProgress = null;
      if (err instanceof ScopeUpgradeError) {
        backingError = `Log in again to grant ${providerLabel(provider)} permissions, then turn this on.`;
      } else {
        backingError = err instanceof Error ? err.message : 'Failed to turn on backing.';
      }
    } finally {
      backingBusy = false;
    }
  }

  async function handleDisableBacking() {
    if (backingBusy) return;
    if (!syncStore.isOnline) {
      backingError = 'You are offline. Connect to the internet to change this.';
      return;
    }
    backingBusy = true;
    backingError = null;
    backingSuccess = null;
    try {
      const res = await api.setBacking({ action: 'disable' });
      backing = res.backing;
      backingSuccess = 'Backing is off. Your saves are on Skyreader again.';
      try {
        await savesStore.load();
      } catch {
        // best-effort
      }
    } catch (err) {
      backingError = err instanceof Error ? err.message : 'Failed to turn off backing.';
    } finally {
      backingBusy = false;
    }
  }
</script>

{#if !loaded}
  <p class="loading">Loading…</p>
{:else}
  <div class="engine-options">
    <!-- Skyreader -->
    <button
      class="engine-option"
      class:selected={backing.provider === 'skyreader'}
      onclick={() => backing.provider !== 'skyreader' && handleDisableBacking()}
      disabled={backingBusy}
      type="button"
    >
      <span class="engine-check" aria-hidden="true">
        {#if backing.provider === 'skyreader'}<Icon name="check" size={14} />{/if}
      </span>
      <span class="engine-info">
        <span class="engine-name">Skyreader</span>
        <span class="engine-desc">
          Saves stay on Skyreader, private to you. Nothing is published.
        </span>
      </span>
    </button>

    <!-- Semble / Margin -->
    {#each ['semble', 'margin'] as const as provider}
      <button
        class="engine-option"
        class:selected={backing.provider === provider}
        onclick={() => backing.provider !== provider && startConfigure(provider)}
        disabled={backingBusy}
        type="button"
      >
        <span class="engine-check" aria-hidden="true">
          {#if backing.provider === provider}<Icon name="check" size={14} />{/if}
        </span>
        <span class="engine-info">
          <span class="engine-name">{providerLabel(provider)}</span>
          <span class="engine-desc">
            Your Saved list becomes a {providerLabel(provider)} collection. Edit it in
            {providerLabel(provider)} or any Atmospheric app.
          </span>
        </span>
      </button>
    {/each}
  </div>

  <!-- Current backing summary -->
  {#if backing.provider !== 'skyreader' && configuring === null}
    <div class="backing-status">
      <p class="sync-time">
        Backed by {providerLabel(backing.provider)}.
        <a
          href="https://pdsls.dev/{backing.collectionUri}"
          target="_blank"
          rel="noopener noreferrer">View the collection</a
        >
      </p>
      <button class="btn btn-danger" onclick={handleDisableBacking} disabled={backingBusy}>
        {#if backingBusy}Working…{:else}Turn off backing{/if}
      </button>
    </div>
  {/if}

  <!-- Configure panel for a provider being enabled -->
  {#if configuring !== null}
    <div class="backing-config">
      {#if !scopeStatus[configuring]}
        <p class="setting-description" style="margin-top: 0;">
          Backing with {providerLabel(configuring)} needs permission to write to your
          {providerLabel(configuring)} collections.
        </p>
        <div class="backing-actions">
          <button class="btn btn-primary" onclick={reauthForScopes} type="button">
            Log in again to grant access
          </button>
          <button class="btn btn-secondary" onclick={cancelConfigure} type="button">
            Cancel
          </button>
        </div>
      {:else}
        <p class="config-label">Choose a collection</p>
        <div class="collection-picker" role="radiogroup" aria-label="Choose a collection">
          <!-- Default: create a fresh collection. Always available, even while
               existing collections are still loading. -->
          <label class="collection-option is-new" class:selected={chosenCollectionUri === ''}>
            <input type="radio" value="" bind:group={chosenCollectionUri} />
            <span class="collection-radio" aria-hidden="true"></span>
            <span class="collection-glyph" aria-hidden="true">
              <Icon name="folder-plus" size={18} />
            </span>
            <span class="collection-info">
              <span class="collection-name">Create a new collection</span>
              <span class="collection-meta">A fresh “Skyreader Saves” collection</span>
            </span>
          </label>

          {#if collectionsStore.loading[configuring] && allCollections.length === 0}
            <p class="loading">Loading your collections…</p>
          {:else if allCollections.length > 0}
            <div class="collection-sep" role="presentation"></div>

            {#if allCollections.length > COLLECTION_DISPLAY_LIMIT}
              <div class="collection-search-wrap">
                <span class="collection-search-icon" aria-hidden="true">
                  <Icon name="search" size={15} />
                </span>
                <input
                  class="collection-search"
                  type="search"
                  placeholder="Search your collections…"
                  bind:value={collectionSearch}
                  aria-label="Search your collections"
                />
              </div>
            {/if}

            {#if filteredCollections.length === 0 && collectionSearch.trim()}
              <p class="collection-empty">
                No collections match “{collectionSearch.trim()}”.
              </p>
            {:else}
              <div class="collection-list">
                {#each visibleCollections as col (col.uri)}
                  <label class="collection-option" class:selected={chosenCollectionUri === col.uri}>
                    <input type="radio" value={col.uri} bind:group={chosenCollectionUri} />
                    <span class="collection-radio" aria-hidden="true"></span>
                    <span class="collection-info">
                      <span class="collection-name">{col.name || 'Untitled'}</span>
                      {#if col.description}
                        <span class="collection-meta">{col.description}</span>
                      {/if}
                    </span>
                  </label>
                {/each}
              </div>
            {/if}

            {#if hiddenCount > 0}
              <p class="collection-more">
                Showing {visibleCollections.length} of {filteredCollections.length}. Search to find
                the rest.
              </p>
            {/if}
          {/if}
        </div>

        <div class="backing-warning">
          <strong>Backing publishes all of your saves publicly.</strong>
          Your {providerLabel(configuring)} collection is public, and there is no per-save exception.
          If you keep saves you would rather not share, leave this off.
        </div>

        {#if allowExport}
          <label class="toggle-setting export-toggle">
            <input type="checkbox" bind:checked={exportExisting} />
            <span>Also copy my existing saves into this collection</span>
          </label>
        {/if}

        {#if backingExportProgress}
          <div class="export-progress" aria-live="polite">
            <p class="config-label" style="margin-top: 0;">
              Copying your saves into {providerLabel(configuring)}…
            </p>
            <div
              class="progress-track"
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax={backingExportProgress.total}
              aria-valuenow={backingExportProgress.current}
            >
              <div
                class="progress-bar-fill"
                style="transform: scaleX({backingExportProgress.total > 0
                  ? backingExportProgress.current / backingExportProgress.total
                  : 0})"
              ></div>
            </div>
            <p class="progress-count">
              {backingExportProgress.current} / {backingExportProgress.total}
            </p>
          </div>
        {:else}
          <div class="backing-actions">
            <button class="btn btn-primary" onclick={handleEnableBacking} disabled={backingBusy}>
              {#if backingBusy}Turning on…{:else}Use {providerLabel(configuring)}{/if}
            </button>
            <button
              class="btn btn-secondary"
              onclick={cancelConfigure}
              disabled={backingBusy}
              type="button"
            >
              Cancel
            </button>
          </div>
        {/if}
      {/if}
    </div>
  {/if}

  {#if backingError}
    <p class="sync-error">{backingError}</p>
  {/if}
  {#if backingSuccess}
    <p class="sync-success">{backingSuccess}</p>
  {/if}
{/if}

<style>
  .loading {
    color: var(--color-text-secondary);
    font-style: italic;
  }

  .sync-time {
    font-size: var(--text-md);
    color: var(--color-text-secondary);
    margin: 0.25rem 0;
  }

  .sync-error {
    color: var(--color-danger);
    font-size: var(--text-md);
    margin-top: 0.5rem;
  }

  .sync-success {
    color: var(--color-success, #22c55e);
    font-size: var(--text-md);
    margin-top: 0.5rem;
  }

  .setting-description {
    font-size: var(--text-md);
    color: var(--color-text-secondary);
    margin: 0.5rem 0 0 0;
  }

  .toggle-setting {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
  }

  .toggle-setting input[type='checkbox'] {
    width: 1rem;
    height: 1rem;
    cursor: pointer;
  }

  /* External-backed saves: engine picker */
  .engine-options {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 1rem;
  }

  .engine-option {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    width: 100%;
    text-align: left;
    padding: 0.75rem;
    background: var(--color-bg);
    border: 2px solid var(--color-border);
    border-radius: 8px;
    cursor: pointer;
    transition:
      border-color 0.15s,
      background-color 0.15s;
  }

  .engine-option:hover:not(:disabled) {
    border-color: var(--color-primary);
  }

  .engine-option.selected {
    border-color: var(--color-primary);
    background: var(--color-sidebar-active);
  }

  .engine-option:disabled {
    cursor: default;
    opacity: 0.7;
  }

  .engine-check {
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    margin-top: 0.1rem;
    border: 1.5px solid var(--color-border);
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-primary);
  }

  .engine-option.selected .engine-check {
    border-color: var(--color-primary);
  }

  .engine-info {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 0;
  }

  .engine-name {
    font-weight: var(--weight-medium);
    color: var(--color-text);
  }

  .engine-desc {
    font-size: var(--text-md);
    color: var(--color-text-secondary);
  }

  .backing-status {
    margin-top: 1rem;
  }

  .backing-config {
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid var(--color-border);
  }

  .config-label {
    font-size: var(--text-md);
    color: var(--color-text-secondary);
    margin: 0 0 0.5rem 0;
  }

  .collection-picker {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin-bottom: 1rem;
  }

  /* Selectable rows mirror the .engine-option vocabulary used above, so the
     collection list reads as part of the same choice, not a new control. */
  .collection-option {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.65rem;
    width: 100%;
    padding: 0.55rem 0.7rem;
    background: var(--color-bg);
    border: 1.5px solid var(--color-border);
    border-radius: 8px;
    cursor: pointer;
    transition:
      border-color 0.15s ease,
      background-color 0.15s ease;
  }

  .collection-option:hover {
    border-color: var(--color-primary);
  }

  .collection-option.selected {
    border-color: var(--color-primary);
    background: var(--color-sidebar-active);
  }

  /* Native radio stays present for keyboard + group semantics, visually hidden
     in favor of the custom .collection-radio dot. */
  .collection-option input[type='radio'] {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }

  .collection-option:has(input:focus-visible) {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  .collection-radio {
    flex-shrink: 0;
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border: 1.5px solid var(--color-border);
    border-radius: 50%;
    transition: border-color 0.15s ease;
  }

  .collection-radio::after {
    content: '';
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--color-primary);
    transform: scale(0);
    transition: transform 0.15s cubic-bezier(0.22, 1, 0.36, 1);
  }

  .collection-option.selected .collection-radio {
    border-color: var(--color-primary);
  }

  .collection-option.selected .collection-radio::after {
    transform: scale(1);
  }

  .collection-glyph {
    flex-shrink: 0;
    display: flex;
    color: var(--color-text-secondary);
    transition: color 0.15s ease;
  }

  .collection-option.is-new.selected .collection-glyph {
    color: var(--color-primary);
  }

  .collection-info {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    min-width: 0;
  }

  .collection-name {
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    color: var(--color-text);
  }

  .collection-meta {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .collection-sep {
    height: 1px;
    background: var(--color-border);
    margin: 0.25rem 0;
  }

  .collection-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    max-height: 14rem;
    overflow-y: auto;
    /* Room so focus outlines on edge rows aren't clipped by the scroll box. */
    padding: 2px;
    margin: -2px;
  }

  .collection-search-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }

  .collection-search-icon {
    position: absolute;
    left: 0.6rem;
    display: flex;
    color: var(--color-text-secondary);
    pointer-events: none;
  }

  .collection-search {
    width: 100%;
    padding: 0.45rem 0.6rem 0.45rem 2rem;
    font-size: var(--text-md);
    color: var(--color-text);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    transition: border-color 0.15s ease;
  }

  .collection-search:focus {
    outline: none;
    border-color: var(--color-primary);
  }

  .collection-empty {
    font-size: var(--text-md);
    color: var(--color-text-secondary);
    text-align: center;
    padding: 0.85rem 0.5rem;
    margin: 0;
  }

  .collection-more {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    margin: 0.1rem 0 0 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .collection-option,
    .collection-radio,
    .collection-radio::after,
    .collection-glyph,
    .collection-search {
      transition: none;
    }
  }

  .backing-warning {
    font-size: var(--text-md);
    color: var(--color-text);
    background: var(--color-bg-secondary);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 0.75rem;
    margin-bottom: 1rem;
  }

  .backing-warning strong {
    color: var(--color-warning);
  }

  .export-toggle {
    margin-bottom: 1rem;
  }

  .backing-actions {
    display: flex;
    gap: 0.5rem;
  }

  .export-progress {
    margin-top: 0.75rem;
  }

  .progress-track {
    height: 8px;
    background: var(--color-border);
    border-radius: 4px;
    overflow: hidden;
    margin: 0.5rem 0;
  }

  /* Scale a full-width bar on the X axis (transform, not width) so the fill animates
     without layout thrash. transform-origin keeps it growing from the left. */
  .progress-bar-fill {
    height: 100%;
    width: 100%;
    transform-origin: left center;
    background: var(--color-primary);
    transition: transform 0.2s ease;
  }

  .progress-count {
    margin: 0;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
  }
</style>
