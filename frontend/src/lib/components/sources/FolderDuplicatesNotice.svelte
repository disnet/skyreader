<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';
  import type { CaseDuplicate } from '$lib/utils/folders';

  // Folders whose names differ only in capitalization, usually from imports
  // that spelled one folder two ways. One tap merges each set.
  interface Props {
    sets: CaseDuplicate[];
    onMerge: (set: CaseDuplicate) => Promise<void>;
  }

  let { sets, onMerge }: Props = $props();

  let busy = $state<string | null>(null);

  async function merge(set: CaseDuplicate) {
    busy = set.keep;
    try {
      await onMerge(set);
    } finally {
      busy = null;
    }
  }

  function names(set: CaseDuplicate): string {
    const all = [set.keep, ...set.others].map((n) => `“${n}”`);
    return all.length === 2
      ? all.join(' and ')
      : `${all.slice(0, -1).join(', ')} and ${all.at(-1)}`;
  }
</script>

<div class="dupes-notice">
  <div class="dupes-head">
    <Icon name="folder" size={18} />
    <p class="dupes-title">
      {sets.length === 1 && sets[0].others.length === 1
        ? 'Two folders differ only in capitalization'
        : 'Some folders differ only in capitalization'}
    </p>
  </div>
  <ul class="dupes-list">
    {#each sets as set (set.keep)}
      <li class="dupes-row">
        <span class="dupes-names">{names(set)}</span>
        <button class="dupes-merge" onclick={() => merge(set)} disabled={busy !== null}>
          {busy === set.keep ? 'Merging…' : `Merge into “${set.keep}”`}
        </button>
      </li>
    {/each}
  </ul>
</div>

<style>
  .dupes-notice {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.875rem;
    margin-bottom: 1.5rem;
    background: var(--color-bg-secondary);
    border: 1px solid var(--color-border);
    border-radius: 8px;
  }

  .dupes-head {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    color: var(--color-primary);
  }

  .dupes-title {
    margin: 0;
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    color: var(--color-text);
  }

  .dupes-list {
    list-style: none;
    margin: 0;
    padding: 0 0 0 1.875rem;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .dupes-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.25rem 0.75rem;
  }

  .dupes-names {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .dupes-merge {
    padding: 0.3125rem 0.75rem;
    border: 1px solid var(--color-primary);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-primary);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    cursor: pointer;
  }

  .dupes-merge:hover:not(:disabled) {
    background: var(--color-primary);
    color: #fff;
  }

  .dupes-merge:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
