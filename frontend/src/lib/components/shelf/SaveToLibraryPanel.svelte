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
  import { pinnedFirst } from '$lib/utils/shelf';

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
  // Less room than this under the button and more above: open upward.
  const FLIP_BELOW = 320;
  // However cramped, tall enough for the status line and a row.
  const MIN_HEIGHT = 96;

  let panelEl = $state<HTMLDivElement | null>(null);
  let filter = $state('');
  let newName = $state('');
  let busy = $state(false);
  // Opened upward from its button (decided on first placement).
  let flipped: boolean | undefined;

  let onShelf = $derived(save ? shelfStore.isOnShelf(save) : false);
  let memberOf = $derived(save ? shelfStore.collectionIdsFor(save) : []);
  // Pinned first, as on the Shelf's row.
  let collections = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    const matching = q
      ? shelfStore.collections.filter((c) => c.name.toLowerCase().includes(q))
      : shelfStore.collections;
    return pinnedFirst(matching);
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
    place();
    revealFocused();
  }

  // A panel too short for even its fixed rows (a landscape phone with the
  // keyboard up) still scrolls as a whole, and iOS Safari won't bring a focused
  // field into view inside it: do that here, so the field being typed in stays
  // in sight.
  function revealFocused() {
    const field = document.activeElement;
    if (!panelEl || !(field instanceof HTMLInputElement) || field.type === 'checkbox') return;
    if (!panelEl.contains(field)) return;
    const box = panelEl.getBoundingClientRect();
    const at = field.getBoundingClientRect();
    if (at.bottom > box.bottom) panelEl.scrollTop += at.bottom - box.bottom;
    else if (at.top < box.top) panelEl.scrollTop -= box.top - at.top;
  }

  function place() {
    if (!anchorEl || !panelEl) return;
    const rect = anchorEl.getBoundingClientRect();
    // Its button scrolled out of view (a feed card's): nothing left to hang from.
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      close();
      return;
    }
    const gap = 8;
    // The room it has is what's visible. With a phone's keyboard up, iOS Safari
    // leaves the layout viewport (and anything fixed to it) where it was, and
    // the visual viewport is the strip above the keys.
    const viewport = window.visualViewport;
    const visibleTop = viewport ? viewport.offsetTop : 0;
    const visibleBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
    // Never taller than that room: a short panel shrinks its collection list
    // (see the stylesheet), keeping the Shelf box and the text fields in sight.
    const fit = (room: number) => `${Math.max(MIN_HEIGHT, room)}px`;
    if (placement === 'above') {
      // Seated on the bottom bar's top edge, so the panel reads as the bar
      // opening upward rather than a card floating over the text; on the
      // keyboard instead when the bar is behind it.
      const barTop = (anchorEl.closest('.reader-bottom-bar') ?? anchorEl).getBoundingClientRect()
        .top;
      const seat = Math.min(barTop, visibleBottom);
      panelEl.style.bottom = `${window.innerHeight - seat}px`;
      panelEl.style.maxHeight = fit(seat - visibleTop - 2 * gap);
      return;
    }
    const width = panelEl.offsetWidth;
    // Hung toward the middle of the screen, kept on it: right edge under the
    // button's for a button on the right (the reader's bar), left edge under
    // it for one on the left (a feed card's action bar).
    const onRight = rect.left + rect.width / 2 > window.innerWidth / 2;
    const left = Math.min(
      Math.max(gap, onRight ? rect.right - width : rect.left),
      window.innerWidth - width - gap
    );
    panelEl.style.left = `${Math.max(gap, left)}px`;
    const below = visibleBottom - rect.bottom - 2 * gap;
    const above = rect.top - visibleTop - 2 * gap;
    // A button low on the screen (a feed card's action bar) opens it upward,
    // growing up from the button as collections load, when below is cramped.
    // Decided once, so following a scroll doesn't flip it from side to side.
    flipped ??= below < FLIP_BELOW && above > below;
    if (flipped) {
      // On the keyboard, if it has risen over the button.
      const seat = Math.min(rect.top - gap, visibleBottom);
      panelEl.style.top = '';
      panelEl.style.bottom = `${window.innerHeight - seat}px`;
      panelEl.style.maxHeight = fit(seat - visibleTop - gap);
      return;
    }
    panelEl.style.bottom = '';
    panelEl.style.top = `${rect.bottom + gap}px`;
    panelEl.style.maxHeight = fit(below);
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

  // Tabbing away to something else puts it away, as a click elsewhere does.
  // (Focus dropping to nothing, e.g. a box disabling while it saves, doesn't.)
  function onFocusOut(e: FocusEvent) {
    if (e.relatedTarget && !inside(e.relatedTarget)) close();
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
    // The keyboard rising resizes the visual viewport, not the window, on iOS,
    window.visualViewport?.addEventListener('resize', position);
    // iOS also pans it to bring a focused field into view.
    window.visualViewport?.addEventListener('scroll', position);
    // A non-gesture scroll (keys, the page reflowing) moves an in-page anchor
    // like a feed card's button: follow it.
    document.addEventListener('scroll', position, { capture: true, passive: true });
    return () => {
      document.removeEventListener('scroll', position, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('wheel', onScrollGesture, true);
      document.removeEventListener('touchmove', onScrollGesture, true);
      document.removeEventListener('keydown', onKeydown, true);
      window.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
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
  onfocusout={onFocusOut}
>
  <div class="head">
    <span class="status">
      {#if save}
        <Icon name="check" size={16} />
        Saved to your Queue
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
                {#if collection.pinned}
                  <span class="pin" title="Pinned on the Shelf"
                    ><Icon name="pin" size={12} /><span class="sr-only">, pinned</span></span
                  >
                {/if}
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
    /* A column whose collection list is the one part that gives way: when the
       panel is short of room (a phone's keyboard up, a short window), the list
       scrolls inside a smaller box and the fields around it stay in sight. As
       one scrolling box, a squeezed panel clipped its bottom, and iOS Safari
       doesn't scroll a focused field into view inside a fixed panel, so the
       New collection box went out of sight as the keyboard rose. */
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  /* Only the list gives way; everything else keeps its height. */
  .save-panel > :not(.section) {
    flex-shrink: 0;
  }

  .save-panel:focus {
    outline: none;
  }

  /* The phone: an extension of the bottom bar. Edge to edge in the bar's own
     colour, square where it meets the bar's rail, with only a hairline and a
     soft lift above it to set it off from the text. */
  .save-panel.above {
    left: 0;
    right: 0;
    width: auto;
    max-width: none;
    background: var(--reader-chrome-bg, var(--color-bg));
    border: none;
    border-top: 1px solid var(--color-border);
    border-radius: 14px 14px 0 0;
    box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.08);
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

  /* Lit, as a pinned collection's pin is on the Shelf. */
  .pin {
    display: flex;
    color: var(--color-primary);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  .hint,
  .count {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    white-space: nowrap;
  }

  .section {
    display: flex;
    flex-direction: column;
    flex-shrink: 1;
    min-height: 0;
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
    flex: 0 1 auto;
    /* At least a row, so a very short panel still shows what it's for. */
    min-height: 2.25rem;
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
    /* Its natural height: `flex: 1` from .text-input would run vertically in
       the section's column. */
    flex: none;
    display: block;
    width: calc(100% - 1rem);
    margin: 0 0.5rem 0.25rem;
  }

  .section > :not(.list) {
    flex-shrink: 0;
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
