<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';

  interface Props {
    searchQuery: string;
    onSearchChange: (value: string) => void;
    /** Opens the Add modal (which handles the guest sign-in case itself). */
    onAdd: () => void;
  }

  let { searchQuery, onSearchChange, onAdd }: Props = $props();
</script>

<div class="sources-toolbar">
  <div class="search-wrapper">
    <Icon name="search" size={16} />
    <input
      type="text"
      value={searchQuery}
      oninput={(e) => onSearchChange(e.currentTarget.value)}
      placeholder="Search sources..."
      class="search-input"
    />
  </div>

  <button class="add-btn" onclick={onAdd} aria-haspopup="dialog" aria-label="Add source">
    <Icon name="plus" size={16} />
    <span class="add-label">Add source</span>
  </button>
</div>

<style>
  .sources-toolbar {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-bottom: 1rem;
  }

  .search-wrapper {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: var(--color-bg-secondary, rgba(0, 0, 0, 0.04));
    border-radius: 8px;
    padding: 0.5rem 0.75rem;
    color: var(--color-text-secondary);
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

  .add-btn {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 0.75rem;
    border: none;
    border-radius: 8px;
    background: var(--color-primary);
    color: #fff;
    cursor: pointer;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    white-space: nowrap;
    flex-shrink: 0;
    transition: background-color 0.2s;
  }

  .add-btn:hover {
    background: var(--color-primary-dark, #0052a3);
  }

  @media (max-width: 640px) {
    .add-label {
      display: none;
    }
  }

  @media (prefers-color-scheme: dark) {
    .search-wrapper {
      background: var(--color-bg-secondary, rgba(255, 255, 255, 0.06));
    }
  }
</style>
