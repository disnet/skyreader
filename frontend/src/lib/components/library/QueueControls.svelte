<script lang="ts">
  // The Queue's own controls, in the page body under the Library switch, laid
  // out like the Shelf's (a segmented group, then a sort menu) so moving
  // between the two halves of the Library keeps everything where it was.
  import { feedViewStore } from '$lib/stores/feedView.svelte';

  const VIEWS = [
    { value: 'inbox', label: 'Inbox' },
    { value: 'archive', label: 'Archive' },
  ] as const;

  // Anything but 'oldest' shows as newest (see feedViewStore.toggleSortOrder).
  let order = $derived(feedViewStore.currentSortOrder === 'oldest' ? 'oldest' : 'newest');
</script>

<div class="queue-controls">
  <div class="segments" role="group" aria-label="Queue view">
    {#each VIEWS as option (option.value)}
      <button
        class="segment"
        class:active={feedViewStore.savedView === option.value}
        aria-pressed={feedViewStore.savedView === option.value}
        onclick={() => feedViewStore.setSavedView(option.value)}>{option.label}</button
      >
    {/each}
  </div>
  {#if !feedViewStore.isSavedChannel}
    <select
      class="sort"
      aria-label="Sort"
      value={order}
      onchange={(e) => {
        if (e.currentTarget.value !== order) {
          feedViewStore.toggleSortOrder();
        }
      }}
    >
      <option value="newest">Newest first</option>
      <option value="oldest">Oldest first</option>
    </select>
  {/if}
</div>

<style>
  .queue-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .segments {
    display: inline-flex;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    overflow: hidden;
  }

  .segment {
    padding: 0.4rem 0.75rem;
    border: none;
    background: none;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .segment + .segment {
    border-left: 1px solid var(--color-border);
  }

  .segment:hover {
    color: var(--color-text);
  }

  .segment.active {
    color: var(--color-primary);
    background: var(--color-sidebar-active);
  }

  .segment:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
  }

  .sort {
    padding-top: 0.4rem;
    padding-bottom: 0.4rem;
    font-size: var(--text-sm);
  }
</style>
