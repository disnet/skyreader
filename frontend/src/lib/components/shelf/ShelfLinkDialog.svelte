<script lang="ts">
  // Link a Shelf collection to one of the reader's Semble or Margin collections,
  // which the server then keeps in step both ways (services/shelf-link.ts). The
  // reader picks a provider, then one of their collections there or a new one
  // named after this one. The foreign collection is public, so the dialog says
  // so before anything is linked, and says that uploads stay behind.
  import { page } from '$app/state';
  import Modal from '$lib/components/common/Modal.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { api, ScopeUpgradeError } from '$lib/services/api';
  import { auth } from '$lib/stores/auth.svelte';
  import { collectionsStore } from '$lib/stores/collections.svelte';
  import { shelfStore } from '$lib/stores/shelf.svelte';
  import type { ShelfCollection } from '$lib/types';

  interface Props {
    open: boolean;
    collection: ShelfCollection;
    onclose: () => void;
  }

  let { open, collection, onclose }: Props = $props();

  type Provider = 'semble' | 'margin';
  const label = (p: Provider) => (p === 'semble' ? 'Semble' : 'Margin');
  const DISPLAY_LIMIT = 8;

  let provider = $state<Provider>('semble');
  // '' = make a new collection named after this one.
  let chosenUri = $state('');
  let search = $state('');
  let scopes = $state<Record<Provider, boolean> | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);

  let all = $derived(collectionsStore.collections[provider]);
  let filtered = $derived.by(() => {
    const q = search.trim().toLowerCase();
    return q ? all.filter((c) => (c.name || '').toLowerCase().includes(q)) : all;
  });
  let visible = $derived(filtered.slice(0, DISPLAY_LIMIT));
  let granted = $derived(scopes?.[provider] ?? false);

  // Each open starts fresh, and asks which providers Skyreader may write to.
  $effect(() => {
    if (!open) return;
    provider = 'semble';
    chosenUri = '';
    search = '';
    error = null;
    scopes = null;
    api
      .getIntegrationStatus()
      .then((status) => (scopes = status.scopeStatus))
      .catch(() => (scopes = { semble: false, margin: false }));
  });

  $effect(() => {
    if (open && granted) void collectionsStore.loadAndRefresh(provider);
  });

  function choose(next: Provider) {
    if (next === provider) return;
    provider = next;
    chosenUri = '';
    search = '';
    error = null;
  }

  async function submit() {
    if (busy || !granted) return;
    busy = true;
    error = null;
    try {
      await shelfStore.link(collection.id, provider, chosenUri || undefined);
      if (!chosenUri) void collectionsStore.invalidate(provider);
      onclose();
    } catch (e) {
      if (e instanceof ScopeUpgradeError) {
        scopes = { ...(scopes ?? { semble: false, margin: false }), [provider]: false };
        error = `${label(provider)} needs your permission first.`;
      } else {
        error = e instanceof Error && e.message ? e.message : "Couldn't link the collection.";
      }
    } finally {
      busy = false;
    }
  }
</script>

<Modal
  {open}
  onclose={() => !busy && onclose()}
  title="Link to Semble or Margin"
  icon="link"
  description="Add here or there, and it shows up in both."
  maxWidth="440px"
>
  <div class="providers" role="radiogroup" aria-label="Where to link">
    {#each ['semble', 'margin'] as const as p (p)}
      <button
        type="button"
        role="radio"
        aria-checked={provider === p}
        class="provider"
        class:selected={provider === p}
        onclick={() => choose(p)}
        disabled={busy}
      >
        {label(p)}
      </button>
    {/each}
  </div>

  {#if scopes === null}
    <p class="muted">Checking permissions…</p>
  {:else if !granted}
    <p class="muted">
      Linking needs permission to write to your {label(provider)} collections.
    </p>
    <button
      type="button"
      class="primary-btn"
      onclick={() => auth.grantPermissions([provider], page.url.pathname + page.url.search)}
      disabled={auth.grantingPermissions}
    >
      Allow {label(provider)} access
    </button>
  {:else}
    <div class="choices" role="radiogroup" aria-label="Choose a collection">
      <label class="choice" class:selected={chosenUri === ''}>
        <input type="radio" value="" bind:group={chosenUri} disabled={busy} />
        <Icon name="folder-plus" size={16} />
        <span class="choice-text">
          <span class="choice-name">New collection</span>
          <span class="choice-meta">“{collection.name}” in {label(provider)}</span>
        </span>
      </label>

      {#if collectionsStore.loading[provider] && all.length === 0}
        <p class="muted">Loading your collections…</p>
      {:else if all.length > 0}
        {#if all.length > DISPLAY_LIMIT}
          <input
            class="search"
            type="search"
            placeholder="Search your collections…"
            aria-label="Search your collections"
            bind:value={search}
          />
        {/if}
        {#each visible as c (c.uri)}
          <label class="choice" class:selected={chosenUri === c.uri}>
            <input type="radio" value={c.uri} bind:group={chosenUri} disabled={busy} />
            <Icon name="folder" size={16} />
            <span class="choice-text">
              <span class="choice-name">{c.name || 'Untitled'}</span>
              {#if c.description}<span class="choice-meta">{c.description}</span>{/if}
            </span>
          </label>
        {/each}
        {#if filtered.length > visible.length}
          <p class="muted small">
            Showing {visible.length} of {filtered.length}. Search to find the rest.
          </p>
        {/if}
      {/if}
    </div>

    <p class="notice">
      <strong>The {label(provider)} collection is public.</strong>
      Anyone can see what's in it. Your highlights and notes stay in Skyreader, and uploaded files stay
      private and aren't copied over.
    </p>
  {/if}

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#snippet footer()}
    <div class="actions">
      <button type="button" class="text-btn" onclick={onclose} disabled={busy}>Cancel</button>
      <button type="button" class="primary-btn" onclick={submit} disabled={busy || !granted}>
        {busy ? 'Linking…' : 'Link collection'}
      </button>
    </div>
  {/snippet}
</Modal>

<style>
  .providers {
    display: flex;
    gap: 0.25rem;
    padding: 0.2rem;
    margin-bottom: 1rem;
    border-radius: 8px;
    background: var(--color-bg-secondary);
  }

  .provider {
    flex: 1;
    padding: 0.4rem 0.5rem;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    cursor: pointer;
  }

  .provider.selected {
    background: var(--color-bg);
    color: var(--color-text);
  }

  .choices {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .choice {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.5rem 0.65rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .choice.selected {
    border-color: var(--color-primary);
    color: var(--color-primary);
  }

  .choice input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }

  .choice:has(input:focus-visible) {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  .choice-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .choice-name {
    color: var(--color-text);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }

  .choice-meta {
    overflow: hidden;
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .search {
    width: 100%;
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-sm);
  }

  .notice {
    margin: 1rem 0 0;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    line-height: 1.45;
  }

  .notice strong {
    color: var(--color-text);
  }

  .muted {
    margin: 0.25rem 0 0.75rem;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }

  .muted.small {
    margin: 0.25rem 0 0;
    font-size: var(--text-xs);
  }

  .error {
    margin: 0.75rem 0 0;
    color: var(--color-error);
    font-size: var(--text-sm);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  .text-btn {
    padding: 0.375rem 0.5rem;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .text-btn:hover:not(:disabled) {
    color: var(--color-text);
    background: var(--color-bg-secondary);
  }

  .primary-btn {
    padding: 0.375rem 0.875rem;
    border: none;
    border-radius: 6px;
    background: var(--color-primary);
    color: #fff;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    cursor: pointer;
  }

  .primary-btn:disabled,
  .text-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
