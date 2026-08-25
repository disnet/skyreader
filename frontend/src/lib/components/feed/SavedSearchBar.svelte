<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';
  import { savedSearchStore } from '$lib/stores/savedSearch.svelte';

  let inputEl = $state<HTMLInputElement | null>(null);

  // The store bumps `focusRequest` when the toolbar button or `/` opens search;
  // take focus on each bump so re-triggering `/` refocuses an already-open row.
  $effect(() => {
    const _ = savedSearchStore.focusRequest;
    inputEl?.focus();
    inputEl?.select();
  });

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      savedSearchStore.close();
    }
  }
</script>

<div class="search-row">
  <div class="search-wrapper">
    <Icon name="search" size={16} />
    <input
      bind:this={inputEl}
      type="search"
      class="search-input"
      value={savedSearchStore.query}
      oninput={(e) => savedSearchStore.setQuery(e.currentTarget.value)}
      onkeydown={handleKeydown}
      placeholder="Search saved…"
      aria-label="Search saved items"
      data-testid="saved-search-input"
    />
    {#if savedSearchStore.query}
      <button
        class="clear-btn"
        onclick={() => {
          savedSearchStore.clear();
          inputEl?.focus();
        }}
        aria-label="Clear search"
        title="Clear search"
      >
        <Icon name="x" size={14} />
      </button>
    {/if}
  </div>
</div>

<style>
  /* Sits directly under the header (desktop) or at the top of the list
     (mobile, where the header is replaced by the bottom bar). Flat, one row,
     no shadow — it's part of the page, not floating over it. */
  .search-row {
    max-width: 800px;
    margin: 0 auto;
    padding: 0 1rem 0.625rem;
  }

  .search-wrapper {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: var(--color-bg-secondary, rgba(0, 0, 0, 0.04));
    border-radius: 8px;
    padding: 0.5rem 0.75rem;
    color: var(--color-text-secondary);
  }

  /* The input's own outline would ring a borderless field inside the pill; the
     pill carries the focus treatment instead, so tabbing back in is still
     visible (auto-focus on open only covers the mouse/`/` path). */
  .search-wrapper:focus-within {
    box-shadow: 0 0 0 2px var(--color-primary);
  }

  .search-input {
    flex: 1;
    min-width: 0;
    border: none;
    background: none;
    font: inherit;
    font-size: var(--text-md);
    color: var(--color-text);
    outline: none;
  }

  /* iOS Safari zooms the viewport when a focused input is smaller than 16px. */
  @media (hover: none) and (pointer: coarse) {
    .search-input {
      font-size: 1rem;
    }
  }

  .search-input::placeholder {
    color: var(--color-text-secondary);
  }

  /* The browser's own clear affordance duplicates the button below. */
  .search-input::-webkit-search-cancel-button {
    display: none;
  }

  .clear-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: none;
    padding: 0.125rem;
    cursor: pointer;
    color: var(--color-text-secondary);
  }

  .clear-btn:hover {
    color: var(--color-text);
  }
</style>
