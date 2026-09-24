<script lang="ts">
  // Customize Home: the one place for every Home setting. Where the app opens
  // and how the lane tiles are packed, then each section: show or hide it, and
  // drag it by its grip to reorder. Edits apply as they're made (Home re-flows
  // behind the dialog), so there's nothing to save or cancel.
  //
  // Drag runs on pointer events, not the HTML5 drag API: that one doesn't fire
  // for touch on most mobile browsers, and this dialog is used on phones. The
  // grip starts the drag, the row snaps between slots as it moves (the
  // others slide aside with a flip), and the order commits on release. With the
  // keyboard, the grip is a button: arrow keys move the section a step.
  //
  // Move/up are heard on the window rather than through pointer capture: the
  // keyed list reorders by moving row nodes, and a node leaving the document
  // (even to be re-inserted) drops its capture mid-gesture.
  import { tick } from 'svelte';
  import { flip } from 'svelte/animate';
  import Modal from '$lib/components/common/Modal.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { moveHomeSection, type HomeSectionOption } from '$lib/utils/homeLayout';
  import { preferences, type CardDensity, type DefaultView } from '$lib/stores/preferences.svelte';

  // "Opens to" is the global default-view preference (consumed by the `/`
  // redirector); it lives here because Home is where the choice is felt.
  const defaultViewOptions: { value: DefaultView; label: string }[] = [
    { value: 'home', label: 'Home' },
    { value: 'feeds', label: 'Feeds' },
    { value: 'saved', label: 'Saved' },
  ];
  const densityOptions: { value: CardDensity; label: string }[] = [
    { value: 'compact', label: 'Compact' },
    { value: 'cozy', label: 'Cozy' },
    { value: 'comfortable', label: 'Comfortable' },
  ];

  interface Props {
    open: boolean;
    onclose: () => void;
    /** Every section Home can show right now, in the current order. */
    sections: HomeSectionOption[];
    hidden: Set<string>;
    /** The full new order of `sections`' ids. */
    onReorder: (order: string[]) => void;
    onToggle: (id: string) => void;
    /** Back to the built-in sections and order (leaves the settings above alone). */
    onReset: () => void;
  }

  let { open, onclose, sections, hidden, onReorder, onToggle, onReset }: Props = $props();

  let listEl = $state<HTMLOListElement | null>(null);

  // The order being previewed mid-drag; null when not dragging.
  let dragOrder = $state<string[] | null>(null);
  let dragId = $state<string | null>(null);
  // Row height, measured at grab. Rows are one line (the label ellipsizes), so
  // a slot is simply pointer offset / row height; reading live rects instead
  // would chase the neighbours' flip animations and jitter.
  let rowHeight = 0;

  // Closing mid-drag (Escape, the backdrop) abandons the drag: otherwise the
  // window listeners outlive the dialog and the release commits an order the
  // reader never finished choosing.
  $effect(() => {
    if (!open) {
      dragId = null;
      dragOrder = null;
    }
  });

  let byId = $derived(new Map(sections.map((s) => [s.id, s])));
  let ordered = $derived(
    dragOrder
      ? dragOrder.map((id) => byId.get(id)).filter((s): s is HomeSectionOption => Boolean(s))
      : sections
  );

  function ids(): string[] {
    return sections.map((s) => s.id);
  }

  function startDrag(e: PointerEvent, id: string) {
    if (e.button !== 0 || !listEl) return;
    e.preventDefault();
    const row = (e.currentTarget as HTMLElement).closest('li');
    rowHeight = row?.getBoundingClientRect().height ?? 0;
    if (!rowHeight) return;
    dragId = id;
    dragOrder = ids();
  }

  function moveDrag(e: PointerEvent) {
    // The page mustn't scroll or select text out from under the drag.
    e.preventDefault();
    if (!dragId || !dragOrder || !listEl) return;
    const top = listEl.getBoundingClientRect().top;
    const slot = Math.max(
      0,
      Math.min(dragOrder.length - 1, Math.floor((e.clientY - top) / rowHeight))
    );
    const from = dragOrder.indexOf(dragId);
    if (slot === from) return;
    const next = dragOrder.filter((id) => id !== dragId);
    next.splice(slot, 0, dragId);
    dragOrder = next;
  }

  function endDrag() {
    if (!dragOrder) return;
    const order = dragOrder;
    const changed = order.some((id, i) => id !== sections[i]?.id);
    dragId = null;
    dragOrder = null;
    if (changed) onReorder(order);
  }

  function handleGripKey(e: KeyboardEvent, id: string) {
    const delta = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (!delta) return;
    e.preventDefault();
    const current = ids();
    const next = moveHomeSection(current, id, delta);
    if (next === current) return;
    onReorder(next);
    // Moving the row's node blurs its grip; hand focus back so the arrows
    // keep working.
    void tick().then(() =>
      listEl?.querySelector<HTMLElement>(`[data-section-id="${CSS.escape(id)}"] .grip`)?.focus()
    );
  }
</script>

<svelte:window
  onpointermove={dragId ? moveDrag : undefined}
  onpointerup={dragId ? endDrag : undefined}
  onpointercancel={dragId ? endDrag : undefined}
/>

<Modal {open} {onclose} title="Customize Home" maxWidth="440px">
  <div class="settings">
    <label class="setting">
      <span class="setting-label">Opens to</span>
      <select
        class="setting-select"
        value={preferences.defaultView}
        onchange={(e) => preferences.setDefaultView(e.currentTarget.value as DefaultView)}
      >
        {#each defaultViewOptions as option}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
    </label>

    <label class="setting">
      <span class="setting-label">Cards</span>
      <select
        class="setting-select"
        value={preferences.cardDensity}
        onchange={(e) => preferences.setCardDensity(e.currentTarget.value as CardDensity)}
      >
        {#each densityOptions as option}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
    </label>
  </div>

  <div class="sections-head">
    <h3 class="sections-title">Sections</h3>
    <button type="button" class="reset-button" onclick={onReset}>Reset</button>
  </div>
  <p class="hint">Choose which show, and drag to reorder.</p>

  <ol class="section-list" class:dragging={dragId !== null} bind:this={listEl}>
    {#each ordered as section (section.id)}
      {@const shown = !hidden.has(section.id)}
      <li
        class="section-row"
        data-section-id={section.id}
        class:hidden={!shown}
        class:lifted={dragId === section.id}
        animate:flip={{ duration: 150 }}
      >
        <button
          type="button"
          class="grip"
          aria-label="Reorder {section.label}"
          aria-describedby="home-customize-grip-hint"
          onpointerdown={(e) => startDrag(e, section.id)}
          onkeydown={(e) => handleGripKey(e, section.id)}
        >
          <Icon name="grip-vertical" size={16} />
        </button>

        <label class="section-toggle">
          <input type="checkbox" checked={shown} onchange={() => onToggle(section.id)} />
          <span class="section-icon"><Icon name={section.icon} size={15} /></span>
          <span class="section-label">{section.label}</span>
          {#if section.kind}<span class="section-kind">{section.kind}</span>{/if}
        </label>
      </li>
    {/each}
  </ol>
  <span id="home-customize-grip-hint" class="sr-only">Use the up and down arrow keys to move.</span>

  {#snippet footer()}
    <button type="button" class="btn btn-primary" onclick={onclose}>Done</button>
  {/snippet}
</Modal>

<style>
  .settings {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding-bottom: 1.25rem;
    margin-bottom: 1.25rem;
    border-bottom: 1px solid var(--color-border);
  }

  .setting {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    font-size: var(--text-sm);
    color: var(--color-text);
    cursor: pointer;
  }

  .setting-select {
    min-width: 9rem;
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .setting-select:focus-visible,
  .reset-button:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  .sections-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
  }

  .sections-title {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--color-text);
  }

  .reset-button {
    padding: 0;
    border: none;
    border-radius: 4px;
    background: none;
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
    cursor: pointer;
  }

  .reset-button:hover {
    color: var(--color-text);
    text-decoration: underline;
  }

  .hint {
    margin: 0.15rem 0 0.75rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .section-list {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--color-border);
    border-radius: 6px;
  }

  /* Hold the grab cursor and suppress text selection for the whole gesture, not
     just while the pointer is over the grip. */
  .section-list.dragging {
    cursor: grabbing;
    user-select: none;
    -webkit-user-select: none;
  }

  .section-row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0.75rem 0.25rem 0.25rem;
    background: var(--color-bg);
  }

  .section-row + .section-row {
    border-top: 1px solid var(--color-border);
  }

  /* The one overlapping element while it's in flight, so it's the one that gets a
     shadow (Flat-By-Default). */
  .section-row.lifted {
    z-index: 1;
    background: var(--color-bg-secondary);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  }

  .grip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    flex-shrink: 0;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--color-text-secondary);
    cursor: grab;
    /* The page mustn't scroll out from under a touch drag. */
    touch-action: none;
  }

  .section-list.dragging .grip {
    cursor: grabbing;
  }

  .grip:hover {
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }

  .grip:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  .section-toggle {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0;
    cursor: pointer;
    font-size: var(--text-sm);
    color: var(--color-text);
  }

  .section-list.dragging .section-toggle {
    cursor: grabbing;
  }

  .section-icon {
    display: inline-flex;
    color: var(--color-text-secondary);
  }

  .section-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .section-kind {
    flex-shrink: 0;
    margin-left: auto;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .section-row.hidden .section-label,
  .section-row.hidden .section-icon {
    color: var(--color-text-secondary);
    opacity: 0.7;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
