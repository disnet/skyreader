<script lang="ts">
  // Link a Shelf collection to one of the reader's Semble or Margin collections,
  // which the server then keeps in step both ways (services/shelf-link.ts). The
  // reader picks a provider, then one of their collections there or a new one
  // named after this one. The foreign collection is public, so the dialog says
  // so before anything is linked, and says that uploads stay behind.
  //
  // With no `collection`, it imports instead: the reader picks one of their
  // collections there, and it comes in as a new Shelf collection, linked.
  import { page } from '$app/state';
  import Modal from '$lib/components/common/Modal.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { api, ScopeUpgradeError } from '$lib/services/api';
  import { auth } from '$lib/stores/auth.svelte';
  import { collectionsStore } from '$lib/stores/collections.svelte';
  import { saveBackingStore } from '$lib/stores/saveBacking.svelte';
  import { shelfStore, uploadsStay } from '$lib/stores/shelf.svelte';
  import type { ShelfCollection } from '$lib/types';

  interface Props {
    open: boolean;
    /** The Shelf collection to link; absent to import one as a new collection. */
    collection?: ShelfCollection;
    onclose: () => void;
    /** After an import, with the new Shelf collection's id. */
    onimported?: (id: string) => void;
  }

  let { open, collection, onclose, onimported }: Props = $props();
  let importing = $derived(!collection);

  type Provider = 'semble' | 'margin';
  const label = (p: Provider) => (p === 'semble' ? 'Semble' : 'Margin');

  let provider = $state<Provider>('semble');
  // '' = make a new collection named after this one.
  let chosenUri = $state('');
  let search = $state('');
  let scopes = $state<Record<Provider, boolean> | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);

  // Each foreign collection links to one Shelf collection, so those already
  // linked aren't offered again; nor is the one backing the whole Library,
  // which the server refuses.
  let linkedUris = $derived(
    new Set(
      [
        ...shelfStore.collections.map((c) => c.link?.uri),
        saveBackingStore.backing?.provider === provider
          ? saveBackingStore.backing.collectionUri
          : null,
      ].filter((u): u is string => !!u)
    )
  );
  let all = $derived(collectionsStore.collections[provider].filter((c) => !linkedUris.has(c.uri)));
  // Readers can keep hundreds of collections: alphabetical, so a name stays
  // where you'd look for it, narrowed by name or description as you type.
  let sorted = $derived(
    [...all].sort((a, b) =>
      (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' })
    )
  );
  let filtered = $derived.by(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter(
      (c) =>
        (c.name || '').toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q)
    );
  });
  let granted = $derived(scopes?.[provider] ?? false);
  // What linking does with what's here, so a collection of uploads doesn't
  // look broken when nothing shows up over there.
  let split = $derived(
    open && collection ? shelfStore.linkSplit(collection.id) : { linkable: 0, uploads: 0, other: 0 }
  );
  let articles = $derived(split.linkable === 1 ? '1 article' : `${split.linkable} articles`);

  // Each open starts fresh, and asks which providers Skyreader may write to.
  $effect(() => {
    if (!open) return;
    provider = 'semble';
    chosenUri = '';
    search = '';
    error = null;
    scopes = null;
    if (!saveBackingStore.loaded) void saveBackingStore.load();
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
      if (!collection) {
        const chosen = all.find((c) => c.uri === chosenUri);
        if (!chosen) {
          chosenUri = '';
          error = 'That collection is no longer there. Pick another.';
          return;
        }
        const id = await shelfStore.importLinked(
          provider,
          chosen.uri,
          chosen.name ?? '',
          chosen.description ?? null
        );
        if (!id) {
          error = "Couldn't make the collection here.";
          return;
        }
        onclose();
        onimported?.(id);
        return;
      }
      await shelfStore.link(collection.id, provider, chosenUri || undefined);
      if (!chosenUri) void collectionsStore.invalidate(provider);
      onclose();
    } catch (e) {
      if (e instanceof ScopeUpgradeError) {
        scopes = { ...(scopes ?? { semble: false, margin: false }), [provider]: false };
        error = `${label(provider)} needs your permission first.`;
      } else {
        error =
          e instanceof Error && e.message
            ? e.message
            : importing
              ? "Couldn't import the collection."
              : "Couldn't link the collection.";
      }
    } finally {
      busy = false;
    }
  }
</script>

<Modal
  {open}
  onclose={() => !busy && onclose()}
  title={importing ? 'Import from Semble or Margin' : 'Link to Semble or Margin'}
  icon="link"
  description={importing
    ? 'It comes in as a new collection, and stays in step both ways.'
    : 'Add here or there, and it shows up in both.'}
  maxWidth="440px"
>
  <div
    class="providers"
    role="radiogroup"
    aria-label={importing ? 'Where to import from' : 'Where to link'}
  >
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
      {importing ? 'Importing' : 'Linking'} needs permission to write to your {label(provider)} collections.
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
    {#if all.length > 0}
      <input
        class="search"
        type="search"
        placeholder="Search your {label(provider)} collections…"
        aria-label="Search your collections"
        bind:value={search}
      />
    {/if}
    <div class="choices" role="radiogroup" aria-label="Choose a collection">
      {#if collection}
        <label class="choice" class:selected={chosenUri === ''}>
          <input type="radio" value="" bind:group={chosenUri} disabled={busy} />
          <Icon name="folder-plus" size={16} />
          <span class="choice-text">
            <span class="choice-name">New collection</span>
            <span class="choice-meta">“{collection.name}” in {label(provider)}</span>
          </span>
        </label>
      {/if}

      {#if collectionsStore.loading[provider] && all.length === 0}
        <p class="muted">Loading your collections…</p>
      {:else if importing && all.length === 0}
        <p class="muted">
          {collectionsStore.error[provider]
            ? `Couldn't load your ${label(provider)} collections.`
            : `No ${label(provider)} collections to import.`}
        </p>
      {:else if all.length > 0}
        <div class="list">
          {#each filtered as c (c.uri)}
            <label class="choice" class:selected={chosenUri === c.uri}>
              <input type="radio" value={c.uri} bind:group={chosenUri} disabled={busy} />
              <Icon name="folder" size={16} />
              <span class="choice-text">
                <span class="choice-name">{c.name || 'Untitled'}</span>
                {#if c.description}<span class="choice-meta">{c.description}</span>{/if}
              </span>
            </label>
          {:else}
            <p class="muted small">No collections match “{search.trim()}”.</p>
          {/each}
        </div>
      {/if}
    </div>

    {#if split.linkable > 0 || split.uploads > 0 || split.other > 0}
      <p class="split">
        {#if split.linkable > 0}
          {#if chosenUri}
            {articles} here will join it, and what's already in it comes here.
          {:else}
            {articles} will be added to {label(provider)}.
          {/if}
        {:else if split.other === 0}
          Everything here is an uploaded file, so nothing will be added to {label(provider)} yet. Articles
          you add later will be.
        {:else}
          Nothing here can be added to {label(provider)} yet. Articles you add later will be.
        {/if}
        {#if split.linkable > 0 && split.uploads > 0}
          {uploadsStay(split.uploads)} in Skyreader.
        {/if}
      </p>
    {/if}

    <p class="notice">
      <strong>The {label(provider)} collection is public.</strong>
      Anyone can see what's in it. Your highlights and notes stay in Skyreader{#if split.uploads === 0},
        and uploaded files stay private and aren't copied over{/if}.
    </p>
  {/if}

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#snippet footer()}
    <div class="actions">
      <button type="button" class="text-btn" onclick={onclose} disabled={busy}>Cancel</button>
      <button
        type="button"
        class="primary-btn"
        onclick={submit}
        disabled={busy || !granted || (importing && (!chosenUri || shelfStore.loading))}
      >
        {#if importing}{busy ? 'Importing…' : 'Import collection'}{:else}{busy
            ? 'Linking…'
            : 'Link collection'}{/if}
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

  .list {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    max-height: min(18rem, 40vh);
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .search {
    width: 100%;
    margin-bottom: 0.5rem;
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-sm);
  }

  .split {
    margin: 1rem 0 0;
    color: var(--color-text);
    font-size: var(--text-sm);
    line-height: 1.45;
  }

  .split + .notice {
    margin-top: 0.5rem;
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
