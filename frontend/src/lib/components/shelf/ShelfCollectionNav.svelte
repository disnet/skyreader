<script lang="ts">
  // The Shelf's collections, on one line: Everything, the pinned ones, then the
  // most recently opened, and "All N" for the rest — a searchable list (a
  // popover on desktop, a bottom sheet on a phone) where a collection is pinned,
  // made, or imported. Recency is per device (localStorage); pins are the
  // account's (shelfStore.setPinned). With no collections yet the row offers
  // New and Import directly, as there's nothing to list.
  import { tick } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import BottomSheet from '$lib/components/common/BottomSheet.svelte';
  import { shelfStore } from '$lib/stores/shelf.svelte';
  import { mobileStore } from '$lib/stores/mediaQuery.svelte';
  import { collectionRow, pushRecent } from '$lib/utils/shelf';
  import type { ShelfCollection } from '$lib/types';

  interface Props {
    collectionId: string | null;
    onSelect: (id: string | null) => void;
    onImport: () => void;
  }

  let { collectionId, onSelect, onImport }: Props = $props();

  const RECENT_KEY = 'skyreader-shelf-recent-collections';

  function readRecent(): string[] {
    try {
      const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
      return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
    } catch {
      return [];
    }
  }

  let recent = $state<string[]>(readRecent());

  // Whatever opened it — a chip, the menu, the sidebar, a link — counts.
  $effect(() => {
    const id = collectionId;
    if (!id) return;
    const next = pushRecent(readRecent(), id);
    recent = next;
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      // Private mode: the row still fills from pins and order.
    }
  });

  let collections = $derived(shelfStore.collections);
  let row = $derived(collectionRow(collections, recent, collectionId));
  let pinned = $derived(collections.filter((c) => c.pinned));
  let unpinned = $derived(collections.filter((c) => !c.pinned));

  const providerLabel = (p: 'semble' | 'margin') => (p === 'semble' ? 'Semble' : 'Margin');

  /** The line under a linked collection's name, when there's news. */
  function linkStatus(c: ShelfCollection): string | null {
    if (!c.link) return null;
    if (shelfStore.isSyncing(c.id)) return 'Syncing…';
    const pending = shelfStore.pendingIn(c.id);
    if (pending > 0) return `${pending} not on ${providerLabel(c.link.provider)} yet`;
    return null;
  }

  // --- The row ---
  let scroller = $state<HTMLDivElement | null>(null);
  let fadeEnd = $state(false);

  function measure() {
    if (!scroller) return;
    fadeEnd = scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1;
  }

  $effect(() => {
    if (!scroller) return;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  });

  // The open collection's chip in view when it changes, or first renders (a
  // cold load opens on `?collection=` before the collections arrive). Sideways
  // only, by hand: scrollIntoView would also scroll the page back up to the row.
  let activeOnRow = $derived(row.some((c) => c.id === collectionId));
  $effect(() => {
    void collectionId;
    void activeOnRow;
    void tick().then(() => {
      const chip = scroller?.querySelector<HTMLElement>('.chip.active');
      if (scroller && chip) {
        const left = chip.offsetLeft - scroller.offsetLeft;
        if (left < scroller.scrollLeft) scroller.scrollLeft = left;
        else if (left + chip.offsetWidth > scroller.scrollLeft + scroller.clientWidth) {
          scroller.scrollLeft = left + chip.offsetWidth - scroller.clientWidth;
        }
      }
      measure();
    });
  });

  // A mouse wheel has no sideways: let it scroll the row while the row can still
  // move that way, and hand it back to the page at either end.
  function onWheel(e: WheelEvent) {
    if (!scroller || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    const max = scroller.scrollWidth - scroller.clientWidth;
    const canMove = e.deltaY < 0 ? scroller.scrollLeft > 0 : scroller.scrollLeft < max - 1;
    if (max <= 0 || !canMove) return;
    e.preventDefault();
    scroller.scrollLeft += e.deltaY;
  }

  // --- The list ---
  let open = $state(false);
  let query = $state('');
  let creating = $state(false);
  let newName = $state('');
  let wrap = $state<HTMLDivElement | null>(null);
  let allButton = $state<HTMLButtonElement | null>(null);
  let searchInput = $state<HTMLInputElement | null>(null);

  let matches = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return q ? collections.filter((c) => c.name.toLowerCase().includes(q)) : [];
  });

  function openList() {
    // A form left half-typed on the empty row doesn't follow into the list.
    creating = false;
    newName = '';
    open = true;
    // A phone's keyboard would cover half the sheet; search is a tap away there.
    if (!mobileStore.isMobile) void tick().then(() => searchInput?.focus());
  }

  function close() {
    open = false;
    query = '';
    creating = false;
    newName = '';
  }

  function choose(id: string | null) {
    close();
    onSelect(id);
  }

  // Pinning moves the row between the list's groups, which re-renders it: keep
  // focus on its pin so a keyboard reader isn't dropped back at the page top.
  async function togglePin(c: ShelfCollection, button: HTMLButtonElement) {
    const hadFocus = document.activeElement === button;
    const done = shelfStore.setPinned(c.id, !c.pinned);
    await tick();
    if (hadFocus) {
      document
        .querySelector<HTMLButtonElement>(`.pin[data-collection-id="${CSS.escape(c.id)}"]`)
        ?.focus();
    }
    await done;
  }

  async function submitNew(e: SubmitEvent) {
    e.preventDefault();
    const id = await shelfStore.create(newName);
    if (id) choose(id);
  }

  // The popover closes on a click outside it or Escape; the sheet handles its own.
  $effect(() => {
    if (!open || mobileStore.isMobile) return;
    const onPointer = (e: PointerEvent) => {
      if (wrap && !wrap.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      close();
      allButton?.focus();
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  });
</script>

{#snippet collectionRowItem(c: ShelfCollection)}
  {@const status = linkStatus(c)}
  {@const active = collectionId === c.id}
  <li class="item" class:active>
    <button
      class="item-main"
      aria-current={active ? 'page' : undefined}
      onclick={() => choose(c.id)}
    >
      <span class="item-icon"><Icon name={active ? 'check' : 'folder'} size={15} /></span>
      <span class="item-text">
        <span class="item-name">{c.name}</span>
        {#if status}<span class="item-status">{status}</span>{/if}
      </span>
      {#if c.link}
        <span class="badge" title="Linked to {providerLabel(c.link.provider)}">
          <Icon name="link" size={10} strokeWidth={2.25} />
          {providerLabel(c.link.provider)}
        </span>
      {/if}
      <span class="item-count">{c.items.length}</span>
    </button>
    <button
      class="pin"
      class:pinned={c.pinned}
      data-collection-id={c.id}
      aria-pressed={Boolean(c.pinned)}
      aria-label="Pin {c.name}"
      title={c.pinned ? 'Unpin from the row' : 'Pin to the row'}
      disabled={!shelfStore.canWrite}
      onclick={(e) => void togglePin(c, e.currentTarget)}
    >
      <Icon name="pin" size={14} />
    </button>
  </li>
{/snippet}

{#snippet search()}
  <div class="search">
    <Icon name="search" size={14} />
    <input
      bind:this={searchInput}
      type="search"
      placeholder="Find a collection"
      aria-label="Find a collection"
      bind:value={query}
    />
  </div>
{/snippet}

{#snippet list()}
  <div class="list">
    {#if query.trim()}
      {#if matches.length > 0}
        <ul>
          {#each matches as c (c.id)}{@render collectionRowItem(c)}{/each}
        </ul>
      {:else}
        <p class="none">No collection called that.</p>
      {/if}
    {:else}
      <ul>
        <li class="item" class:active={!collectionId}>
          <button
            class="item-main"
            aria-current={!collectionId ? 'page' : undefined}
            onclick={() => choose(null)}
          >
            <span class="item-icon"
              ><Icon name={collectionId ? 'layers' : 'check'} size={15} /></span
            >
            <span class="item-text"><span class="item-name">Everything</span></span>
            <span class="item-count">{shelfStore.items.length}</span>
          </button>
        </li>
      </ul>
      {#if pinned.length > 0}
        <h3 class="group">Pinned</h3>
        <ul>
          {#each pinned as c (c.id)}{@render collectionRowItem(c)}{/each}
        </ul>
      {/if}
      {#if unpinned.length > 0}
        <h3 class="group">{pinned.length > 0 ? 'Other collections' : 'Collections'}</h3>
        <ul>
          {#each unpinned as c (c.id)}{@render collectionRowItem(c)}{/each}
        </ul>
      {/if}
    {/if}
  </div>
{/snippet}

{#snippet newForm(chip: boolean)}
  <form class="new-form" onsubmit={submitNew}>
    <!-- svelte-ignore a11y_autofocus -->
    <input
      class="new-input"
      class:chip-input={chip}
      type="text"
      placeholder="Collection name"
      maxlength="100"
      bind:value={newName}
      autofocus
      onkeydown={(e) => {
        if (e.key === 'Escape') {
          // Only the form closes, not the list around it.
          e.stopPropagation();
          creating = false;
          newName = '';
        }
      }}
    />
    <button type="submit" class="new-submit" disabled={!newName.trim()}>Create</button>
  </form>
{/snippet}

{#snippet actions()}
  <div class="actions">
    {#if creating}
      {@render newForm(false)}
    {:else}
      <button class="action" onclick={() => (creating = true)} disabled={!shelfStore.canWrite}>
        <Icon name="plus" size={15} />
        New collection
      </button>
    {/if}
    <button
      class="action"
      onclick={() => {
        close();
        onImport();
      }}
      disabled={!shelfStore.canWrite}
    >
      <Icon name="link" size={15} />
      Import from Semble or Margin
    </button>
  </div>
{/snippet}

<nav class="collections" aria-label="Collections">
  <div
    class="row"
    class:fade-end={fadeEnd}
    bind:this={scroller}
    onscroll={measure}
    onwheel={onWheel}
  >
    <button class="chip" class:active={!collectionId} onclick={() => onSelect(null)}>
      Everything
      <span class="chip-count">{shelfStore.items.length}</span>
    </button>
    {#each row as c (c.id)}
      <button class="chip" class:active={collectionId === c.id} onclick={() => onSelect(c.id)}>
        {c.name}
        {#if c.link}
          <span class="chip-link" title="Linked to {providerLabel(c.link.provider)}">
            <Icon name="link" size={12} strokeWidth={2} />
          </span>
        {/if}
        <span class="chip-count">{c.items.length}</span>
      </button>
    {/each}
    {#if collections.length === 0}
      {#if creating}
        {@render newForm(true)}
      {:else}
        <button
          class="chip chip-new"
          onclick={() => (creating = true)}
          disabled={!shelfStore.canWrite}
        >
          <Icon name="plus" size={12} strokeWidth={2} />
          New collection
        </button>
        <button class="chip chip-new" onclick={onImport} disabled={!shelfStore.canWrite}>
          <Icon name="link" size={12} strokeWidth={2} />
          Import from Semble or Margin
        </button>
      {/if}
    {/if}
  </div>

  {#if collections.length > 0}
    <div class="all-wrap" bind:this={wrap}>
      <button
        class="chip all"
        class:open
        bind:this={allButton}
        aria-expanded={open}
        aria-haspopup="dialog"
        onclick={() => (open ? close() : openList())}
      >
        All {collections.length}
        <Icon name="chevron-down" size={14} />
      </button>
      {#if open && !mobileStore.isMobile}
        <div class="popover" role="dialog" aria-label="Collections">
          {@render search()}
          {@render list()}
          {@render actions()}
        </div>
      {/if}
    </div>
  {/if}
</nav>

{#if mobileStore.isMobile}
  <!-- Search sits in the footer, which rides above the on-screen keyboard. -->
  <BottomSheet {open} onclose={close} title="Collections">
    {@render list()}
    {#snippet footer()}
      {@render search()}
      {@render actions()}
    {/snippet}
  </BottomSheet>
{/if}

<style>
  .collections {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin-bottom: 1rem;
  }

  /* One line that scrolls sideways; a fade says there's more past the edge. */
  .row {
    display: flex;
    gap: 0.375rem;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
    overscroll-behavior-x: contain;
  }

  .row::-webkit-scrollbar {
    display: none;
  }

  .row.fade-end {
    mask-image: linear-gradient(90deg, #000 calc(100% - 2.5rem), transparent);
  }

  .chip {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.375rem;
    min-height: 32px;
    padding: 0.25rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: none;
    color: var(--color-text);
    font-size: var(--text-sm);
    white-space: nowrap;
    cursor: pointer;
  }

  .chip:hover:not(:disabled) {
    border-color: var(--color-text-secondary);
  }

  .chip.active {
    border-color: var(--color-primary);
    background: var(--color-sidebar-active);
    color: var(--color-primary);
  }

  .chip:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .chip-count {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .chip-link {
    display: inline-flex;
    color: var(--color-text-secondary);
  }

  .chip.active .chip-count,
  .chip.active .chip-link {
    color: var(--color-primary);
  }

  .chip-new {
    color: var(--color-text-secondary);
    border-style: dashed;
  }

  .chip.all {
    padding-right: 0.5rem;
    color: var(--color-text-secondary);
  }

  .chip.all.open {
    border-color: var(--color-text-secondary);
    color: var(--color-text);
  }

  .all-wrap {
    position: relative;
    flex-shrink: 0;
  }

  /* --- The list (popover and sheet) --- */
  .popover {
    position: absolute;
    top: calc(100% + 0.375rem);
    right: 0;
    z-index: 30;
    display: flex;
    flex-direction: column;
    width: 22rem;
    max-width: calc(100vw - 2rem);
    max-height: min(32rem, 70vh);
    border: 1px solid var(--color-border);
    border-radius: 10px;
    background: var(--color-bg);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    overflow: hidden;
  }

  .popover .list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .search {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0.625rem;
    padding: 0 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    color: var(--color-text-secondary);
  }

  .search:focus-within {
    border-color: var(--color-primary);
  }

  .search input {
    flex: 1;
    min-width: 0;
    padding: 0.45rem 0;
    border: none;
    background: none;
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-sm);
    outline: none;
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .group {
    margin: 0;
    padding: 0.625rem 0.875rem 0.25rem;
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
    color: var(--color-text-secondary);
  }

  .item {
    display: flex;
    align-items: center;
  }

  .item-main {
    display: flex;
    flex: 1;
    min-width: 0;
    align-items: center;
    gap: 0.625rem;
    padding: 0.4375rem 0.25rem 0.4375rem 0.875rem;
    border: none;
    background: none;
    color: var(--color-text);
    font-size: var(--text-sm);
    text-align: left;
    cursor: pointer;
  }

  .item:hover {
    background: var(--color-bg-secondary);
  }

  .item.active {
    background: var(--color-sidebar-active);
  }

  .item.active .item-main,
  .item.active .item-icon,
  .item.active .item-count {
    color: var(--color-primary);
  }

  .item-icon {
    display: inline-flex;
    color: var(--color-text-secondary);
  }

  .item-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .item-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .item-status {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .badge {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.1875rem;
    padding: 0.0625rem 0.375rem;
    border-radius: 4px;
    background: var(--color-bg-secondary);
    color: var(--color-text-secondary);
    font-size: var(--text-2xs);
    font-weight: var(--weight-medium);
  }

  .item-count {
    margin-left: auto;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  /* The pin shows on a hovered or focused row; a pinned one always shows it. */
  .pin {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    margin-right: 0.375rem;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--color-text-secondary);
    cursor: pointer;
    opacity: 0;
  }

  .item:hover .pin,
  .item:focus-within .pin,
  .pin.pinned {
    opacity: 1;
  }

  .pin.pinned {
    color: var(--color-primary);
  }

  .pin:hover:not(:disabled) {
    background: var(--color-bg);
    color: var(--color-text);
  }

  .pin.pinned:hover:not(:disabled) {
    color: var(--color-primary);
  }

  .pin:disabled {
    cursor: default;
  }

  .none {
    margin: 0;
    padding: 0.75rem 0.875rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .actions {
    display: flex;
    flex-direction: column;
    padding: 0.25rem 0;
    border-top: 1px solid var(--color-border);
  }

  .action {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.5rem 0.875rem;
    border: none;
    background: none;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    text-align: left;
    cursor: pointer;
  }

  .action:hover:not(:disabled) {
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }

  .action:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .new-form {
    display: flex;
    flex-shrink: 0;
    gap: 0.375rem;
  }

  .actions .new-form {
    padding: 0.375rem 0.625rem;
  }

  .new-input {
    flex: 1;
    min-width: 0;
    min-height: 32px;
    padding: 0.25rem 0.625rem;
    border: 1px solid var(--color-primary);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-sm);
    outline: none;
  }

  .new-input.chip-input {
    flex: none;
    width: 12rem;
    max-width: 60vw;
    border-radius: 999px;
    padding: 0.25rem 0.75rem;
  }

  .new-submit {
    min-height: 32px;
    padding: 0.25rem 0.75rem;
    border: none;
    border-radius: 999px;
    background: var(--color-primary);
    color: #fff;
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .new-submit:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* On touch there's no hover: the pin is always there, quieter until pinned. */
  @media (hover: none) {
    .pin {
      opacity: 0.55;
    }

    .item-main {
      padding-top: 0.625rem;
      padding-bottom: 0.625rem;
      font-size: var(--text-md);
    }

    .action {
      padding: 0.75rem 1rem;
      font-size: var(--text-md);
    }
  }

  /* iOS Safari zooms the viewport when a focused input is smaller than 16px. */
  @media (hover: none) and (pointer: coarse) {
    .search input,
    .new-input {
      font-size: 1rem;
    }
  }
</style>
