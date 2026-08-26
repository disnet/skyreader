<script lang="ts">
  // Drawing one edge, in one breath.
  //
  // Mounted once in AppShell and driven by sembleConnectionStore, so any reading
  // surface can open it (the same architecture as the collection picker).
  //
  // <!--
  // THESIS: a connection is a SENTENCE — this article, a relation, that one —
  //   so the dialog is read top to bottom as that sentence being completed,
  //   not as a form with four labelled fields.
  // OWN-WORLD: the reading room's modal chrome, flat surfaces, one interaction
  //   blue, system sans. Nothing new is invented here.
  // STORY: the reader finishes something, thinks "this answers that", names the
  //   other piece (pasted, or out of their own Saved list), picks the relation,
  //   and it's drawn.
  // FIRST VIEWPORT: the sentence with one end already filled, then the field
  //   that fills the other, then the relations.
  // -->
  import Modal from '$lib/components/common/Modal.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { api } from '$lib/services/api';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { sembleConnectionStore } from '$lib/stores/sembleConnection.svelte';
  import { matchesTerms, normalize, parseQuery } from '$lib/services/savedSearch';
  import { sembleSourceUrl } from '$lib/utils/semble';
  import {
    NON_DIRECTIONAL_CONNECTION_TYPES,
    SEMBLE_CONNECTION_TYPES,
    type SavedItem,
    type SembleCard,
    type SembleConnectionType,
  } from '$lib/types';

  type SearchItem = {
    key: string;
    url: string;
    title?: string;
    author?: string;
    domain?: string;
  };

  /** Saved articles offered at once. The field is for finding one, not browsing. */
  const RESULT_LIMIT = 6;
  /** Semble's lexicon caps the note here (atproto string maxLength = UTF-8 bytes). */
  const MAX_NOTE_BYTES = 1000;

  let open = $derived(sembleConnectionStore.open);
  let source = $derived(sembleConnectionStore.source);
  let articleUrl = $derived(source ? sembleSourceUrl(source.cardUrl, source.url) : '');
  let submitting = $derived(sembleConnectionStore.submitting);

  let query = $state('');
  let targetUrl = $state('');
  let targetTitle = $state<string | undefined>(undefined);
  let connectionType = $state<SembleConnectionType>('RELATED');
  let note = $state('');
  let reversed = $state(false);
  let sembleCards = $state<SembleCard[]>([]);
  let cardsLoading = $state(false);
  let cardsLoadedForOpen = false;

  // Whether this session can write a connection at all. Read once and cached for
  // the tab: it's a property of the session, and every existing session lacks the
  // scope — saying so up front beats failing on submit.
  let hasScope = $state<boolean | null>(null);
  let scopeChecked = false;

  $effect(() => {
    if (!open) {
      query = '';
      targetUrl = '';
      targetTitle = undefined;
      connectionType = 'RELATED';
      note = '';
      reversed = false;
      sembleCards = [];
      cardsLoading = false;
      cardsLoadedForOpen = false;
      return;
    }
    void savesStore.load();
    if (!cardsLoadedForOpen) {
      cardsLoadedForOpen = true;
      cardsLoading = true;
      api
        .listSembleCards()
        .then(({ cards }) => {
          sembleCards = cards;
        })
        .catch(() => {
          // Local Saved search remains useful if Semble cannot be reached.
          sembleCards = [];
        })
        .finally(() => {
          cardsLoading = false;
        });
    }
    if (scopeChecked) return;
    scopeChecked = true;
    api
      .getIntegrationStatus()
      .then((status) => {
        hasScope = status.scopeStatus.sembleConnections ?? false;
      })
      .catch(() => {
        // Advisory only — a failed check must not block the write.
        hasScope = null;
      });
  });

  function hostOf(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  function labelFor(url: string, title?: string | null): string {
    return title?.trim() || hostOf(url);
  }

  /** `LEADS_TO` → `leads to`, the way the panel already renders relations. */
  function typeLabel(type: SembleConnectionType): string {
    return type.toLowerCase().replace(/_/g, ' ');
  }

  let directional = $derived(!NON_DIRECTIONAL_CONNECTION_TYPES.includes(connectionType));

  // A non-directional relation reads the same either way, so the swap control
  // has nothing to do — and a flip made under a directional type must not
  // silently survive into the record, since the backend writes the edge
  // whichever way round it's handed.
  function chooseType(type: SembleConnectionType) {
    connectionType = type;
    if (NON_DIRECTIONAL_CONNECTION_TYPES.includes(type)) reversed = false;
  }

  // ── Finding the other end ───────────────────────────────────────────────
  // Two ways in, one field: paste a URL, or search what you've already saved.
  // Typing a URL is its own answer, so the result list gets out of the way.
  let queryIsUrl = $derived(isHttpUrl(query.trim()));

  function isHttpUrl(value: string): boolean {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  function savedHaystack(item: SearchItem): string {
    return normalize([item.title, item.author, item.domain, item.url].filter(Boolean).join(' '));
  }

  let results = $derived.by((): SearchItem[] => {
    const terms = parseQuery(query);
    if (terms.length === 0 || queryIsUrl) return [];
    const candidates: SearchItem[] = [
      ...sembleCards.map((card) => ({
        key: card.uri,
        url: card.url,
        title: card.title,
        author: card.author,
        domain: hostOf(card.url),
      })),
      ...savesStore.articles.map((item: SavedItem) => ({
        key: item.uri,
        url: item.url,
        title: item.title ?? undefined,
        author: item.author ?? undefined,
        domain: item.domain ?? undefined,
      })),
    ];
    const seen = new Set<string>();
    const out: SearchItem[] = [];
    for (const item of candidates) {
      if (item.url === articleUrl) continue;
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      if (!matchesTerms(savedHaystack(item), terms)) continue;
      out.push(item);
      if (out.length >= RESULT_LIMIT) break;
    }
    return out;
  });

  function chooseSaved(item: SearchItem) {
    targetUrl = item.url;
    targetTitle = item.title ?? undefined;
    query = '';
  }

  // The results float over the dialog rather than sitting in its flow: an
  // in-flow list reflows and resizes the modal on every keystroke. But the
  // modal body scrolls (`overflow-y: auto`), which clips an absolutely
  // positioned child at the footer — so the popover is `position: fixed`,
  // whose containing block is the viewport, and is measured against the field.
  let searchRow = $state<HTMLElement | null>(null);
  let showResults = $derived(parseQuery(query).length > 0 && !queryIsUrl);
  let popover = $state<{
    top?: number;
    bottom?: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  /** Gap between the field and the popover, and from the popover to the viewport edge. */
  const POPOVER_GAP = 4;
  const VIEWPORT_MARGIN = 8;
  /** Below this much room underneath, the list is better off opening upward. */
  const FLIP_THRESHOLD = 120;
  const POPOVER_MAX_HEIGHT = 240;

  function measurePopover() {
    if (!searchRow) {
      popover = null;
      return;
    }
    const rect = searchRow.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - POPOVER_GAP - VIEWPORT_MARGIN;
    const above = rect.top - POPOVER_GAP - VIEWPORT_MARGIN;
    const flip = below < FLIP_THRESHOLD && above > below;
    const maxHeight = Math.max(0, Math.min(POPOVER_MAX_HEIGHT, flip ? above : below));
    // Anchored by the edge it grows from, so a short list hugs the field
    // either way round.
    popover = flip
      ? {
          bottom: window.innerHeight - rect.top + POPOVER_GAP,
          left: rect.left,
          width: rect.width,
          maxHeight,
        }
      : { top: rect.bottom + POPOVER_GAP, left: rect.left, width: rect.width, maxHeight };
  }

  $effect(() => {
    if (!showResults) {
      popover = null;
      return;
    }
    // A longer list can outgrow the room below and need flipping.
    results.length;
    measurePopover();
    window.addEventListener('resize', measurePopover);
    // Capture phase: the modal body is the scroller, not the window.
    window.addEventListener('scroll', measurePopover, true);
    return () => {
      window.removeEventListener('resize', measurePopover);
      window.removeEventListener('scroll', measurePopover, true);
    };
  });

  function clearTarget() {
    targetUrl = '';
    targetTitle = undefined;
  }

  // A pasted URL is the answer as soon as it's a URL — no second confirming click.
  $effect(() => {
    const trimmed = query.trim();
    if (isHttpUrl(trimmed)) {
      targetUrl = trimmed;
      targetTitle = undefined;
      query = '';
    }
  });

  // ── The sentence, and whether it can be drawn ───────────────────────────
  let noteBytes = $derived(new TextEncoder().encode(note.trim()).length);
  let noteTooLong = $derived(noteBytes > MAX_NOTE_BYTES);
  let sameUrl = $derived(Boolean(targetUrl) && targetUrl === articleUrl);
  let canSubmit = $derived(
    Boolean(source) && Boolean(targetUrl) && !sameUrl && !noteTooLong && !submitting
  );

  let fromLabel = $derived(
    reversed
      ? labelFor(targetUrl, targetTitle)
      : labelFor(source?.url ?? '', source?.title ?? undefined)
  );
  let toLabel = $derived(
    reversed
      ? labelFor(source?.url ?? '', source?.title ?? undefined)
      : labelFor(targetUrl, targetTitle)
  );

  function handleSubmit() {
    if (!canSubmit) return;
    void sembleConnectionStore.submit({
      targetUrl,
      targetTitle,
      connectionType,
      note: note.trim() || undefined,
      reversed,
    });
  }
</script>

<Modal
  {open}
  onclose={() => sembleConnectionStore.close()}
  maxWidth="520px"
  title="Connect on Semble"
>
  <div class="connect-body">
    {#if hasScope === false}
      <p class="notice notice-warn">
        <span class="notice-icon" aria-hidden="true"><Icon name="alert-circle" size={15} /></span>
        <span>You'll be asked to log in again to allow this.</span>
      </p>
    {/if}

    <!-- The sentence. One end is fixed (what you're reading); the other is the
         blank the field below fills, so it stays visible as a blank. -->
    <p class="sentence">
      <span class="end" class:blank={!(reversed ? targetUrl : source)}>{fromLabel || '…'}</span>
      <span class="relation">
        <Icon name="arrow-right" size={14} />
        <span class="relation-type">{typeLabel(connectionType)}</span>
        <Icon name="arrow-right" size={14} />
      </span>
      <span class="end" class:blank={!(reversed ? source : targetUrl)}>{toLabel || '…'}</span>
    </p>

    {#if directional}
      <button
        type="button"
        class="swap"
        onclick={() => (reversed = !reversed)}
        disabled={!targetUrl}
      >
        <Icon name="refresh-cw" size={13} />
        Swap direction
      </button>
    {/if}

    <!-- The other end -->
    {#if targetUrl}
      <div class="chosen">
        <span class="chosen-icon" aria-hidden="true"><Icon name="link" size={14} /></span>
        <span class="chosen-text">
          <span class="chosen-title">{labelFor(targetUrl, targetTitle)}</span>
          <span class="chosen-url">{targetUrl}</span>
        </span>
        <button
          type="button"
          class="chosen-clear"
          onclick={clearTarget}
          aria-label="Choose a different article"
        >
          <Icon name="x" size={14} />
        </button>
      </div>
      {#if sameUrl}
        <p class="field-error">That's the article you're on. Pick a different one.</p>
      {/if}
    {:else}
      <div class="search-shell">
        <div class="search-row" bind:this={searchRow}>
          <span class="search-icon" aria-hidden="true"><Icon name="search" size={16} /></span>
          <!-- svelte-ignore a11y_autofocus -->
          <input
            type="text"
            class="search-input"
            placeholder="Paste a URL, or search your Semble cards"
            aria-label="The other end of the connection"
            role="combobox"
            aria-expanded={showResults}
            aria-controls="semble-card-results"
            aria-autocomplete="list"
            bind:value={query}
            autofocus
          />
        </div>
        {#if showResults && popover}
          <div
            class="results-popover"
            id="semble-card-results"
            style:left="{popover.left}px"
            style:width="{popover.width}px"
            style:max-height="{popover.maxHeight}px"
            style:top={popover.top === undefined ? undefined : `${popover.top}px`}
            style:bottom={popover.bottom === undefined ? undefined : `${popover.bottom}px`}
          >
            {#if results.length > 0}
              <ul class="results">
                {#each results as item (item.key)}
                  <li>
                    <button type="button" class="result" onclick={() => chooseSaved(item)}>
                      <span class="result-title">{labelFor(item.url, item.title)}</span>
                      <span class="result-host">{hostOf(item.url)}</span>
                    </button>
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="hint">
                {cardsLoading ? 'Checking your Semble cards…' : 'No matches. Paste a URL instead.'}
              </p>
            {/if}
          </div>
        {/if}
      </div>
    {/if}

    <!-- The relation -->
    <div class="types" role="radiogroup" aria-label="Connection type">
      {#each SEMBLE_CONNECTION_TYPES as type (type)}
        <button
          type="button"
          class="type-pill"
          class:selected={connectionType === type}
          role="radio"
          aria-checked={connectionType === type}
          onclick={() => chooseType(type)}
        >
          {typeLabel(type)}
        </button>
      {/each}
    </div>

    <textarea
      class="note"
      rows="2"
      placeholder="Why? (optional)"
      aria-label="Note"
      bind:value={note}></textarea>
    {#if noteBytes > MAX_NOTE_BYTES - 100}
      <p class="field-error" class:soft={!noteTooLong}>
        {MAX_NOTE_BYTES - noteBytes} characters left
      </p>
    {/if}
  </div>

  {#snippet footer()}
    <button
      class="btn btn-secondary"
      onclick={() => sembleConnectionStore.close()}
      disabled={submitting}
      type="button">Cancel</button
    >
    <button class="btn btn-primary" onclick={handleSubmit} disabled={!canSubmit} type="button">
      {submitting ? 'Connecting…' : 'Connect'}
    </button>
  {/snippet}
</Modal>

<style>
  .connect-body {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-height: 0;
  }

  /* ── Notice ─────────────────────────────────────────────────
     Same shape as the collection picker's, so an out-of-band
     message reads the same wherever the reader meets it. */
  .notice {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    margin: 0;
    font-size: var(--text-md);
    line-height: var(--leading-snug);
    color: var(--color-text-secondary);
  }

  .notice-warn {
    padding: 0.5rem 0.625rem;
    border-radius: 6px;
    background: var(--color-bg-secondary);
  }

  .notice-icon {
    display: flex;
    flex-shrink: 0;
    margin-top: 0.0625rem;
    color: var(--color-warning);
  }

  /* ── The sentence ───────────────────────────────────────────
     Reads left to right as what will be written. The unfilled end
     stays a visible blank rather than collapsing. */
  .sentence {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
    font-size: var(--text-lg);
    line-height: var(--leading-snug);
    color: var(--color-text);
  }

  .end {
    flex: 1 1 8rem;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: var(--weight-medium);
  }

  .end.blank {
    color: var(--color-text-secondary);
    font-weight: var(--weight-normal);
  }

  .relation {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
    color: var(--color-primary);
    font-size: var(--text-sm);
  }

  .relation-type {
    font-weight: var(--weight-medium);
  }

  .swap {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    padding: 0;
    border: none;
    background: none;
    font: inherit;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .swap:hover:not(:disabled) {
    color: var(--color-primary);
  }

  .swap:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* ── The other end ──────────────────────────────────────────── */
  .search-shell {
    min-width: 0;
  }

  .search-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4375rem 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    transition: border-color 0.15s ease;
  }

  .search-row:focus-within {
    border-color: var(--color-primary);
  }

  .search-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  .search-input {
    flex: 1;
    min-width: 0;
    border: none;
    outline: none;
    background: transparent;
    font-family: inherit;
    font-size: var(--text-lg);
    color: var(--color-text);
  }

  .search-input::placeholder {
    color: var(--color-text-secondary);
  }

  .results {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  /* Fixed, not absolute: the scrolling modal body would clip an absolutely
     positioned child. Coordinates come from `measurePopover`. */
  .results-popover {
    position: fixed;
    z-index: 2;
    overflow-y: auto;
    padding: 0.25rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
  }

  .result {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    width: 100%;
    padding: 0.375rem 0.5rem;
    border: none;
    border-radius: 6px;
    background: none;
    font: inherit;
    text-align: left;
    color: var(--color-text);
    cursor: pointer;
  }

  .result:hover {
    background: var(--color-bg-secondary);
  }

  .result:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
  }

  .result-title {
    font-size: var(--text-md);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .result-host {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .chosen {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
  }

  .chosen-icon {
    display: flex;
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  .chosen-text {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
    flex: 1;
  }

  .chosen-title,
  .chosen-url {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chosen-title {
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
  }

  .chosen-url {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .chosen-clear {
    display: flex;
    flex-shrink: 0;
    padding: 0.25rem;
    border: none;
    border-radius: 4px;
    background: none;
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .chosen-clear:hover {
    color: var(--color-text);
  }

  .hint {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .field-error {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--color-error);
  }

  .field-error.soft {
    color: var(--color-text-secondary);
  }

  /* ── The relation ───────────────────────────────────────────── */
  .types {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  .type-pill {
    padding: 0.25rem 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: none;
    font: inherit;
    font-size: var(--text-sm);
    line-height: var(--leading-none);
    color: var(--color-text-secondary);
    cursor: pointer;
    transition:
      border-color 0.15s ease,
      color 0.15s ease,
      background-color 0.15s ease;
  }

  .type-pill:hover {
    color: var(--color-text);
  }

  .type-pill.selected {
    border-color: var(--color-primary);
    background: var(--color-sidebar-active);
    color: var(--color-primary);
    font-weight: var(--weight-medium);
  }

  .type-pill:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  .note {
    width: 100%;
    padding: 0.5rem 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    font-family: inherit;
    font-size: var(--text-md);
    line-height: var(--leading-snug);
    color: var(--color-text);
    resize: vertical;
  }

  .note:focus {
    outline: none;
    border-color: var(--color-primary);
  }

  .note::placeholder {
    color: var(--color-text-secondary);
  }

  /* ── Buttons ─────────────────────────────────────────────────
     Same vocabulary as the collection picker's footer. */
  .btn {
    padding: 0.5rem 1rem;
    border-radius: 6px;
    font-family: inherit;
    font-size: var(--text-lg);
    font-weight: var(--weight-medium);
    cursor: pointer;
    border: 1px solid transparent;
    transition: background-color 0.2s ease;
  }

  .btn:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  .btn-secondary {
    background: transparent;
    color: var(--color-text);
    border-color: var(--color-border);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--color-bg-secondary);
  }

  .btn-primary {
    background: var(--color-primary);
    color: #ffffff;
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--color-primary-dark);
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  @media (prefers-reduced-motion: reduce) {
    .search-row,
    .type-pill,
    .btn {
      transition: none;
    }
  }
</style>
