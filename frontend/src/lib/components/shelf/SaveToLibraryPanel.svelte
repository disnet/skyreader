<script lang="ts">
  // The reader's one save control, opened from its Save button: the article is
  // in your Library, and from here you keep it on the Shelf and file it into
  // collections, without leaving the page. A collection member is on the Shelf
  // by definition, so the Shelf box follows the collections: ticking one ticks
  // it, and unticking the Shelf takes the save out of its collections too.
  //
  // Non-modal: the page stays live behind it, and a click or scroll outside, or
  // Escape, puts it away. Each box applies at once, like the Library's picker.
  // Desktop hangs it under the button; on a phone it sits above the bottom bar,
  // the width of the screen.
  import { onMount, tick } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { shelfStore } from '$lib/stores/shelf.svelte';
  import type { SavedItem, ShelfCollection } from '$lib/types';

  interface Props {
    /** The save, or undefined for the moment between Save and its row landing. */
    save: SavedItem | undefined;
    anchorEl: HTMLElement | null | undefined;
    /** Above the anchor, full width (the phone's bottom bar), or below it. */
    placement?: 'below' | 'above';
    /** Take it out of the Library. Absent where the host has no unsave. */
    onUnsave?: () => void;
    onClose: () => void;
  }

  let { save, anchorEl, placement = 'below', onUnsave, onClose }: Props = $props();

  // Past this many collections, a filter box earns its row.
  const FILTER_AT = 8;

  let panelEl = $state<HTMLDivElement | null>(null);
  let filter = $state('');
  let newName = $state('');
  let busy = $state(false);

  let onShelf = $derived(save ? shelfStore.isOnShelf(save) : false);
  let memberOf = $derived(save ? shelfStore.collectionIdsFor(save) : []);
  let collections = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return shelfStore.collections;
    return shelfStore.collections.filter((c) => c.name.toLowerCase().includes(q));
  });
  let canFile = $derived(Boolean(save) && shelfStore.canWrite && !busy);

  function holds(collection: ShelfCollection): boolean {
    return memberOf.includes(collection.id);
  }

  async function toggleShelf(input: HTMLInputElement) {
    if (!save || busy) return;
    busy = true;
    try {
      await shelfStore.setOnShelf(save, !onShelf);
    } finally {
      busy = false;
      input.checked = save ? shelfStore.isOnShelf(save) : false;
    }
  }

  async function toggle(collection: ShelfCollection, input: HTMLInputElement) {
    if (!save || busy) return;
    busy = true;
    try {
      if (holds(collection)) await shelfStore.removeItem(collection.id, save.rkey);
      else await shelfStore.addItems(collection.id, [save]);
    } finally {
      busy = false;
      // A refused change leaves the store as it was, so nothing re-renders the
      // box the browser already flipped: put it back to what's true.
      input.checked = holds(collection);
    }
  }

  async function createAndAdd(e: SubmitEvent) {
    e.preventDefault();
    // Not while collections load: the fresh list would replace the new one.
    if (!save || busy || shelfStore.loading || !newName.trim()) return;
    busy = true;
    try {
      const id = await shelfStore.create(newName);
      if (id) {
        newName = '';
        filter = '';
        await shelfStore.addItems(id, [save]);
      }
    } finally {
      busy = false;
    }
  }

  function close(refocus = false) {
    onClose();
    if (refocus) anchorEl?.focus();
  }

  function position() {
    if (!anchorEl || !panelEl) return;
    const rect = anchorEl.getBoundingClientRect();
    const gap = 8;
    // Never taller than the room it has: a short window scrolls the panel
    // rather than pushing its top (the Shelf box) off screen.
    if (placement === 'above') {
      panelEl.style.bottom = `${window.innerHeight - rect.top + gap}px`;
      panelEl.style.maxHeight = `${rect.top - 2 * gap}px`;
      return;
    }
    const width = panelEl.offsetWidth;
    // Right edge under the button's, kept on screen.
    const left = Math.min(Math.max(gap, rect.right - width), window.innerWidth - width - gap);
    panelEl.style.top = `${rect.bottom + gap}px`;
    panelEl.style.left = `${Math.max(gap, left)}px`;
    panelEl.style.maxHeight = `${window.innerHeight - rect.bottom - 2 * gap}px`;
  }

  function inside(target: EventTarget | null): boolean {
    const node = target as Node | null;
    return Boolean(node && (panelEl?.contains(node) || anchorEl?.contains(node)));
  }

  function onPointerDown(e: PointerEvent) {
    if (!inside(e.target)) close();
  }

  // Scrolling the page yourself means you've moved on. Listen for the gesture,
  // not `scroll`: the page also scrolls on its own (the body reflowing as the
  // save's text lands, a phone lifting a focused input above its keyboard),
  // and the panel's own list scrolls.
  function onScrollGesture(e: Event) {
    if (!inside(e.target)) close();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close(true);
  }

  onMount(() => {
    void shelfStore.load();
    position();
    // Into the panel, so the keyboard starts where the choices are.
    void tick().then(() => panelEl?.focus({ preventScroll: true }));
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('wheel', onScrollGesture, { capture: true, passive: true });
    document.addEventListener('touchmove', onScrollGesture, { capture: true, passive: true });
    document.addEventListener('keydown', onKeydown, true);
    window.addEventListener('resize', position);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('wheel', onScrollGesture, true);
      document.removeEventListener('touchmove', onScrollGesture, true);
      document.removeEventListener('keydown', onKeydown, true);
      window.removeEventListener('resize', position);
    };
  });
</script>

<div
  class="save-panel"
  class:above={placement === 'above'}
  role="dialog"
  aria-label="Save to Library"
  tabindex="-1"
  bind:this={panelEl}
>
  <div class="head">
    <span class="status">
      {#if save}
        <Icon name="check" size={16} />
        Saved to your Library
      {:else}
        Saving…
      {/if}
    </span>
    {#if onUnsave && save}
      <button class="unsave" onclick={onUnsave}>Remove</button>
    {/if}
  </div>

  <label class="row shelf-row" title="Taking it off the Shelf takes it out of its collections too">
    <input
      type="checkbox"
      checked={onShelf}
      disabled={!save || busy}
      onchange={(e) => toggleShelf(e.currentTarget)}
    />
    <Icon name="shelf" size={16} />
    <span class="name">Shelf</span>
    {#if memberOf.length > 0}
      <span class="hint">
        In {memberOf.length}
        {memberOf.length === 1 ? 'collection' : 'collections'}
      </span>
    {/if}
  </label>

  {#if auth.user}
    <div class="section">
      <div class="section-label">Collections</div>
      {#if shelfStore.collections.length > FILTER_AT}
        <input
          class="text-input filter"
          type="search"
          placeholder="Find a collection"
          aria-label="Find a collection"
          bind:value={filter}
        />
      {/if}
      {#if collections.length > 0}
        <ul class="list">
          {#each collections as collection (collection.id)}
            {@const held = holds(collection)}
            {@const full = !held && shelfStore.roomIn(collection.id) === 0}
            <li>
              <label class="row" class:full>
                <input
                  type="checkbox"
                  checked={held}
                  disabled={!canFile || full}
                  onchange={(e) => toggle(collection, e.currentTarget)}
                />
                <span class="name">{collection.name}</span>
                {#if full}<span class="hint">Full</span>{/if}
                <span class="count">{collection.items.length.toLocaleString()}</span>
              </label>
            </li>
          {/each}
        </ul>
      {:else if filter.trim()}
        <p class="note">No collection matches.</p>
      {:else if !shelfStore.loading}
        <p class="note">Group what you keep, like a course's readings.</p>
      {/if}

      <form class="new" onsubmit={createAndAdd}>
        <Icon name="folder-plus" size={16} />
        <input
          class="text-input"
          type="text"
          placeholder="New collection"
          aria-label="New collection"
          maxlength="100"
          bind:value={newName}
          disabled={!canFile || shelfStore.loading}
        />
        <button
          type="submit"
          class="new-btn"
          disabled={!canFile || shelfStore.loading || !newName.trim()}>Add</button
        >
      </form>

      {#if !shelfStore.canWrite}
        <p class="note">Collections need an account and a connection.</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .save-panel {
    position: fixed;
    z-index: 200;
    width: 300px;
    max-width: calc(100vw - 16px);
    padding: 0.375rem;
    background: var(--color-bg);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 10px;
    /* Floating over the page: the one place a shadow belongs. */
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
    font-size: var(--text-md);
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .save-panel:focus {
    outline: none;
  }

  /* The phone: over the bottom bar, the screen's width less a gutter. */
  .save-panel.above {
    left: 12px;
    right: 12px;
    width: auto;
    max-width: none;
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.375rem 0.5rem 0.5rem;
    border-bottom: 1px solid var(--color-border);
    margin-bottom: 0.25rem;
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .status :global(svg) {
    color: var(--color-primary);
  }

  .unsave {
    border: none;
    background: none;
    padding: 0.25rem 0.375rem;
    border-radius: 6px;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .unsave:hover {
    color: var(--color-text);
    background: var(--color-bg-secondary);
  }

  .row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.5rem;
    border-radius: 6px;
    cursor: pointer;
  }

  .row:hover {
    background: var(--color-bg-secondary);
  }

  .row.full {
    cursor: default;
  }

  .row input {
    accent-color: var(--color-primary);
    margin: 0;
    flex-shrink: 0;
  }

  .shelf-row :global(svg) {
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }

  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hint,
  .count {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    white-space: nowrap;
  }

  .section {
    border-top: 1px solid var(--color-border);
    margin-top: 0.25rem;
    padding-top: 0.25rem;
  }

  .section-label {
    padding: 0.5rem 0.5rem 0.25rem;
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    color: var(--color-text-secondary);
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: min(40vh, 280px);
    overflow-y: auto;
  }

  .note {
    margin: 0;
    padding: 0.375rem 0.5rem 0.5rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .text-input {
    flex: 1;
    min-width: 0;
    padding: 0.375rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font-size: var(--text-md);
    background: var(--color-bg);
    color: var(--color-text);
  }

  .text-input:focus {
    outline: none;
    border-color: var(--color-primary);
  }

  .filter {
    display: block;
    width: calc(100% - 1rem);
    margin: 0 0.5rem 0.25rem;
  }

  .new {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.5rem 0.25rem;
    color: var(--color-text-secondary);
  }

  .new-btn {
    padding: 0.375rem 0.75rem;
    border: none;
    border-radius: 6px;
    background: var(--color-primary);
    color: #fff;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    cursor: pointer;
  }

  .new-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* Touch: rows tall enough to hit, and inputs big enough that iOS Safari
     doesn't zoom the page on focus. */
  @media (hover: none) and (pointer: coarse) {
    .row {
      min-height: 44px;
    }

    .text-input {
      font-size: 1rem;
    }
  }
</style>
