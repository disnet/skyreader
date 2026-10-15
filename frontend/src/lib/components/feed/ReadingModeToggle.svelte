<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';
  import { preferences, type ReaderViewMode } from '$lib/stores/preferences.svelte';

  // Scroll vs. Kindle-style pages. On desktop this lives in the reader header as
  // a single toggle button; on mobile it sits here, in the style sheet, next to
  // the font and size controls it belongs with — the bar stays down to five.
  // A host with its own mode for the open item (a saved EPUB remembers its own)
  // passes it in; otherwise this is the reader-wide preference.
  let { mode, onchange }: { mode?: ReaderViewMode; onchange?: (mode: ReaderViewMode) => void } =
    $props();

  let paged = $derived((mode ?? preferences.readerViewMode) === 'paged');

  function choose(next: ReaderViewMode) {
    if (onchange) onchange(next);
    else preferences.setReaderViewMode(next);
  }
</script>

<div class="mode-toggle" role="group" aria-label="Reading mode">
  <button
    class="mode-btn"
    class:active={!paged}
    aria-pressed={!paged}
    onclick={() => choose('scroll')}
  >
    <Icon name="align-justify" size={16} />
    <span>Scroll</span>
  </button>
  <button
    class="mode-btn"
    class:active={paged}
    aria-pressed={paged}
    onclick={() => choose('paged')}
  >
    <Icon name="book-open" size={16} />
    <span>Pages</span>
  </button>
</div>

<style>
  .mode-toggle {
    display: flex;
    overflow: hidden;
    border: 1px solid var(--color-border);
    border-radius: 10px;
  }

  .mode-btn {
    display: flex;
    flex: 1 1 0;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    min-height: 44px;
    padding: 0.5rem 0.75rem;
    border: 0;
    background: none;
    color: var(--color-text-secondary);
    cursor: pointer;
    font-size: var(--text-lg);
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }

  .mode-btn + .mode-btn {
    border-left: 1px solid var(--color-border);
  }

  /* Selection by tint, not by a heavy fill. */
  .mode-btn.active {
    background: var(--color-sidebar-active);
    color: var(--color-primary);
    font-weight: var(--weight-medium);
  }

  @media (prefers-reduced-motion: reduce) {
    .mode-btn {
      transition: none;
    }
  }
</style>
