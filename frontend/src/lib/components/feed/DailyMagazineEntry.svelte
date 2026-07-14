<script lang="ts">
  import type { SavedItem } from '$lib/types';
  import type { DailyMagazineIssue } from '$lib/utils/dailyMagazine';
  import { formatMagazineDate, magazineIssueSummary } from '$lib/utils/dailyMagazine';
  import {
    DAILY_MAGAZINE_MINUTE_OPTIONS,
    DAILY_MAGAZINE_ORDER_OPTIONS,
    preferences,
    type DailyMagazineMinutes,
    type DailyMagazineOrder,
  } from '$lib/stores/preferences.svelte';
  import Icon from '$lib/components/Icon.svelte';

  interface Props {
    date: Date;
    issue: DailyMagazineIssue<SavedItem>;
  }

  let { date, issue }: Props = $props();

  function updateLength(event: Event) {
    const minutes = Number((event.currentTarget as HTMLSelectElement).value);
    preferences.setDailyMagazineMinutes(minutes as DailyMagazineMinutes);
  }

  function updateOrder(event: Event) {
    const order = (event.currentTarget as HTMLSelectElement).value as DailyMagazineOrder;
    preferences.setDailyMagazineOrder(order);
  }
</script>

<section class="magazine-entry" aria-labelledby="daily-magazine-title">
  <div class="entry-copy">
    <p class="entry-kicker">Daily magazine · {formatMagazineDate(date)}</p>
    <h2 id="daily-magazine-title">Today’s issue from your saved articles</h2>
  </div>

  <div class="controls">
    <label class="control">
      <span>Length</span>
      <select value={preferences.dailyMagazineMinutes} onchange={updateLength}>
        {#each DAILY_MAGAZINE_MINUTE_OPTIONS as minutes}
          <option value={minutes}>{minutes} min</option>
        {/each}
      </select>
    </label>
    <label class="control">
      <span>Articles</span>
      <select value={preferences.dailyMagazineOrder} onchange={updateOrder}>
        {#each DAILY_MAGAZINE_ORDER_OPTIONS as option}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
    </label>
  </div>

  <div class="entry-footer">
    {#if issue.items.length > 0}
      <p class="summary">{magazineIssueSummary(issue.items.length, issue.totalMinutes)}</p>
    {:else}
      <p class="summary">Save an article or choose a longer issue to get started.</p>
    {/if}
    <a class="open-link" href="/daily">
      <span>{issue.items.length > 0 ? 'Open today’s magazine' : 'Set up your magazine'}</span>
      <Icon name="arrow-right" size={15} />
    </a>
  </div>
</section>

<style>
  .magazine-entry {
    display: grid;
    gap: 0.75rem;
    padding: 1.25rem 0.25rem;
    border-block: 1px solid var(--color-border);
    margin-bottom: 2rem;
  }

  .entry-copy {
    display: grid;
    gap: 0.2rem;
    min-width: 0;
  }

  .entry-kicker {
    margin: 0;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }

  h2 {
    margin: 0;
    color: var(--color-text);
    font-size: 1.125rem;
    font-weight: var(--weight-semibold);
    line-height: var(--leading-tight);
    letter-spacing: var(--tracking-tight);
  }

  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
  }

  .control {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
  }

  .control select {
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    cursor: pointer;
  }

  .control select:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  .entry-footer {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
  }

  .summary {
    margin: 0;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }

  .open-link {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    flex: 0 0 auto;
    color: var(--color-primary);
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    text-decoration: none;
    border-radius: 4px;
  }

  .open-link:hover {
    text-decoration: underline;
  }

  .open-link:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 3px;
  }

  @media (max-width: 560px) {
    .magazine-entry {
      gap: 0.625rem;
      padding-block: 1rem;
      margin-bottom: 1.5rem;
    }

    .entry-footer {
      flex-direction: column;
      align-items: flex-start;
      gap: 0.625rem;
    }
  }
</style>
