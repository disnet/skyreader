<script lang="ts">
  import type { Snippet } from 'svelte';

  // One heading style for every section on the Sources page — the reader's own
  // sources and the suggestions under them alike — so the page reads as one list
  // of lists rather than a stack of differently-styled panels.
  interface Props {
    title: string;
    count?: number | null;
    /** Right-aligned controls (e.g. Select all). */
    children?: Snippet;
  }

  let { title, count = null, children }: Props = $props();
</script>

<div class="section-header">
  <h2 class="section-title">
    {title}
    {#if count != null}<span class="section-count">{count}</span>{/if}
  </h2>
  {#if children}
    <div class="section-trailing">{@render children()}</div>
  {/if}
</div>

<style>
  .section-header {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    padding: 0 0.25rem;
    margin: 0 0 0.5rem;
  }

  .section-title {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    margin: 0;
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-tight);
    color: var(--color-text);
  }

  .section-count {
    font-size: var(--text-sm);
    font-weight: var(--weight-regular);
    color: var(--color-text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .section-trailing {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }
</style>
