<script lang="ts">
  import type { SavedItem } from '$lib/types';
  import type { DailyMagazineIssue } from '$lib/utils/dailyMagazine';
  import { formatMagazineDate, magazineIssueSummary } from '$lib/utils/dailyMagazine';
  import { decodeEntities } from '$lib/utils/entities';
  import Icon from '$lib/components/Icon.svelte';

  interface Props {
    date: Date;
    issue: DailyMagazineIssue<SavedItem>;
  }

  let { date, issue }: Props = $props();
  let previewItems = $derived(issue.items.slice(0, 3));
</script>

<section class="magazine-entry" aria-labelledby="daily-magazine-title">
  <div class="entry-heading">
    <div class="entry-copy">
      <p class="entry-kicker">Daily magazine · {formatMagazineDate(date)}</p>
      <h2 id="daily-magazine-title">Today’s issue from your saved articles</h2>
    </div>
    <span class="target">{issue.targetMinutes} min target</span>
  </div>

  <p class="summary">{magazineIssueSummary(issue.items.length, issue.totalMinutes)}</p>
  {#if issue.items.length > 0}
    <ol class="preview" aria-label="Today’s articles">
      {#each previewItems as entry}
        <li>{decodeEntities(entry.item.title || '') || entry.item.url}</li>
      {/each}
    </ol>
  {:else}
    <p class="empty-copy">Save an article or choose a longer issue to get started.</p>
  {/if}

  <a class="open-link" href="/daily">
    <span>{issue.items.length > 0 ? 'Open today’s magazine' : 'Set up your magazine'}</span>
    <Icon name="arrow-right" size={15} />
  </a>
</section>

<style>
  .magazine-entry {
    display: grid;
    gap: 0.75rem;
    padding: 1.25rem 0.25rem;
    border-block: 1px solid var(--color-border);
    margin-bottom: 2rem;
  }

  .entry-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }

  .entry-copy {
    display: grid;
    gap: 0.2rem;
    min-width: 0;
  }

  .entry-kicker,
  .summary,
  .empty-copy {
    margin: 0;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }

  .entry-kicker {
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

  .target {
    flex: 0 0 auto;
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    white-space: nowrap;
  }

  .preview {
    display: grid;
    gap: 0.4rem;
    margin: 0;
    padding-left: 1.3rem;
    color: var(--color-text);
    font-size: var(--text-md);
  }

  .preview li {
    padding-left: 0.2rem;
    line-height: var(--leading-snug);
  }

  .open-link {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    width: fit-content;
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

    .entry-heading {
      display: grid;
      gap: 0.625rem;
    }

    .target {
      width: fit-content;
    }
  }
</style>
