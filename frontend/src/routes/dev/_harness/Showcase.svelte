<script lang="ts">
  // Shared page chrome for every /dev/<slug>/ harness. Renders a sticky title bar
  // (with a back-link to the /dev index and an optional controls slot) above a
  // single column of cases. Pair with Case.svelte for the per-component frames.
  //
  // Dev-only — the whole /dev/* tree 404s in production (see ../+layout.ts).
  import type { Snippet } from 'svelte';

  let {
    title,
    description,
    controls,
    children,
  }: {
    title: string;
    /** Optional hint line under the title (spans the full bar). */
    description?: string;
    /** Optional control widgets (sliders, toggles) rendered in the bar. */
    controls?: Snippet;
    children: Snippet;
  } = $props();
</script>

<div class="harness">
  <header class="harness-bar">
    <div class="title-row">
      <a class="back" href="/dev">← Harnesses</a>
      <h1>{title}</h1>
    </div>
    {#if controls}
      <div class="controls">
        {@render controls()}
      </div>
    {/if}
    {#if description}
      <p class="hint">{description}</p>
    {/if}
  </header>

  <div class="cases">
    {@render children()}
  </div>
</div>

<style>
  .harness {
    min-height: 100vh;
    background: var(--color-bg, #fff);
    color: var(--color-text, #111);
    padding: 1.5rem;
  }

  .harness-bar {
    position: sticky;
    top: 0;
    z-index: 10;
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: baseline;
    gap: 0.5rem 1.5rem;
    margin: -1.5rem -1.5rem 1.5rem;
    padding: 1rem 1.5rem;
    background: var(--color-bg, #fff);
    border-bottom: 1px solid var(--color-border, #e5e5e5);
  }

  .title-row {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
  }

  .back {
    font-size: var(--text-sm);
    color: var(--color-text-secondary, #777);
    text-decoration: none;
  }

  .back:hover {
    color: var(--color-primary, #0066cc);
  }

  .harness-bar h1 {
    font-size: var(--text-xl);
    font-weight: var(--weight-semibold);
    margin: 0;
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 1.5rem;
    flex-wrap: wrap;
  }

  .hint {
    grid-column: 1 / -1;
    margin: 0;
    max-width: 70ch;
    font-size: var(--text-sm);
    color: var(--color-text-secondary, #777);
  }

  .cases {
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }
</style>
