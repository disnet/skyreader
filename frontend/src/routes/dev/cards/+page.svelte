<script lang="ts">
  // Visual harness for ArticleCardView — renders each mock state with no auth and
  // no backend. Iterate on the card design here, then it flows to the real app
  // through the same component. Dev-only (see ../+layout.ts).
  import ArticleCardView from '$lib/components/ArticleCardView.svelte';
  import { fixtures } from './fixtures';

  // Constrain card width to exercise the @container / @media breakpoints
  // (520px / 300px container; 600px / 480px media).
  let width = $state(680);
</script>

<div class="harness">
  <header class="harness-bar">
    <h1>ArticleCardView</h1>
    <label class="width-control">
      Width: {width}px
      <input type="range" min="260" max="900" step="10" bind:value={width} />
    </label>
  </header>

  <div class="cards" style="--card-width: {width}px">
    {#each fixtures as fixture (fixture.name)}
      <section class="case">
        <div class="case-meta">
          <span class="case-name">{fixture.name}</span>
          <span class="case-note">{fixture.note}</span>
        </div>
        <div class="card-frame">
          <ArticleCardView {...fixture.props} />
        </div>
      </section>
    {/each}
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
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
    margin-bottom: 1.5rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--color-border, #e5e5e5);
  }

  .harness-bar h1 {
    font-size: 1.1rem;
    font-weight: 600;
    margin: 0;
  }

  .width-control {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.85rem;
    color: var(--color-text-secondary, #666);
  }

  .cards {
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }

  .case {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .case-meta {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .case-name {
    font-size: 0.8rem;
    font-weight: 600;
  }

  .case-note {
    font-size: 0.8rem;
    color: var(--color-text-secondary, #777);
  }

  /* Mimic the feed column: a fixed-width frame with the card's own 1rem padding. */
  .card-frame {
    width: var(--card-width);
    max-width: 100%;
    border: 1px dashed var(--color-border, #ddd);
    border-radius: 8px;
  }
</style>
