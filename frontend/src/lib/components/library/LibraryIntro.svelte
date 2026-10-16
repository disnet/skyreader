<script lang="ts">
  // The top of the Library: the Queue | Shelf switch and one line on what the
  // half you're in is for. Queue (`/saved`) and Shelf (`/shelf`) are two ways of
  // reading the same saves, not two piles (docs/plans/SHELF_PLAN.md), and this is
  // the one place that says so. It sits in the page body rather than the desktop
  // header so it shows on a phone too, where the header gives way to the bottom bar.
  import { SAVED_PATH, SHELF_PATH } from '$lib/utils/viewNav';

  interface Props {
    mode: 'queue' | 'shelf';
  }

  let { mode }: Props = $props();
</script>

<div class="library-intro">
  <nav class="library-switch" aria-label="Library">
    <a
      href={SAVED_PATH}
      class:active={mode === 'queue'}
      aria-current={mode === 'queue' ? 'page' : undefined}>Queue</a
    >
    <a
      href={SHELF_PATH}
      class:active={mode === 'shelf'}
      aria-current={mode === 'shelf' ? 'page' : undefined}>Shelf</a
    >
  </nav>
  <p class="library-desc">
    {#if mode === 'queue'}
      To read next. Archive what you're done with; anything on your Shelf stays there.
    {:else}
      What you keep and come back to. Books and PDFs land here; keep anything else from its ⋯ menu.
    {/if}
  </p>
</div>

<style>
  .library-intro {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.875rem;
    padding: 0.5rem 0 0.75rem;
  }

  .library-switch {
    display: flex;
    flex-shrink: 0;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-bg-secondary);
  }

  .library-switch a {
    padding: 0.3125rem 1rem;
    border: 1px solid transparent;
    border-radius: 6px;
    color: var(--color-text-secondary);
    font-size: var(--text-md);
    font-weight: 500;
    text-decoration: none;
  }

  .library-switch a:hover {
    color: var(--color-text);
  }

  .library-switch a.active {
    border-color: var(--color-border);
    background: var(--color-bg);
    color: var(--color-text);
  }

  .library-switch a:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  .library-desc {
    flex: 1 1 16rem;
    margin: 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }
</style>
