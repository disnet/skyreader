<script lang="ts">
  // The one search-and-pick field on the rooms surfaces. Both of them are the
  // same interaction — type into a field, get a floating list of rows, choose
  // one — and they used to be two hand-styled copies that drifted apart: the
  // room opener floated its results over the page while the article adder pushed
  // the room down with an inline list. This owns the chrome (field, panel,
  // rows, hints, keyboard and focus handling) so there is one answer to what
  // that interaction looks like; the parents own what the rows mean.
  //
  // Rows arrive as finished view-models rather than as each parent's own shape,
  // because the rows are the part that must look identical — an icon, a title, a
  // quiet second line, and an optional trailing note ("Joined", "Already here").
  import Icon, { type IconName } from '$lib/components/Icon.svelte';

  /** One offered row. `key` is both the list key and what `onChoose` is given. */
  export interface ComboRow {
    key: string;
    icon: IconName;
    title: string;
    meta?: string | null;
    /** Trailing marker: why this row is here but not actionable. */
    note?: string | null;
    /** Highlightable but not choosable — a duplicate, say. */
    disabled?: boolean;
  }

  interface Props {
    value: string;
    placeholder: string;
    /** The mark inside the field: what this particular field is for. */
    icon: IconName;
    rows: ComboRow[];
    /** Quiet line under the rows, inside the panel. Null hides it — and a panel
     *  with neither rows nor a hint doesn't open at all. */
    hint?: string | null;
    busy?: boolean;
    /** Distinguishes this field's aria ids from the other one's on the page. */
    idPrefix: string;
    /** A trailing submit button, for a field whose action isn't obvious from
     *  its rows. Without one, the busy state shows inside the field instead. */
    action?: { label: string; busyLabel: string } | null;
    /** Shown in the field while busy when there is no action button. */
    busyLabel?: string | null;
    /** Message under the field. The panel is put away before one is set, so it
     *  has the line to itself. */
    error?: string | null;
    onChoose: (key: string) => void;
    /** First focus — the moment to start loading whatever fills the list. */
    onFirstOpen?: () => void;
    onInput?: () => void;
    /** Enter (or the action button) with no row to take it. */
    onSubmit?: () => void;
  }

  let {
    value = $bindable(),
    placeholder,
    icon,
    rows,
    hint = null,
    busy = false,
    idPrefix,
    action = null,
    busyLabel = null,
    error = null,
    onChoose,
    onFirstOpen,
    onInput,
    onSubmit,
  }: Props = $props();

  let listOpen = $state(false);
  let activeIndex = $state(0);
  // Non-reactive: whether this visit has already asked the parent to load.
  let opened = false;

  const panelOpen = $derived(listOpen && (rows.length > 0 || hint !== null));

  // Keep the highlighted row in range as the list changes under it.
  $effect(() => {
    if (activeIndex >= rows.length) activeIndex = 0;
  });

  function open() {
    listOpen = true;
    if (opened) return;
    opened = true;
    onFirstOpen?.();
  }

  function dismiss() {
    listOpen = false;
    activeIndex = 0;
  }

  function choose(row: ComboRow) {
    if (busy || row.disabled) return;
    dismiss();
    onChoose(row.key);
  }

  function submit() {
    const row = rows[activeIndex];
    if (row) {
      choose(row);
      return;
    }
    // Nothing to take it. The panel sits over the line the parent's error goes
    // on, so put it away first and let the message have the space.
    dismiss();
    onSubmit?.();
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      if (panelOpen) {
        event.preventDefault();
        dismiss();
      }
      return;
    }
    if (event.key === 'Enter' && !action) {
      // With an action button the form's own submit handles this.
      event.preventDefault();
      submit();
      return;
    }
    if (rows.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      open();
      activeIndex = (activeIndex + 1) % rows.length;
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      open();
      activeIndex = (activeIndex - 1 + rows.length) % rows.length;
    }
  }

  // Closing on focusout rather than a document click keeps the panel alive
  // while the reader tabs through it.
  function onFocusOut(event: FocusEvent) {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget instanceof Node) {
      if (event.currentTarget.contains(next)) return;
    }
    dismiss();
  }

  const rowId = (index: number) => `${idPrefix}-option-${index}`;

  // Arrow keys can walk past the bottom of a panel that scrolls, so keep the
  // highlighted row in sight. `nearest` leaves the panel alone when it already is.
  let panelEl = $state<HTMLDivElement | null>(null);
  $effect(() => {
    const el = panelEl?.querySelector(`#${CSS.escape(rowId(activeIndex))}`);
    el?.scrollIntoView({ block: 'nearest' });
  });
</script>

<div class="combo" onfocusout={onFocusOut}>
  <form
    class="combo-field"
    onsubmit={(e) => {
      e.preventDefault();
      submit();
    }}
  >
    <div class="combo-input-wrap">
      <Icon name={icon} size={15} />
      <input
        class="combo-input"
        type="text"
        {placeholder}
        bind:value
        autocomplete="off"
        onfocus={open}
        onclick={open}
        oninput={() => {
          open();
          activeIndex = 0;
          onInput?.();
        }}
        onkeydown={onKeydown}
        disabled={busy}
        role="combobox"
        aria-expanded={panelOpen}
        aria-controls={`${idPrefix}-results`}
        aria-autocomplete="list"
        aria-activedescendant={panelOpen && rows.length > 0 ? rowId(activeIndex) : undefined}
      />
      {#if !action && busy && busyLabel}
        <span class="combo-status">{busyLabel}</span>
      {/if}
    </div>
    {#if action}
      <button class="btn btn-primary" type="submit" disabled={busy}>
        {busy ? action.busyLabel : action.label}
      </button>
    {/if}
  </form>

  {#if panelOpen}
    <div class="combo-panel" bind:this={panelEl}>
      <!-- Rows keep focus in the input (preventDefault on mousedown): Safari
           doesn't focus a button on click, so the focusout above would close
           the panel out from under the press and swallow it. -->
      <ul class="combo-results" id={`${idPrefix}-results`} role="listbox">
        {#each rows as row, i (row.key)}
          <li role="presentation">
            <button
              class="combo-result"
              class:active={i === activeIndex}
              id={rowId(i)}
              type="button"
              role="option"
              aria-selected={i === activeIndex}
              disabled={busy || row.disabled}
              onmouseenter={() => (activeIndex = i)}
              onmousedown={(e) => e.preventDefault()}
              onclick={() => choose(row)}
            >
              <Icon name={row.icon} size={14} />
              <span class="combo-result-main">
                <span class="combo-result-title">{row.title}</span>
                {#if row.meta}
                  <span class="combo-result-meta">{row.meta}</span>
                {/if}
              </span>
              {#if row.note}
                <span class="combo-result-note">{row.note}</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
      {#if hint}
        <p class="combo-hint">{hint}</p>
      {/if}
    </div>
  {/if}

  {#if error}
    <p class="combo-error" role="alert">{error}</p>
  {/if}
</div>

<style>
  .combo {
    position: relative;
    margin-bottom: 1.5rem;
  }

  .combo-field {
    display: flex;
    gap: 0.5rem;
  }

  .combo-input-wrap {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    color: var(--color-text-secondary);
  }

  .combo-input-wrap:focus-within {
    border-color: var(--color-primary);
  }

  .combo-input {
    flex: 1;
    min-width: 0;
    border: none;
    background: none;
    padding: 0;
    font-size: var(--text-md);
    color: var(--color-text);
  }

  .combo-input:focus {
    outline: none;
  }

  /* iOS Safari zooms the viewport when a focused input is smaller than 16px,
     and it never zooms back out. */
  @media (hover: none) and (pointer: coarse) {
    .combo-input {
      font-size: var(--text-base);
    }
  }

  .combo-status {
    font-size: var(--text-sm);
    white-space: nowrap;
  }

  /* Floats over the room lists, so this one gets a shadow. */
  .combo-panel {
    position: absolute;
    z-index: 20;
    top: calc(100% + 0.25rem);
    left: 0;
    right: 0;
    max-height: 22rem;
    overflow-y: auto;
    padding: 0.25rem;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  }

  .combo-results {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .combo-result {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    text-align: left;
    padding: 0.5rem 0.625rem;
    background: none;
    border: none;
    border-radius: 6px;
    color: var(--color-text-secondary);
    font: inherit;
    cursor: pointer;
  }

  .combo-result.active:not(:disabled) {
    background: var(--color-bg-secondary);
  }

  .combo-result:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .combo-result-main {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
    flex: 1;
  }

  .combo-result-title {
    font-size: var(--text-sm);
    color: var(--color-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .combo-result-meta {
    font-size: var(--text-xs);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .combo-result-note {
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .combo-hint {
    margin: 0;
    padding: 0.5rem 0.625rem;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .combo-error {
    color: var(--color-error);
    font-size: var(--text-sm);
    margin: 0.5rem 0 0;
  }

  @media (prefers-color-scheme: dark) {
    .combo-panel {
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    }
  }
</style>
