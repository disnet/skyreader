<script lang="ts">
  import Icon from './Icon.svelte';

  // One toolbar for the whole Discover page: a single search that filters every
  // section, and "Hide added". Each section used to carry its own copy.
  interface Props {
    /** Free-text filter, owned by the page and passed to each section. */
    query: string;
    /** "Hide added": drop rows the user already subscribes to. Off by default. */
    hideAdded: boolean;
    /** Placeholder + aria-label for the search input. */
    searchLabel: string;
  }
  let { query = $bindable(''), hideAdded = $bindable(false), searchLabel }: Props = $props();
</script>

<div class="discovery-toolbar">
  <div class="search">
    <Icon name="search" size={16} />
    <input type="search" placeholder={searchLabel} aria-label={searchLabel} bind:value={query} />
  </div>
  <label class="hide-added">
    <input type="checkbox" bind:checked={hideAdded} />
    Hide added
  </label>
</div>

<style>
  .discovery-toolbar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  /* Matches the Sources page search field. */
  .search {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    color: var(--color-text-secondary);
    background: var(--color-bg-secondary, rgba(0, 0, 0, 0.04));
    border-radius: var(--radius-lg, 8px);
  }

  .search input {
    flex: 1;
    min-width: 0;
    font: inherit;
    font-size: var(--text-md);
    color: var(--color-text);
    background: transparent;
    border: none;
    outline: none;
    padding: 0;
  }

  .search:focus-within {
    outline: 2px solid var(--color-primary);
    outline-offset: -1px;
  }

  .search input::placeholder {
    color: var(--color-text-secondary);
  }

  .hide-added {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    min-height: 36px;
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
</style>
