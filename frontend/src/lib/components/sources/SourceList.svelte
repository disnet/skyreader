<script lang="ts">
  import type { Snippet } from 'svelte';

  // The one container every group of rows sits in: a hairline-bordered card
  // with dividers between rows. Flat by default (no shadow; nothing overlaps).
  interface Props {
    label?: string | null;
    icon?: Snippet;
    count?: number | null;
    children: Snippet;
  }

  let { label = null, icon, count = null, children }: Props = $props();
</script>

<div class="group">
  {#if label}
    <h3 class="group-label">
      {#if icon}{@render icon()}{/if}
      {label}
      {#if count != null}<span class="group-count">{count}</span>{/if}
    </h3>
  {/if}
  <div class="source-list">
    {@render children()}
  </div>
</div>

<style>
  .group + :global(.group) {
    margin-top: 1rem;
  }

  .group-label {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin: 0 0 0.375rem;
    padding: 0 0.25rem;
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    color: var(--color-text-secondary);
  }

  .group-count {
    font-weight: var(--weight-regular);
    font-variant-numeric: tabular-nums;
  }

  .source-list {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg, 8px);
    overflow: hidden;
    background: var(--color-bg);
  }

  .source-list > :global(* + *) {
    border-top: 1px solid var(--color-border);
  }
</style>
