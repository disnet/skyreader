<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';

  interface Props {
    searchQuery: string;
    onSearchChange: (value: string) => void;
    onAddRss: () => void;
    onAddHandle: () => void;
  }

  let { searchQuery, onSearchChange, onAddRss, onAddHandle }: Props = $props();
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
  <button class="add-btn" onclick={onAddRss}>
    <Icon name="plus" size={16} />
    <span>Add RSS</span>
  </button>
  <button class="add-btn" onclick={onAddHandle}>
    <Icon name="at-sign" size={16} />
    <span>Add @handle</span>
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
    border: none;
    background: none;
    font: inherit;
    font-size: 0.875rem;
    color: var(--color-text);
    outline: none;
  }

  .search-input::placeholder {
    color: var(--color-text-secondary);
  }

  .add-btn {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: none;
    cursor: pointer;
    font-size: 0.8125rem;
    color: var(--color-text);
    white-space: nowrap;
  }

  .add-btn:hover {
    background: var(--color-bg-hover);
  }

  @media (max-width: 640px) {
    .sources-toolbar {
      flex-wrap: wrap;
    }

    .add-btn span {
      display: none;
    }
  }

  @media (prefers-color-scheme: dark) {
    .search-wrapper {
      background: var(--color-bg-secondary, rgba(255, 255, 255, 0.06));
    }
  }
</style>
