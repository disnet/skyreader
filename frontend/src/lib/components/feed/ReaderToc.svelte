<script lang="ts">
  /**
   * The reader's table of contents: a flat, indented list of an article's
   * sections, the one being read marked. It only lists and reports; the host
   * knows how to get there (a scroll, a page turn, a page of the original PDF).
   */
  import { onMount } from 'svelte';

  interface Props {
    entries: readonly { title: string; level: number }[];
    /** The entry being read, or -1. */
    current: number;
    onselect: (index: number) => void;
  }

  let { entries, current, onselect }: Props = $props();

  let listEl = $state<HTMLOListElement | null>(null);

  // Open on where you are, not on the top of a long book's list. Scrolls only
  // the nearest scroller (the panel or sheet holding the list): `scrollIntoView`
  // would move the article behind it too.
  onMount(() => {
    const item = listEl?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!item) return;
    for (let el = item.parentElement; el; el = el.parentElement) {
      const overflow = getComputedStyle(el).overflowY;
      if (overflow !== 'auto' && overflow !== 'scroll') continue;
      const offset = item.getBoundingClientRect().top - el.getBoundingClientRect().top;
      el.scrollTop += offset - (el.clientHeight - item.offsetHeight) / 2;
      return;
    }
  });
</script>

<nav class="reader-toc" aria-label="Contents">
  <ol bind:this={listEl}>
    {#each entries as entry, i (i)}
      <li>
        <button
          type="button"
          class="toc-item"
          class:current={i === current}
          style:--toc-level={entry.level - 1}
          aria-current={i === current ? 'location' : undefined}
          onclick={() => onselect(i)}
        >
          {entry.title}
        </button>
      </li>
    {/each}
  </ol>
</nav>

<style>
  .reader-toc ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .toc-item {
    display: block;
    width: 100%;
    padding: 0.45rem 0.75rem 0.45rem calc(0.75rem + var(--toc-level, 0) * 1rem);
    border: none;
    border-left: 2px solid transparent;
    background: none;
    font: inherit;
    font-size: var(--text-sm, 0.875rem);
    line-height: 1.35;
    text-align: left;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }

  .toc-item:hover {
    color: var(--color-text);
    background: var(--color-bg-secondary, #f5f5f5);
  }

  .toc-item.current {
    color: var(--color-text);
    font-weight: var(--weight-semibold, 600);
    border-left-color: var(--color-primary, #0066cc);
  }

  .toc-item:focus-visible {
    outline: 2px solid var(--color-primary, #0066cc);
    outline-offset: -2px;
  }

  @media (hover: none) and (pointer: coarse) {
    .toc-item {
      padding-top: 0.65rem;
      padding-bottom: 0.65rem;
      font-size: var(--text-base, 1rem);
    }
  }
</style>
