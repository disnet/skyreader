<script lang="ts">
  // Inline share-comment composer. Sharing is a one-tap action; this box then
  // lives inside the article card (below the text, above the controls) for as
  // long as the item is shared — add or edit commentary any time. It sits in the
  // page flow (no popover, no shadow). At rest the note reads muted; focusing
  // brings it forward and reveals the Save control inline on the right.
  import Icon from '$lib/components/Icon.svelte';
  import MentionAutocomplete from './MentionAutocomplete.svelte';
  import type { Highlight } from '$lib/types';

  interface Props {
    /** Existing note to seed the field with (empty for a fresh share). */
    initialNote?: string;
    /** Placeholder shown while empty. */
    placeholder?: string;
    /**
     * Highlights saved on the article being shared. When present, a Quotes
     * button appears next to Save; tapping a highlight drops it into the note as
     * a Markdown blockquote at the cursor.
     */
    highlights?: Highlight[];
    /** Called with the trimmed note. Empty string clears an existing note. */
    onsubmit: (note: string) => void;
  }

  let {
    initialNote = '',
    placeholder = 'Add note to share…',
    highlights = [],
    onsubmit,
  }: Props = $props();

  const MAX = 3000;

  let value = $state(initialNote);
  let focused = $state(false);
  let quotesOpen = $state(false);
  let textareaEl = $state<HTMLTextAreaElement | null>(null);
  let quotesBtnEl = $state<HTMLButtonElement | null>(null);
  let quotesPopupEl = $state<HTMLDivElement | null>(null);

  let hasHighlights = $derived(highlights.length > 0);

  let trimmed = $derived(value.trim());
  // Compared against the live prop so Save disables again right after a save.
  let dirty = $derived(trimmed !== initialNote.trim());
  let nearLimit = $derived(value.length > MAX - 200);
  // A saved, at-rest note: show a persistent "Saved" confirmation in place of the
  // (now hidden) Save control. Submitting blurs the field, so without this the
  // checkmark would just vanish — leaving the user unsure the note landed.
  let showSaved = $derived(!dirty && trimmed.length > 0);

  function autosize() {
    const el = textareaEl;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }

  $effect(() => {
    requestAnimationFrame(autosize);
  });

  // The highlights popup floats off the page plane (position: fixed), so it must
  // be measured against the viewport rather than trusting CSS anchoring: pick the
  // side with more room (flip above/below), cap its height to the space there,
  // and clamp horizontally so it never spills past either edge.
  function positionQuotesPopup() {
    const btn = quotesBtnEl;
    const pop = quotesPopupEl;
    if (!btn || !pop) return;
    const rect = btn.getBoundingClientRect();
    const gap = 6;
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const spaceAbove = rect.top - gap - margin;
    const spaceBelow = vh - rect.bottom - gap - margin;
    const placeAbove = spaceAbove >= spaceBelow;
    pop.style.maxHeight = `${Math.floor(Math.max(120, placeAbove ? spaceAbove : spaceBelow))}px`;

    // Measure after the height cap so the flip math uses the real rendered size.
    const popRect = pop.getBoundingClientRect();
    const top = placeAbove
      ? Math.max(margin, rect.top - gap - popRect.height)
      : Math.min(rect.bottom + gap, vh - popRect.height - margin);

    // Right-align to the button, then pull back inside both viewport edges.
    let left = rect.right - popRect.width;
    left = Math.min(left, vw - popRect.width - margin);
    left = Math.max(margin, left);

    pop.style.top = `${top}px`;
    pop.style.left = `${left}px`;
  }

  // Position on open and keep it pinned while the page scrolls or resizes.
  $effect(() => {
    if (!quotesOpen) return;
    const reposition = () => positionQuotesPopup();
    requestAnimationFrame(reposition);
    document.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      document.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  });

  function submit() {
    if (!dirty) return;
    onsubmit(trimmed);
    textareaEl?.blur();
  }

  // Drop a highlight into the note as a Markdown blockquote at the cursor. Each
  // line gets a `> ` so multi-line highlights stay one quote; blank lines around
  // it keep the blockquote separated from surrounding commentary.
  function insertQuote(text: string) {
    const el = textareaEl;
    if (!el) return;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? start;
    const before = value.slice(0, start);
    const after = value.slice(end);

    const block = text
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    // Pad to a blank-line boundary on each side, without doubling existing breaks.
    const lead =
      before.length === 0
        ? ''
        : before.endsWith('\n\n')
          ? ''
          : before.endsWith('\n')
            ? '\n'
            : '\n\n';
    const trail = after.length === 0 ? '' : after.startsWith('\n') ? '\n' : '\n\n';
    const insertText = `${lead}${block}${trail}`;

    value = before + insertText + after;
    quotesOpen = false;

    const caret = before.length + insertText.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
      autosize();
    });
  }

  function handleKeydown(e: KeyboardEvent) {
    // Keep typing from triggering the feed's global keyboard shortcuts.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      if (quotesOpen) {
        quotesOpen = false;
      } else {
        textareaEl?.blur();
      }
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<section class="comment-box" aria-label="Comment on share" onclick={(e) => e.stopPropagation()}>
  <div class="field">
    <span class="field-icon"><Icon name="message-circle" size={15} /></span>
    <textarea
      bind:this={textareaEl}
      bind:value
      class="note-input"
      class:muted={!focused}
      rows="1"
      maxlength={MAX}
      {placeholder}
      aria-label="Comment on share"
      oninput={autosize}
      onkeydown={handleKeydown}
      onfocus={() => (focused = true)}
      onblur={() => {
        focused = false;
        quotesOpen = false;
      }}
    ></textarea>
    <MentionAutocomplete {textareaEl} bind:value />
    <!-- Always rendered so it reserves its space — focusing (or a saved note at
         rest) reveals it via opacity/visibility, never a layout shift. -->
    <div class="actions" class:hidden={!focused && !showSaved}>
      {#if focused}
        {#if nearLimit}
          <span class="counter" class:over={value.length >= MAX}>{MAX - value.length}</span>
        {/if}
        {#if hasHighlights}
          <!-- Quotes: drop a saved highlight into the note as a blockquote. The
               popup lists every highlight; tapping one inserts it at the cursor.
               mousedown/preventDefault throughout keeps the textarea focused (and
               its caret intact) so the actions row doesn't blur away mid-tap. -->
          <div class="quotes-wrap">
            <button
              type="button"
              bind:this={quotesBtnEl}
              class="quotes-btn"
              class:active={quotesOpen}
              aria-label="Insert a highlight as a quote"
              aria-expanded={quotesOpen}
              title="Insert a highlight"
              onmousedown={(e) => e.preventDefault()}
              onclick={() => (quotesOpen = !quotesOpen)}
            >
              <Icon name="quote" size={16} />
            </button>
            {#if quotesOpen}
              <div
                bind:this={quotesPopupEl}
                class="quotes-popup"
                role="menu"
                aria-label="Your highlights"
              >
                <p class="quotes-head">Insert a highlight</p>
                <ul class="quotes-list">
                  {#each highlights as h (h.id)}
                    <li>
                      <button
                        type="button"
                        class="quote-item"
                        role="menuitem"
                        onmousedown={(e) => e.preventDefault()}
                        onclick={() => insertQuote(h.selector.exact)}
                      >
                        {h.selector.exact}
                      </button>
                    </li>
                  {/each}
                </ul>
              </div>
            {/if}
          </div>
        {/if}
        <!-- preventDefault on mousedown keeps focus on the textarea so this click
             lands before the blur that would otherwise hide the button. -->
        <button
          type="button"
          class="btn btn-primary"
          aria-label="Save"
          onmousedown={(e) => e.preventDefault()}
          onclick={submit}
          disabled={!dirty}
        >
          <!-- Mobile collapses the label to the check icon to keep the row compact;
               desktop keeps the word. -->
          <Icon name="check" size={16} />
          <span class="btn-text">Save</span>
        </button>
      {:else if showSaved}
        <!-- Persistent confirmation: the note landed. Stays until the user edits
             again, so the feedback doesn't blink out the moment they tap save. -->
        <span class="saved-pill" aria-live="polite">
          <Icon name="check" size={14} />
          <span class="saved-text">Saved</span>
        </span>
      {/if}
    </div>
  </div>
</section>

<style>
  .comment-box {
    /* In the card flow: separated by whitespace alone, never a floating shadow. */
    padding: 0.625rem 0.125rem;
    margin-top: 0.25rem;
    text-align: left;
  }

  .field {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
  }

  /* Box the icon to exactly one line of text and center it there, so it sits on
     the first line's optical center regardless of textarea padding. */
  .field-icon {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    height: calc(0.9375rem * 1.5);
    color: var(--color-text-secondary);
  }

  .note-input {
    flex: 1;
    min-width: 0;
    resize: none;
    border: none;
    outline: none;
    padding: 0;
    background: transparent;
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-lg);
    line-height: var(--leading-normal);
    /* Comfortable measure for short commentary. */
    max-width: 60ch;
    transition: color 0.15s;
  }

  /* At rest the note recedes; focusing brings it forward. */
  .note-input.muted {
    color: var(--color-text-secondary);
  }

  @media (max-width: 600px) {
    /* 16px keeps iOS Safari from auto-zooming when the field takes focus. */
    .note-input {
      font-size: var(--text-base);
    }
  }

  .note-input::placeholder {
    /* Muted prompt — it should recede behind the note you're about to write. */
    color: var(--color-text-secondary);
    opacity: 0.6;
  }

  .actions {
    flex-shrink: 0;
    /* Push to the far right edge, regardless of how wide the note runs. */
    margin-left: auto;
    /* Stick to the bottom so the button trails the last line as the note wraps,
       while the icon stays aligned to the first line. */
    align-self: flex-end;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    transition: opacity 0.14s ease-out;
  }

  /* Hidden but still occupying space, so showing it on focus never reflows. */
  .actions.hidden {
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
  }

  .counter {
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    color: var(--color-text-secondary);
  }

  /* Quote inserter — a quiet ghost icon button that anchors the highlights popup. */
  .quotes-wrap {
    position: relative;
    display: flex;
  }

  .quotes-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.3125rem;
    color: var(--color-text-secondary);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    cursor: pointer;
    transition:
      background-color 0.15s,
      color 0.15s;
  }

  .quotes-btn:hover,
  .quotes-btn.active {
    color: var(--color-primary, #0066cc);
    background: var(--color-bg-secondary, #f5f5f5);
  }

  /* Floats off the page plane — positioned in JS against the viewport (flip +
     clamp), so top/left/max-height are set inline. A flex column lets the list
     scroll inside whatever height the viewport allows while the head stays put. */
  .quotes-popup {
    position: fixed;
    z-index: 200;
    display: flex;
    flex-direction: column;
    width: min(22rem, calc(100vw - 1rem));
    padding: 0.375rem;
    background: var(--color-bg, #fff);
    border: 1px solid var(--color-border, #e0e0e0);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
    text-align: left;
  }

  .quotes-head {
    flex-shrink: 0;
    margin: 0;
    padding: 0.25rem 0.5rem 0.375rem;
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    color: var(--color-text-secondary);
  }

  .quotes-list {
    list-style: none;
    margin: 0;
    padding: 0;
    min-height: 0;
    overflow-y: auto;
  }

  .quote-item {
    display: block;
    width: 100%;
    padding: 0.5rem;
    font: inherit;
    font-size: var(--text-md);
    line-height: 1.4;
    color: var(--color-text);
    text-align: left;
    background: transparent;
    border: none;
    border-left: 2px solid var(--color-border, #e0e0e0);
    border-radius: 0 4px 4px 0;
    cursor: pointer;
    /* One line per highlight, ellipsized — the list stays compact and scannable. */
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition:
      background-color 0.15s,
      border-color 0.15s;
  }

  .quote-item:hover {
    background: var(--color-bg-secondary, #f5f5f5);
    border-left-color: var(--color-primary, #0066cc);
  }

  .counter.over {
    color: var(--color-error, #f44336);
  }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    padding: 0.3125rem 0.875rem;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    border: 1px solid transparent;
    border-radius: 6px;
    cursor: pointer;
    transition:
      background-color 0.15s,
      color 0.15s,
      border-color 0.15s;
  }

  /* Desktop shows the word; the check icon is the mobile-only form. */
  .btn :global(.icon) {
    display: none;
  }

  @media (max-width: 1000px) {
    .btn :global(.icon) {
      display: block;
    }

    .btn-text {
      display: none;
    }
  }

  .btn-primary {
    background: var(--color-primary, #0066cc);
    color: #fff;
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--color-primary-dark, #0052a3);
  }

  .btn-primary:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* At-rest confirmation that a note is saved — success green, quiet weight. */
  .saved-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    color: var(--color-success, #4caf50);
  }

  .saved-pill :global(.icon) {
    flex-shrink: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .actions {
      transition: none;
    }
  }

  @media (prefers-color-scheme: dark) {
    .quotes-popup {
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    }

    .quotes-btn:hover,
    .quotes-btn.active {
      background: rgba(255, 255, 255, 0.08);
    }
  }
</style>
