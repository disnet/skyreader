<script lang="ts">
  /**
   * The open article's highlights, in reading order, to go back to or act on
   * together. A row goes to its passage (where the highlight's own toolbar
   * takes over); ticking rows offers what makes sense for several at once:
   * one Bluesky post of up to four, a copy of the lot, removing them. It only
   * lists and reports; the reader does the work.
   */
  import { SvelteSet } from 'svelte/reactivity';
  import Icon from '$lib/components/Icon.svelte';
  import { highlightQuote } from '$lib/utils/highlightSource';
  import { BLUESKY_MAX_IMAGES } from '$lib/utils/blueskyPost';
  import type { Highlight } from '$lib/types';

  interface Props {
    /** In the order they appear in the article. */
    highlights: readonly Highlight[];
    /** Go to a highlight in the article. Absent where it can't be shown (the original PDF). */
    onjump?: (id: string) => void;
    /** The ones whose passage is on the page now; the rest can't be gone to. */
    anchored?: ReadonlySet<string>;
    /** Absent when posting isn't possible here (a guest, no link). */
    onpost?: (ids: string[]) => void;
    oncopy: (ids: string[]) => void;
    /** Absent when there's nothing to draw it from. */
    onimage?: (id: string) => void;
    onremove: (ids: string[]) => void;
  }

  let { highlights, onjump, anchored, onpost, oncopy, onimage, onremove }: Props = $props();

  const canJump = (id: string) => !!onjump && (!anchored || anchored.has(id));

  const selected = new SvelteSet<string>();

  // A highlight removed elsewhere (its own toolbar, an undo) leaves the selection.
  $effect(() => {
    const present = new Set(highlights.map((h) => h.id));
    for (const id of selected) if (!present.has(id)) selected.delete(id);
  });

  let chosen = $derived(highlights.filter((h) => selected.has(h.id)).map((h) => h.id));
  let allChosen = $derived(highlights.length > 0 && chosen.length === highlights.length);
  let tooManyToPost = $derived(chosen.length > BLUESKY_MAX_IMAGES);

  function toggle(id: string) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
  }

  function toggleAll() {
    if (allChosen) selected.clear();
    else for (const h of highlights) selected.add(h.id);
  }

  function remove() {
    const ids = chosen;
    selected.clear();
    onremove(ids);
  }
</script>

<section class="reader-highlights" aria-label="Highlights in this article">
  <header class="rh-head">
    <span class="rh-count"
      >{highlights.length} {highlights.length === 1 ? 'highlight' : 'highlights'}</span
    >
    {#if highlights.length > 1}
      <button type="button" class="rh-link" onclick={toggleAll}>
        {allChosen ? 'Clear' : 'Select all'}
      </button>
    {/if}
  </header>

  <ol class="rh-list">
    {#each highlights as hl (hl.id)}
      {@const quote = highlightQuote(hl)}
      <li class="rh-row" class:chosen={selected.has(hl.id)}>
        <label class="rh-check">
          <input
            type="checkbox"
            checked={selected.has(hl.id)}
            onchange={() => toggle(hl.id)}
            aria-label={`Select “${quote.slice(0, 60)}”`}
          />
        </label>
        <button
          type="button"
          class="rh-body"
          disabled={!canJump(hl.id)}
          onclick={() => onjump?.(hl.id)}
          title={canJump(hl.id) ? 'Go to this highlight' : undefined}
        >
          <span class="rh-quote">{quote}</span>
          {#if onjump && anchored && !anchored.has(hl.id)}
            <span class="rh-missing">Not in this version of the text</span>
          {/if}
          {#if hl.note}
            <span class="rh-note">{hl.note}</span>
          {/if}
        </button>
      </li>
    {/each}
  </ol>

  {#if chosen.length > 0}
    <div class="rh-actions" role="toolbar" aria-label="Selected highlights">
      <span class="rh-selected">{chosen.length} selected</span>
      <div class="rh-buttons">
        {#if onpost}
          <button
            type="button"
            class="rh-action"
            disabled={tooManyToPost}
            title={tooManyToPost
              ? `A Bluesky post takes up to ${BLUESKY_MAX_IMAGES}`
              : 'Post to Bluesky'}
            onclick={() => onpost(chosen)}
          >
            <Icon name="bluesky" size={16} />
            <span>Post</span>
          </button>
        {/if}
        <button
          type="button"
          class="rh-action"
          title="Copy as Markdown"
          onclick={() => oncopy(chosen)}
        >
          <Icon name="copy" size={16} />
          <span>Copy</span>
        </button>
        {#if onimage && chosen.length === 1}
          <button
            type="button"
            class="rh-action"
            title="Save as image"
            onclick={() => onimage(chosen[0])}
          >
            <Icon name="download" size={16} />
            <span>Image</span>
          </button>
        {/if}
        <button type="button" class="rh-action danger" title="Remove" onclick={remove}>
          <Icon name="trash" size={16} />
          <span>Remove</span>
        </button>
      </div>
    </div>
  {/if}
</section>

<style>
  .reader-highlights {
    display: flex;
    flex-direction: column;
  }

  .rh-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.15rem 0.75rem 0.4rem;
    font-size: var(--text-sm, 0.875rem);
    color: var(--color-text-secondary);
  }

  .rh-link {
    border: none;
    background: none;
    padding: 0.2rem 0;
    font: inherit;
    color: var(--color-primary, #0066cc);
    cursor: pointer;
  }

  .rh-link:hover {
    text-decoration: underline;
  }

  .rh-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .rh-row {
    display: flex;
    align-items: flex-start;
    border-left: 2px solid transparent;
  }

  .rh-row.chosen {
    border-left-color: var(--color-primary, #0066cc);
    background: var(--color-bg-secondary, #f5f5f5);
  }

  .rh-check {
    flex: none;
    display: grid;
    place-items: center;
    width: 2.25rem;
    padding-top: 0.55rem;
    cursor: pointer;
  }

  .rh-check input {
    width: 1rem;
    height: 1rem;
    margin: 0;
    accent-color: var(--color-primary, #0066cc);
    cursor: pointer;
  }

  .rh-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.5rem 0.75rem 0.5rem 0;
    border: none;
    background: none;
    font: inherit;
    font-size: var(--text-sm, 0.875rem);
    line-height: 1.45;
    text-align: left;
    color: var(--color-text);
    cursor: pointer;
  }

  .rh-body:disabled {
    cursor: default;
  }

  .rh-row:not(.chosen):hover {
    background: var(--color-bg-secondary, #f5f5f5);
  }

  .rh-quote {
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
  }

  .rh-note {
    color: var(--color-text-secondary);
    font-style: italic;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .rh-missing {
    font-size: var(--text-xs, 0.75rem);
    color: var(--color-text-secondary);
  }

  /* Pinned to the bottom of whatever scrolls the list (the panel or the sheet),
     so the actions stay in reach of a long list. */
  .rh-actions {
    position: sticky;
    bottom: -0.5rem;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.25rem 0.5rem;
    margin-top: 0.35rem;
    padding: 0.5rem 0.5rem 0.5rem 0.75rem;
    border-top: 1px solid var(--color-border);
    background: var(--color-bg, #ffffff);
  }

  .rh-selected {
    font-size: var(--text-sm, 0.875rem);
    color: var(--color-text-secondary);
  }

  .rh-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }

  .rh-action {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.35rem 0.55rem;
    border: none;
    border-radius: 6px;
    background: none;
    font: inherit;
    font-size: var(--text-sm, 0.875rem);
    color: var(--color-text);
    cursor: pointer;
  }

  .rh-action:hover:not(:disabled) {
    background: var(--color-bg-secondary, #f5f5f5);
  }

  .rh-action:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .rh-action.danger {
    color: var(--color-error, #dc2626);
  }

  .rh-link:focus-visible,
  .rh-body:focus-visible,
  .rh-action:focus-visible {
    outline: 2px solid var(--color-primary, #0066cc);
    outline-offset: -2px;
  }

  /* On the box itself, clear of it: a ring on the whole cell sat off-centre. */
  .rh-check input:focus-visible {
    outline: 2px solid var(--color-primary, #0066cc);
    outline-offset: 2px;
    border-radius: 3px;
  }

  @media (hover: none) and (pointer: coarse) {
    .reader-highlights {
      font-size: var(--text-base, 1rem);
    }

    .rh-body,
    .rh-action,
    .rh-head {
      font-size: var(--text-base, 1rem);
    }

    .rh-check {
      width: 2.75rem;
      padding-top: 0.7rem;
    }

    .rh-check input {
      width: 1.2rem;
      height: 1.2rem;
    }

    .rh-body {
      padding-top: 0.65rem;
      padding-bottom: 0.65rem;
    }

    .rh-action {
      padding: 0.6rem 0.7rem;
    }
  }
</style>
