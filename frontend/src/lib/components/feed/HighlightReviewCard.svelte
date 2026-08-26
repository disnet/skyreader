<script lang="ts">
  // The Home entry into the review deck. In v1 the view IS the reminder — there is no push/email stack — so this card says
  // "you have a few highlights to revisit." It hides itself once the deck is
  // done or empty: calm, no streaks, nothing that lingers after you've read.
  import Icon from '$lib/components/Icon.svelte';
  import { highlightReviewStore } from '$lib/stores/highlightReview.svelte';
  import { articlesStore } from '$lib/stores/articles.svelte';
  import { socialStore } from '$lib/stores/social.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { describeHighlightSources } from '$lib/utils/highlightReview';
  import { buildHighlightSourceLookups, resolveHighlightSource } from '$lib/utils/highlightSource';

  let count = $derived(highlightReviewStore.dueCount);

  let sourceLookups = $derived(
    buildHighlightSourceLookups(
      articlesStore.allArticles,
      socialStore.documents,
      savesStore.articles,
      subscriptionsStore.subscriptions
    )
  );

  // Naming who's waiting is the pitch: a person is a better reason to open the
  // deck than a description of how it works. Bylines are often missing (RSS
  // rarely carries one, a Margin import never does), so each source falls back
  // to where it came from rather than dropping out of the sentence. Deduped in
  // deck order, so the first name is the first card dealt.
  let sources = $derived.by(() => {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const entry of highlightReviewStore.cards) {
      const source = resolveHighlightSource(
        entry.itemKey,
        entry.itemType,
        sourceLookups,
        entry.highlight
      );
      const name = source.author || source.domain || source.title;
      if (seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
    return describeHighlightSources(names);
  });
</script>

{#if highlightReviewStore.status === 'available' && count > 0}
  <section class="review-card" aria-label="Highlight review">
    <div class="text">
      <h2>
        <span class="icon"><Icon name="highlighter" size={16} /></span>
        Revisit your highlights
      </h2>
      <p>Highlights from {sources}.</p>
    </div>

    <a class="start" href="/highlights/review">
      <span>Review {count} highlight{count === 1 ? '' : 's'}</span>
      <Icon name="arrow-right" size={15} />
    </a>
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
    .start {
      width: 100%;
      justify-content: center;
    }
  }
</style>
