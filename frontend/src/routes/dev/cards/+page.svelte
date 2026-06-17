<script lang="ts">
  // Visual harness for ArticleCardView — renders each mock state with no auth and
  // no backend. Iterate on the card design here, then it flows to the real app
  // through the same component. Dev-only (see ../+layout.ts).
  //
  // The card scrolls on the window (like the real feed), so the sticky action
  // bar's depth shadow is exercised for real: scroll the page and watch the
  // 'Expanded · long body' card's bar pin and settle. The overlapShadow action
  // lives in the view, so no container is needed to drive it.
  import ArticleCardView from '$lib/components/ArticleCardView.svelte';
  import CollectionMagazine from '$lib/components/feed/CollectionMagazine.svelte';
  import Showcase from '../_harness/Showcase.svelte';
  import Case from '../_harness/Case.svelte';
  import { fixtures } from './fixtures';

  // Constrain card width to exercise the @container / @media breakpoints
  // (520px / 300px container; 600px / 480px media).
  let width = $state(680);

  // The curated edition's collection, reused to preview the themed magazine view
  // (the reader's optional layout, which isn't an ArticleCardView state).
  const editionCollection = fixtures.find((f) => f.name === 'Edition · open')?.props.collection;
</script>

<Showcase
  title="ArticleCardView"
  description="Scroll the page to pin the long card's action bar. Narrow the window below 1000px to test the mobile floating-bar behavior."
>
  {#snippet controls()}
    <label class="control">
      Width: {width}px
      <input type="range" min="260" max="900" step="10" bind:value={width} />
    </label>
  {/snippet}

  {#each fixtures as fixture (fixture.name)}
    <Case name={fixture.name} note={fixture.note} width="{width}px">
      <ArticleCardView {...fixture.props} />
    </Case>
  {/each}

  {#if editionCollection}
    <Case
      name="Magazine view"
      note="The themed magazine layout for a curated edition (the only reader layout for editions): accent rule, publication name, display title, the 'In this issue' TOC, then each piece inlined with its commentary as a blockquote — painted in the publication's palette + fonts. Article bodies fetch from the API, so they show as 'loading'/'couldn't load' in this backend-less harness."
      width="{width}px"
    >
      <CollectionMagazine
        collection={editionCollection}
        title="Inflection points"
        onSavePiece={() => {}}
        isPieceSaved={(item) => item.document.endsWith('two')}
      />
    </Case>
  {/if}
</Showcase>

<style>
  .control {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: var(--text-md);
    color: var(--color-text-secondary, #666);
  }
</style>
