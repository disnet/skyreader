<script lang="ts">
  // Over the Queue filtered to one reading session (`/saved?from=<url>`): what
  // it's filtered to, the article itself, and the way back to everything.
  import { feedViewStore } from '$lib/stores/feedView.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { savedFromLabel, savesFrom } from '$lib/utils/savedFrom';
  import { SAVED_PATH } from '$lib/utils/viewNav';

  let url = $derived(feedViewStore.savedFromFilter);
  let saves = $derived(url ? savesFrom(savesStore.articles, url) : []);
  // The newest save's word for its article: a title arrives with each save.
  let label = $derived.by(() => {
    if (!url) return '';
    const named = saves.find((s) => s.savedFromTitle?.trim());
    return savedFromLabel(named ?? { savedFromUrl: url, savedFromTitle: null });
  });
</script>

{#if url}
  <div class="saved-from-banner">
    <p>
      Saved from <a href={url} target="_blank" rel="noopener noreferrer">{label}</a>
    </p>
    <a class="clear" href={SAVED_PATH}>Show everything</a>
  </div>
{/if}

<style>
  .saved-from-banner {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    margin: 0 1rem 0.75rem;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-bg-secondary);
    font-size: var(--text-md);
  }

  p {
    min-width: 0;
    margin: 0;
    overflow: hidden;
    color: var(--color-text-secondary);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  p a {
    color: var(--color-text);
    font-weight: var(--weight-medium);
    text-decoration: none;
  }

  p a:hover {
    text-decoration: underline;
  }

  .clear {
    flex-shrink: 0;
    color: var(--color-primary);
    text-decoration: none;
  }

  .clear:hover {
    text-decoration: underline;
  }
</style>
