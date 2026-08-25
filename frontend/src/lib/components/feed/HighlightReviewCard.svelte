<script lang="ts">
  // The Home entry into the review deck. In v1 the view IS the reminder — there
  // is no push/email stack — so this card is the thing that says "you have a few
  // highlights to revisit." It hides itself once the deck is done or empty:
  // calm, no streaks, no badges, nothing to clear.
  import Icon from '$lib/components/Icon.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import {
    HIGHLIGHT_REVIEW_COUNT_OPTIONS,
    preferences,
    type HighlightReviewCount,
  } from '$lib/stores/preferences.svelte';
  import { buildHighlightDeck } from '$lib/utils/highlightReview';

  let deck = $derived(
    buildHighlightDeck(itemLabelsStore.allHighlights, preferences.highlightReviewCount)
  );
  let count = $derived(deck.cards.length);

  function updateCount(event: Event) {
    const value = Number((event.currentTarget as HTMLSelectElement).value);
    preferences.setHighlightReviewCount(value as HighlightReviewCount);
  }
</script>

{#if deck.status === 'available' && count > 0}
  <section class="review-card" aria-label="Highlight review">
    <div class="text">
      <h2>
        <span class="icon"><Icon name="highlighter" size={16} /></span>
        Revisit your highlights
      </h2>
      <p>A few passages you've marked, one at a time.</p>
    </div>

    <div class="controls">
      <label class="control">
        <span>Deck</span>
        <select value={preferences.highlightReviewCount} onchange={updateCount}>
          {#each HIGHLIGHT_REVIEW_COUNT_OPTIONS as option}
            <option value={option}>{option}</option>
          {/each}
        </select>
      </label>
      <a class="start" href="/highlights/review">
        <span>Review {count} highlight{count === 1 ? '' : 's'}</span>
        <Icon name="arrow-right" size={15} />
      </a>
    </div>
  </section>
{/if}

<style>
  /* Flat by default: a bordered panel, not a floating card. */
  .review-card {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin: 0 0 1.5rem;
    padding: 1rem 1.25rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
  }

  .text h2 {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    line-height: var(--leading-tight);
  }

  .icon {
    display: inline-flex;
    color: var(--color-text-secondary);
  }

  .text p {
    margin: 0.25rem 0 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  /* Matches MagazineRail's `.control` so the two Home panels read as one
     control vocabulary. */
  .control {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .control select {
    min-height: 2rem;
    padding: 0.2rem 1.5rem 0.2rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-xs);
  }

  .start {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    min-height: 36px;
    padding: 0.35rem 0.9rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    color: var(--color-text);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    text-decoration: none;
    transition:
      color 0.15s ease,
      border-color 0.15s ease;
  }

  .start:hover {
    color: var(--color-primary);
    border-color: var(--color-primary);
  }

  @media (max-width: 640px) {
    .controls {
      width: 100%;
      justify-content: space-between;
    }
  }
</style>
