<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { tooltip } from '$lib/actions/tooltip';
  import type { Highlight } from '$lib/types';

  interface Props {
    highlight: Highlight;
    editing: boolean;
    /** `margin`: a note in the page margin. `gloss`: unfolded under its paragraph. */
    variant: 'margin' | 'gloss';
    /** Its passage is being pointed at. */
    active?: boolean;
    onEdit: () => void;
    /** Persist the note. Called with the draft on every way out of the editor. */
    onSave: (note: string) => void;
    onClose: () => void;
    onRemove: () => void;
    /** Absent for a guest (Margin is account-only). */
    onPublish?: () => void;
    /** Take a published note private again. Absent for a guest. */
    onUnpublish?: () => void;
    onHover?: (hovering: boolean) => void;
    /** Gloss only: fold the note back up. */
    onFold?: () => void;
  }

  let {
    highlight,
    editing,
    variant,
    active = false,
    onEdit,
    onSave,
    onClose,
    onRemove,
    onPublish,
    onUnpublish,
    onHover,
    onFold,
  }: Props = $props();

  let rootEl = $state<HTMLElement | null>(null);
  let editorEl = $state<HTMLElement | null>(null);
  // A press inside the note is in progress. Safari doesn't focus a clicked
  // button, so pressing Done looks like focus leaving for nowhere; the press
  // itself says it didn't.
  let pressingInside = false;
  let textareaEl = $state<HTMLTextAreaElement | null>(null);
  let draft = $state('');
  // True while an editor is open and its draft hasn't been handed to `onSave`.
  let dirty = false;

  // Seed the draft each time the editor opens, and put the caret at the end of
  // what's already written — you're adding to a note, not replacing it.
  $effect(() => {
    if (!editing) return;
    // Untracked: the host hands down fresh highlight objects as it re-measures,
    // and none of that may reset what's being written.
    draft = untrack(() => highlight.note ?? '');
    dirty = false;
    void tick().then(() => {
      if (!textareaEl) return;
      textareaEl.focus({ preventScroll: variant === 'margin' });
      const end = textareaEl.value.length;
      textareaEl.setSelectionRange(end, end);
      autosize();
    });
  });

  function autosize() {
    const el = textareaEl;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  function commit() {
    if (!dirty) return;
    dirty = false;
    onSave(draft);
  }

  function finish() {
    commit();
    onClose();
  }

  function handleInput() {
    dirty = true;
    autosize();
  }

  function handleKeydown(e: KeyboardEvent) {
    // Escape and ⌘/Ctrl+Enter both put the pen down. Neither discards: a margin
    // note is never lost to a stray key.
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      e.stopPropagation();
      finish();
      return;
    }
    // Keep typing from triggering the reader's single-key shortcuts.
    e.stopPropagation();
  }

  // Leaving the note (focus moves anywhere outside it) saves and closes it.
  // Only the editor's own controls count: opening the editor removes the button
  // that opened it, and Chrome reports that removal as the button losing focus.
  // Where focus actually went is checked once it has settled.
  function handleFocusOut(e: FocusEvent) {
    if (!editing || !editorEl?.contains(e.target as Node) || pressingInside) return;
    const next = e.relatedTarget as Node | null;
    if (next && rootEl?.contains(next)) return;
    queueMicrotask(() => {
      if (editing && !rootEl?.contains(document.activeElement)) finish();
    });
  }

  // A tab going to the background may never come back; save what's written.
  function handleVisibility() {
    if (document.visibilityState === 'hidden' && editing) commit();
  }

  $effect(() => {
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  });

  // The article can re-render underneath an open editor (a lazy body settling);
  // whatever was written goes with it into the store, not into the void.
  onDestroy(commit);

  const onMargin = $derived(!!highlight.marginUri);
  const hasNote = $derived(!!highlight.note?.trim());
</script>

<!-- Who can see the note, and the one step that changes it. -->
{#snippet visibility()}
  <span
    class="tool-status visibility"
    use:tooltip={onMargin ? 'Public on margin.at' : 'Only you can see this'}
  >
    <Icon name={onMargin ? 'globe' : 'lock'} size={12} />
    {onMargin ? 'Public' : 'Private'}
  </span>
  {#if onMargin && onUnpublish}
    <button
      class="tool"
      use:tooltip={'Removes it from margin.at'}
      onclick={() => {
        commit();
        onUnpublish?.();
      }}
    >
      Make private
    </button>
  {:else if !onMargin && onPublish}
    <button
      class="tool"
      use:tooltip={'Anyone will be able to see it, on margin.at'}
      onclick={() => {
        commit();
        onPublish?.();
      }}
    >
      <Icon name="margin" size={13} />
      Publish
    </button>
  {/if}
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="marginalia-note {variant}"
  class:editing
  class:active
  bind:this={rootEl}
  onmouseenter={() => onHover?.(true)}
  onmouseleave={() => onHover?.(false)}
  onfocusout={handleFocusOut}
  onpointerdown={() => {
    pressingInside = true;
    window.addEventListener('pointerup', () => setTimeout(() => (pressingInside = false)), {
      once: true,
    });
  }}
>
  {#if editing}
    <div class="editor" bind:this={editorEl}>
      <label class="visually-hidden" for="note-{highlight.id}">Note</label>
      <textarea
        id="note-{highlight.id}"
        class="note-hand note-input"
        bind:this={textareaEl}
        bind:value={draft}
        rows="2"
        placeholder="Write a note"
        oninput={handleInput}
        onkeydown={handleKeydown}></textarea>
      <div class="note-tools">
        {@render visibility()}
        <span class="tools-end">
          <button
            class="tool remove"
            aria-label="Remove highlight"
            use:tooltip={'Remove highlight'}
            onclick={() => {
              dirty = false;
              onRemove();
            }}
          >
            <Icon name="trash" size={14} />
          </button>
          <button class="tool done" onclick={finish}>Done</button>
        </span>
      </div>
    </div>
  {:else if hasNote}
    <button class="note-hand note-read" onclick={onEdit} aria-label="Edit note: {highlight.note}">
      <span class="note-text"
        >{highlight.note}<span
          class="visibility-mark"
          class:public={onMargin}
          use:tooltip={onMargin ? 'Public on margin.at' : 'Private'}
          ><Icon name={onMargin ? 'globe' : 'lock'} size={11} /><span class="visually-hidden"
            >{onMargin ? ' (public)' : ' (private)'}</span
          ></span
        ></span
      >
    </button>
    {#if variant === 'gloss'}
      <div class="gloss-foot">
        {@render visibility()}
        <!-- Same slots as the editor's row, so a tap never lands on a control
             that moved in under the finger: Edit becomes Done in place. -->
        <span class="tools-end">
          <button class="tool" onclick={onFold}>Close</button>
          <button class="tool" onclick={onEdit}>Edit</button>
        </span>
      </div>
    {/if}
  {/if}
</div>

<style>
  .marginalia-note {
    position: relative;
    color: var(--ink-note);
    font-size: calc(var(--article-font-size, 1.125rem) * 0.9);
  }

  /* Handwriting, sized off the article so a note keeps its proportion to the
     text it's about when the reader changes type size. */
  .note-hand {
    font-family: var(--font-hand);
    font-size: 1em;
    line-height: 1.34;
    color: inherit;
    letter-spacing: 0.005em;
  }

  .note-read {
    display: block;
    width: 100%;
    padding: 0;
    border: none;
    background: none;
    text-align: left;
    cursor: text;
    border-radius: 2px;
  }

  .note-text {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 7;
    line-clamp: 7;
    overflow: hidden;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .gloss .note-text {
    -webkit-line-clamp: unset;
    line-clamp: unset;
    display: block;
  }

  .note-read:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 3px;
  }

  /* Pointing at a note (or its passage) darkens the ink a touch: the same
     note, pressed a little harder. */
  .marginalia-note.margin {
    opacity: 0.86;
    transition: opacity 0.18s ease;
  }

  .marginalia-note.margin.active,
  .marginalia-note.margin.editing,
  .marginalia-note.margin:hover,
  .marginalia-note.margin:focus-within {
    opacity: 1;
  }

  /* Writing: no box, no border. The pen goes straight onto the page, over a
     faint pencil rule that says "this is where it goes". */
  .note-input {
    display: block;
    width: 100%;
    min-height: 2.8em;
    margin: 0;
    padding: 0 0 0.15em;
    border: none;
    border-radius: 0;
    background: linear-gradient(var(--ink-note-soft), var(--ink-note-soft)) left bottom / 100% 1px
      no-repeat;
    resize: none;
    overflow: hidden;
    outline: none;
    caret-color: var(--ink-note);
    field-sizing: content;
  }

  .note-input::placeholder {
    color: var(--ink-note-soft);
    opacity: 1;
  }

  .note-input::selection {
    background: color-mix(in srgb, #f5c518 38%, transparent);
  }

  /* The few tools a note needs, in the chrome voice: typed, small, quiet. */
  .note-tools,
  .gloss-foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem;
    margin-top: 0.4rem;
    font-family: var(--font-sans-serif);
    font-size: var(--text-xs);
    line-height: 1;
  }

  .tool,
  .tool-status {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    min-height: 1.75rem;
    padding: 0 0.45rem;
    border: none;
    border-radius: 4px;
    background: none;
    color: var(--color-text-secondary);
    font: inherit;
    white-space: nowrap;
  }

  .tool {
    cursor: pointer;
  }

  /* The note's own actions hold the right end of the row; whatever the
     visibility controls on the left say, these don't move. */
  .tools-end {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    margin-left: auto;
  }

  .tools-end .tool:last-child {
    margin-right: -0.45rem;
  }

  /* Who can see a note: a lock while it's yours alone, a globe once it's
     published. Quiet enough to ignore, there when you look for it. */
  .visibility {
    cursor: default;
  }

  .visibility-mark {
    display: inline-flex;
    margin-left: 0.35em;
    vertical-align: -0.05em;
    color: var(--ink-note-soft);
    opacity: 0.7;
    transition: opacity 0.18s ease;
  }

  /* The gloss says it in its foot instead. */
  .gloss .visibility-mark {
    display: none;
  }

  .marginalia-note:hover .visibility-mark,
  .marginalia-note.active .visibility-mark,
  .visibility-mark.public {
    opacity: 1;
  }

  .tool:first-child,
  .tool-status:first-child {
    margin-left: -0.45rem;
  }

  .tool:hover {
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }

  .tool:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  .tool.done {
    color: var(--color-primary);
    font-weight: var(--weight-medium, 500);
  }

  .tool.remove:hover {
    color: var(--color-error, #d32f2f);
  }

  .tool-status {
    color: var(--ink-note);
  }

  /* ── The gloss: a note unfolded under its paragraph ─────────────
     Set off by a hand-ruled line down its left, the way a reader squeezes a
     note between the lines when there is no margin to write in. */
  /* Set into the paragraph right after its passage; the text resumes below. */
  .marginalia-note.gloss {
    margin: 0.5em 0 0.75em;
    padding: 0.1em 0 0.1em 1rem;
    background: var(--gloss-rule) 0.05rem 0.3em / 6px 5em repeat-y;
    animation: gloss-unfold 260ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }

  .gloss .gloss-foot {
    margin-top: 0.25rem;
  }

  @keyframes gloss-unfold {
    from {
      opacity: 0;
      transform: translateY(-0.35rem);
    }
  }

  @media (pointer: coarse) {
    .tool,
    .tool-status {
      min-height: 2.25rem;
      font-size: var(--text-sm);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .marginalia-note.gloss {
      animation: none;
    }

    .marginalia-note.margin {
      transition: none;
    }
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
