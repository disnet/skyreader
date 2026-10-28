<script lang="ts">
  // Highlight preferences: how big a review deck is, and whether Skyreader
  // syncs the reader's own Margin highlights (MarginSyncControl, which the top
  // of /highlights shares).
  import {
    HIGHLIGHT_REVIEW_COUNT_OPTIONS,
    preferences,
    type HighlightReviewCount,
  } from '$lib/stores/preferences.svelte';
  import MarginSyncControl from './MarginSyncControl.svelte';

  interface Props {
    returnUrl?: string;
    /** Fired when switching the sync on actually brought highlights in, so a
        host showing those highlights (the review deck) can react. */
    onImported?: (imported: number) => void;
    /**
     * Deck size only makes sense where the deck is: "5" means something when
     * you can see it. `/settings` renders the Margin toggle alone, because that
     * one has to be reachable *before* there's a deck to configure — a reader
     * with a Margin library and no Skyreader highlights has no Review entry in
     * the nav at all, so the deck's own gear can't be its only home.
     */
    showDeckSize?: boolean;
  }

  let { returnUrl = '/settings', onImported, showDeckSize = true }: Props = $props();
</script>

{#if showDeckSize}
  <div class="setting-row">
    <label for="review-count">Review deck</label>
    <select
      id="review-count"
      value={preferences.highlightReviewCount}
      onchange={(e) =>
        preferences.setHighlightReviewCount(Number(e.currentTarget.value) as HighlightReviewCount)}
    >
      {#each HIGHLIGHT_REVIEW_COUNT_OPTIONS as option}
        <option value={option}>{option} highlights</option>
      {/each}
    </select>
  </div>
  <p class="setting-description">How many highlights a review session brings back.</p>
{/if}

<div class="toggle-wrap" class:after-deck={showDeckSize}>
  <MarginSyncControl {returnUrl} {onImported} />
</div>

<style>
  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.5rem;
  }

  .setting-row label {
    font-weight: var(--weight-medium);
  }

  select {
    min-height: 2.25rem;
  }

  .toggle-wrap.after-deck {
    margin-top: 1rem;
  }

  .setting-description {
    margin: 0.5rem 0 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    line-height: var(--leading-relaxed, 1.5);
  }
</style>
