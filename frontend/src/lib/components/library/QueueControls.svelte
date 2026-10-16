<script lang="ts">
  // The Queue's own controls, sharing a row with the Library switch: one menu
  // button on the right that carries both the view (Inbox / Archive) and the
  // sort order, so a phone fits the whole row without shrinking anything to
  // icons. The button names what's showing ("Inbox · Newest").
  import { onMount } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { feedViewStore } from '$lib/stores/feedView.svelte';

  const VIEWS = [
    { value: 'inbox', label: 'Inbox' },
    { value: 'archive', label: 'Archive' },
  ] as const;

  const ORDERS = [
    { value: 'newest', label: 'Newest first', short: 'Newest' },
    { value: 'oldest', label: 'Oldest first', short: 'Oldest' },
  ] as const;

  // Anything but 'oldest' shows as newest (see feedViewStore.toggleSortOrder).
  let order = $derived(feedViewStore.currentSortOrder === 'oldest' ? 'oldest' : 'newest');
  // A saved channel brings its own sort (FilterToolbar), so only the view is here.
  let showSort = $derived(!feedViewStore.isSavedChannel);

  let viewLabel = $derived(
    VIEWS.find((v) => v.value === feedViewStore.savedView)?.label ?? 'Inbox'
  );
  let orderOption = $derived(ORDERS.find((o) => o.value === order)!);

  let open = $state(false);
  let wrapper = $state<HTMLDivElement | null>(null);

  function setView(value: (typeof VIEWS)[number]['value']) {
    feedViewStore.setSavedView(value);
    open = false;
  }

  function setOrder(value: (typeof ORDERS)[number]['value']) {
    if (value !== order) {
      feedViewStore.toggleSortOrder();
    }
    open = false;
  }

  onMount(() => {
    const onPointer = (e: PointerEvent) => {
      if (open && wrapper && !wrapper.contains(e.target as Node)) {
        open = false;
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        open = false;
        wrapper?.querySelector<HTMLButtonElement>('.trigger')?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  });
</script>

<div class="queue-controls">
  <div class="menu-wrap" bind:this={wrapper}>
    <button
      class="trigger"
      aria-haspopup="true"
      aria-expanded={open}
      aria-label={showSort
        ? `Showing ${viewLabel}, ${orderOption.label.toLowerCase()}`
        : `Showing ${viewLabel}`}
      onclick={() => (open = !open)}
    >
      <span>{viewLabel}</span>
      {#if showSort}
        <span class="dot" aria-hidden="true">·</span>
        <span class="order">{orderOption.short}</span>
      {/if}
      <Icon name="chevron-down" size={14} />
    </button>

    {#if open}
      <div class="menu">
        <div class="group" role="group" aria-label="Show">
          <div class="group-label" aria-hidden="true">Show</div>
          {#each VIEWS as option (option.value)}
            <button
              class="item"
              aria-pressed={feedViewStore.savedView === option.value}
              onclick={() => setView(option.value)}
            >
              {option.label}
              {#if feedViewStore.savedView === option.value}
                <Icon name="check" size={14} />
              {/if}
            </button>
          {/each}
        </div>
        {#if showSort}
          <div class="group" role="group" aria-label="Sort">
            <div class="group-label" aria-hidden="true">Sort</div>
            {#each ORDERS as option (option.value)}
              <button
                class="item"
                aria-pressed={order === option.value}
                onclick={() => setOrder(option.value)}
              >
                {option.label}
                {#if order === option.value}
                  <Icon name="check" size={14} />
                {/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .queue-controls {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    margin-bottom: 0.5rem;
  }

  .menu-wrap {
    position: relative;
  }

  /* Dressed like the app's selects (app.css) so it reads as the same kind of control. */
  .trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.4rem 0.625rem 0.4rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-sm);
    line-height: 1.3;
    white-space: nowrap;
    cursor: pointer;
    transition: border-color 0.15s ease;
  }

  .trigger:hover {
    border-color: var(--color-text-secondary);
  }

  .trigger:focus-visible {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px var(--color-sidebar-active);
  }

  .trigger :global(svg) {
    color: var(--color-text-secondary);
  }

  .dot,
  .order {
    color: var(--color-text-secondary);
  }

  .menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 100;
    min-width: 11rem;
    padding: 0.25rem 0;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-bg);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  }

  .group + .group {
    margin-top: 0.25rem;
    padding-top: 0.25rem;
    border-top: 1px solid var(--color-border);
  }

  .group-label {
    padding: 0.375rem 0.875rem 0.125rem;
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
  }

  .item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    width: 100%;
    padding: 0.5rem 0.875rem;
    border: none;
    background: transparent;
    color: var(--color-text);
    font-size: var(--text-sm);
    text-align: left;
    cursor: pointer;
  }

  .item:hover {
    background: var(--color-bg-secondary);
  }

  .item[aria-pressed='true'] {
    color: var(--color-primary);
  }

  .item:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
  }

  @media (prefers-color-scheme: dark) {
    .menu {
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .trigger {
      transition: none;
    }
  }
</style>
