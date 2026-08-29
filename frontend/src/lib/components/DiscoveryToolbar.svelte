<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';

  interface Props {
    /** Free-text filter, owned by the parent so it can drive its own predicates. */
    query: string;
    /** "Hide added": drop rows the user already subscribes to. Off by default. */
    hideAdded: boolean;
    /** Placeholder + aria-label for the search input. */
    searchLabel: string;
    /** The count line — each surface phrases its own totals. */
    count: Snippet;
  }
  let { query = $bindable(''), hideAdded = $bindable(false), searchLabel, count }: Props = $props();
</script>

<div class="discovery-toolbar">
  <p class="count">{@render count()}</p>
  <div class="controls">
    <label class="hide-added">
      <input type="checkbox" bind:checked={hideAdded} />
      Hide added
    </label>
    <div class="search">
      <Icon name="search" size={15} />
      <input type="search" placeholder={searchLabel} aria-label={searchLabel} bind:value={query} />
    </div>
  </div>
</div>

<style>
  .discovery-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-bottom: 0.25rem;
  }

  .count {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    margin: 0;
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .hide-added {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    cursor: pointer;
    user-select: none;
  }

  .hide-added:hover {
    color: var(--color-text);
  }

  .hide-added input {
    margin: 0;
    accent-color: var(--color-primary);
    cursor: pointer;
  }

  .search {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.625rem;
    color: var(--color-text-secondary);
    background: var(--color-bg-secondary, rgba(0, 0, 0, 0.04));
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 6px);
    transition: border-color 0.15s;
  }

  .search:focus-within {
    border-color: var(--color-primary);
  }

  .search input {
    width: 14rem;
    max-width: 100%;
    font: inherit;
    font-size: var(--text-sm);
    color: var(--color-text);
    background: transparent;
    border: none;
    outline: none;
    padding: 0;
  }

  .search input::placeholder {
    color: var(--color-text-secondary);
  }

  @media (max-width: 520px) {
    .controls {
      width: 100%;
    }

    .search {
      flex: 1;
    }

    .search input {
      width: 100%;
    }
  }
</style>
