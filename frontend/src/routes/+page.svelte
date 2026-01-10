<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { readingStore } from '$lib/stores/reading.svelte';
  import ArticleCard from '$lib/components/ArticleCard.svelte';
  import type { Article } from '$lib/types';

  let articles = $state<Article[]>([]);
  let isLoading = $state(true);
  let selectedIndex = $state(-1);
  let expandedIndex = $state(-1);
  let articleElements: HTMLElement[] = [];

  onMount(async () => {
    if (auth.isAuthenticated) {
      await subscriptionsStore.load();
      await readingStore.load();
      articles = await subscriptionsStore.getAllArticles();
    }
    isLoading = false;
  });

  // Refresh feeds
  async function refreshFeeds() {
    isLoading = true;
    for (const sub of subscriptionsStore.subscriptions) {
      if (sub.id) {
        await subscriptionsStore.fetchFeed(sub.id, true);
      }
    }
    articles = await subscriptionsStore.getAllArticles();
    isLoading = false;
    selectedIndex = -1;
    expandedIndex = -1;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!auth.isAuthenticated || articles.length === 0) return;

    // Ignore if user is typing in an input
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      selectArticle(Math.min(selectedIndex + 1, articles.length - 1));
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      selectArticle(Math.max(selectedIndex - 1, 0));
    }
  }

  async function selectArticle(index: number) {
    if (index === selectedIndex) return;

    // Mark as read when selecting
    const article = articles[index];
    const sub = subscriptionsStore.subscriptions.find(s => s.id === article.subscriptionId);
    if (sub && !readingStore.isRead(article.guid)) {
      readingStore.markAsRead(sub.atUri, article.guid, article.url, article.title);
    }

    selectedIndex = index;
    expandedIndex = -1; // Reset expanded when selecting new article

    await tick(); // Wait for DOM to update
    scrollToCenter();
  }

  function scrollToCenter() {
    const el = articleElements[selectedIndex];
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const elementCenter = rect.top + rect.height / 2;
    const viewportCenter = window.innerHeight / 2;
    const offset = elementCenter - viewportCenter;

    // Use instant scroll to avoid jitter
    window.scrollBy({ top: offset, behavior: 'instant' });
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if !auth.isAuthenticated}
  <div class="welcome">
    <h1>Welcome to AT-RSS</h1>
    <p>A decentralized RSS reader built on the AT Protocol.</p>
    <ul class="features">
      <li>Store your subscriptions in your own data server</li>
      <li>See what articles people you follow are sharing</li>
      <li>Works offline with automatic sync</li>
    </ul>
    <a href="/auth/login" class="btn btn-primary">Login with Bluesky</a>
  </div>
{:else}
  <div class="feed-page">
    <div class="feed-header">
      <h1>Your Feed</h1>
      <button class="btn btn-secondary" onclick={refreshFeeds} disabled={isLoading}>
        {isLoading ? 'Refreshing...' : 'Refresh'}
      </button>
    </div>

    {#if isLoading && articles.length === 0}
      <div class="loading-state">Loading articles...</div>
    {:else if articles.length === 0}
      <div class="empty-state">
        <h2>No articles yet</h2>
        <p>Add some subscriptions to get started</p>
        <a href="/feeds" class="btn btn-primary">Manage Subscriptions</a>
      </div>
    {:else}
      <div class="article-list">
        {#each articles as article, index (article.guid)}
          {@const sub = subscriptionsStore.subscriptions.find(s => s.id === article.subscriptionId)}
          <div bind:this={articleElements[index]}>
            <ArticleCard
              {article}
              siteUrl={sub?.siteUrl}
              isRead={readingStore.isRead(article.guid)}
              isStarred={readingStore.isStarred(article.guid)}
              selected={selectedIndex === index}
              expanded={expandedIndex === index}
              onRead={() => {
                if (sub) {
                  readingStore.markAsRead(sub.atUri, article.guid, article.url, article.title);
                }
              }}
              onToggleStar={() => readingStore.toggleStar(article.guid)}
              onSelect={() => {
                if (selectedIndex === index) {
                  selectedIndex = -1;
                  expandedIndex = -1;
                } else {
                  selectArticle(index);
                }
              }}
              onExpand={async () => {
                expandedIndex = index;
                await tick();
                scrollToCenter();
              }}
            />
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .welcome {
    max-width: 600px;
    margin: 4rem auto;
    text-align: center;
  }

  .welcome h1 {
    font-size: 2.5rem;
    margin-bottom: 1rem;
  }

  .welcome p {
    font-size: 1.25rem;
    color: var(--color-text-secondary);
    margin-bottom: 2rem;
  }

  .features {
    list-style: none;
    margin-bottom: 2rem;
    text-align: left;
    display: inline-block;
  }

  .features li {
    padding: 0.5rem 0;
    padding-left: 1.5rem;
    position: relative;
  }

  .features li::before {
    content: '✓';
    position: absolute;
    left: 0;
    color: var(--color-success);
  }

  .feed-page {
    max-width: 800px;
    margin: 0 auto;
  }

  .feed-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
  }

  .feed-header h1 {
    font-size: 1.5rem;
  }

  .article-list {
    display: flex;
    flex-direction: column;
  }

  .article-list > div {
    border-bottom: 1px solid var(--color-border);
  }

  .article-list > div:last-child {
    border-bottom: none;
  }

  .loading-state {
    text-align: center;
    padding: 3rem;
    color: var(--color-text-secondary);
  }
</style>
