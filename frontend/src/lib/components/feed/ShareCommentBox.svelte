<script lang="ts">
  // Inline share-comment composer. Sharing is a one-tap action; this box then
  // lives inside the article card (below the text, above the controls) for as
  // long as the item is shared — add or edit commentary any time. It sits in the
  // page flow (no popover, no shadow). At rest the note reads muted; focusing
  // brings it forward and reveals the Save control inline on the right.
  import Icon from '$lib/components/Icon.svelte';

  interface Props {
    /** Existing note to seed the field with (empty for a fresh share). */
    initialNote?: string;
    /** Placeholder shown while empty. */
    placeholder?: string;
    /** Called with the trimmed note. Empty string clears an existing note. */
    onsubmit: (note: string) => void;
  }

  let { initialNote = '', placeholder = 'Add note to share…', onsubmit }: Props = $props();

  const MAX = 3000;

  let value = $state(initialNote);
  let focused = $state(false);
  let textareaEl = $state<HTMLTextAreaElement | null>(null);

  let trimmed = $derived(value.trim());
  // Compared against the live prop so Save disables again right after a save.
  let dirty = $derived(trimmed !== initialNote.trim());
  let nearLimit = $derived(value.length > MAX - 200);

  function autosize() {
    const el = textareaEl;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }

  $effect(() => {
    requestAnimationFrame(autosize);
  });

  function submit() {
    if (!dirty) return;
    onsubmit(trimmed);
    textareaEl?.blur();
  }

  function handleKeydown(e: KeyboardEvent) {
    // Keep typing from triggering the feed's global keyboard shortcuts.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      textareaEl?.blur();
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
      onblur={() => (focused = false)}
    ></textarea>
    <!-- Always rendered so it reserves its space — focusing reveals it via
         opacity/visibility, never a layout shift. -->
    <div class="actions" class:hidden={!focused}>
      {#if nearLimit}
        <span class="counter" class:over={value.length >= MAX}>{MAX - value.length}</span>
      {/if}
      <!-- preventDefault on mousedown keeps focus on the textarea so this click
           lands before the blur that would otherwise hide the button. -->
      <button
        type="button"
        class="btn btn-primary"
        tabindex={focused ? 0 : -1}
        aria-hidden={!focused}
        onmousedown={(e) => e.preventDefault()}
        onclick={submit}
        disabled={!dirty}
      >
        Save
      </button>
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
    font-size: 0.9375rem;
    line-height: 1.5;
    /* Comfortable measure for short commentary. */
    max-width: 60ch;
    transition: color 0.15s;
  }

  /* At rest the note recedes; focusing brings it forward. */
  .note-input.muted {
    color: var(--color-text-secondary);
  }

  .note-input::placeholder {
    /* Held to the same contrast bar as body text, not a decorative light gray. */
    color: var(--color-text-secondary);
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
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    color: var(--color-text-secondary);
  }

  .counter.over {
    color: var(--color-error, #f44336);
  }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.3125rem 0.875rem;
    font-size: 0.875rem;
    font-weight: 500;
    border: 1px solid transparent;
    border-radius: 6px;
    cursor: pointer;
    transition:
      background-color 0.15s,
      color 0.15s,
      border-color 0.15s;
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

  @media (prefers-reduced-motion: reduce) {
    .actions {
      transition: none;
    }
  }
</style>
