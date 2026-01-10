<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { readingStore } from '$lib/stores/reading.svelte';
  import type { ReadPosition } from '$lib/types';

  let starredItems = $state<ReadPosition[]>([]);
  let isLoading = $state(true);

  onMount(async () => {
    if (!auth.isAuthenticated) {
      goto('/auth/login?returnUrl=/starred');
      return;
    }
    await readingStore.load();
    starredItems = await readingStore.getStarredArticles();
    isLoading = false;
  });

  function formatDate(dateString: string): string {
    const date = new Date(dateString);
    return date.toLocaleDateString();
  }
</script>

<div class="starred-page">
  <h1>Starred Articles</h1>

  {#if isLoading}
    <div class="loading-state">Loading starred articles...</div>
  {:else if starredItems.length === 0}
    <div class="empty-state">
      <h2>No starred articles</h2>
      <p>Star articles to save them for later</p>
    </div>
  {:else}
    <div class="starred-list">
      {#each starredItems as item (item.articleGuid)}
        <article class="starred-card card">
          <div class="card-content">
            <a href={item.articleUrl} target="_blank" rel="noopener" class="article-link">
              <h3>{item.articleTitle || item.articleUrl}</h3>
            </a>
            <p class="meta">Starred on {formatDate(item.readAt)}</p>
          </div>
          <button
            class="unstar-btn"
            onclick={() => readingStore.toggleStar(item.articleGuid)}
            title="Remove star"
          >
            ★
          </button>
        </article>
      {/each}
    </div>
  {/if}
</div>

<style>
  .starred-page {
    max-width: 800px;
    margin: 0 auto;
  }

  .starred-page h1 {
    margin-bottom: 1.5rem;
  }

  .starred-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .starred-card {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
  }

  .card-content {
    flex: 1;
    min-width: 0;
  }

  .article-link {
    text-decoration: none;
    color: inherit;
  }

  .article-link:hover h3 {
    color: var(--color-primary);
  }

  .article-link h3 {
    font-size: 1rem;
    margin-bottom: 0.25rem;
    word-break: break-word;
  }

  .meta {
    font-size: 0.75rem;
    color: var(--color-text-secondary);
  }

  .unstar-btn {
    background: none;
    border: none;
    font-size: 1.25rem;
    color: #ffc107;
    cursor: pointer;
    padding: 0.25rem;
  }

  .unstar-btn:hover {
    opacity: 0.7;
  }

  .loading-state {
    text-align: center;
    padding: 3rem;
    color: var(--color-text-secondary);
  }
</style>
