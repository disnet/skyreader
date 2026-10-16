<script lang="ts">
  // The Queue's own controls, in the page body under the Library switch, laid
  // out like the Shelf's (a segmented group, then a sort menu) so moving
  // between the two halves of the Library keeps everything where it was. It
  // shares a row with the Library switch; when that row runs out of room (a
  // phone) the labels give way to icons — see the `library-row` container query.
  import Icon from '$lib/components/Icon.svelte';
  import { feedViewStore } from '$lib/stores/feedView.svelte';

  const VIEWS = [
    { value: 'inbox', label: 'Inbox', icon: 'inbox' },
    { value: 'archive', label: 'Archive', icon: 'archive' },
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
        title={option.label}
        onclick={() => feedViewStore.setSavedView(option.value)}
      >
        <span class="segment-icon" aria-hidden="true"><Icon name={option.icon} size={16} /></span>
        <span class="segment-label">{option.label}</span>
      </button>
    {/each}
  </div>
  {#if !feedViewStore.isSavedChannel}
    <span class="sort-wrap">
      <span class="sort-icon" aria-hidden="true">
        <Icon name={order === 'oldest' ? 'arrow-up' : 'arrow-down'} size={16} />
      </span>
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
    </span>
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
    display: inline-flex;
    align-items: center;
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

  .sort-wrap {
    position: relative;
    display: inline-flex;
  }

  .segment-icon,
  .sort-icon {
    display: none;
  }

  /* Too narrow for the Library switch, these segments and the sort menu side by
     side: drop to icons. The labels stay as the accessible names (and the
     select keeps its options), only their text goes. */
  @container library-row (max-width: 30rem) {
    .segment {
      position: relative;
      padding: 0.4rem 0.625rem;
    }

    .segment-icon {
      display: inline-flex;
    }

    .segment-label {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }

    .sort-icon {
      position: absolute;
      top: 50%;
      left: 0.625rem;
      display: inline-flex;
      color: var(--color-text);
      transform: translateY(-50%);
      pointer-events: none;
    }

    .sort {
      width: 3.75rem;
      padding-left: 0.625rem;
      padding-right: 1.75rem;
      color: transparent;
    }

    /* The open list inherits the select's colour on some platforms. */
    .sort option {
      color: var(--color-text);
    }
  }
</style>
