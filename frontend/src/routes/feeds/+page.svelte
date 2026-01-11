<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { api } from '$lib/services/api';

  let newFeedUrl = $state('');
  let isAdding = $state(false);
  let error = $state<string | null>(null);
  let discoveredFeeds = $state<string[]>([]);

  onMount(async () => {
    if (!auth.isAuthenticated) {
      goto('/auth/login?returnUrl=/feeds');
      return;
    }
    await subscriptionsStore.load();
  });

  async function discoverFeeds() {
    if (!newFeedUrl.trim()) return;

    error = null;
    isAdding = true;

    try {
      const result = await api.discoverFeeds(newFeedUrl.trim());
      if (result.feeds.length === 0) {
        error = 'No feeds found at this URL';
      } else if (result.feeds.length === 1) {
        await addFeed(result.feeds[0]);
      } else {
        discoveredFeeds = result.feeds;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to discover feeds';
    } finally {
      isAdding = false;
    }
  }

  async function addFeed(feedUrl: string) {
    error = null;
    isAdding = true;

    try {
      // Add subscription with URL as temporary title
      const tempTitle = new URL(feedUrl).hostname;
      const id = await subscriptionsStore.add(feedUrl, tempTitle, {});
      newFeedUrl = '';
      discoveredFeeds = [];
      isAdding = false;

      // Fetch feed in background (updates title and loads articles)
      subscriptionsStore.fetchFeed(id, true).then(async (feed) => {
        if (feed) {
          // Update subscription with actual title and siteUrl
          await subscriptionsStore.update(id, {
            title: feed.title,
            siteUrl: feed.siteUrl,
          });
        }
      });
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to add feed';
      isAdding = false;
    }
  }

  async function removeFeed(id: number) {
    if (confirm('Are you sure you want to remove this subscription?')) {
      await subscriptionsStore.remove(id);
    }
  }
</script>

<div class="feeds-page">
  <h1>Subscriptions</h1>

  <div class="add-feed card">
    <h2>Add New Feed</h2>
    <form onsubmit={(e) => { e.preventDefault(); discoverFeeds(); }}>
      <div class="input-group">
        <input
          type="url"
          class="input"
          placeholder="https://example.com or feed URL"
          bind:value={newFeedUrl}
          disabled={isAdding}
        />
        <button type="submit" class="btn btn-primary" disabled={isAdding || !newFeedUrl.trim()}>
          {isAdding ? 'Adding...' : 'Add'}
        </button>
      </div>
    </form>

    {#if error}
      <p class="error">{error}</p>
    {/if}

    {#if discoveredFeeds.length > 1}
      <div class="discovered-feeds">
        <p>Found multiple feeds. Select one:</p>
        {#each discoveredFeeds as feedUrl}
          <button class="btn btn-secondary feed-option" onclick={() => addFeed(feedUrl)}>
            {feedUrl}
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <div class="subscriptions-list">
    {#if subscriptionsStore.isLoading}
      <p class="loading-state">Loading subscriptions...</p>
    {:else if subscriptionsStore.subscriptions.length === 0}
      <div class="empty-state">
        <h2>No subscriptions yet</h2>
        <p>Add your first RSS feed above</p>
      </div>
    {:else}
      {#each subscriptionsStore.subscriptions as sub (sub.id)}
        {@const loadingState = subscriptionsStore.feedLoadingStates.get(sub.id!)}
        {@const feedError = subscriptionsStore.feedErrors.get(sub.id!)}
        <div class="subscription-card card" class:has-error={loadingState === 'error'}>
          <div class="sub-info">
            <h3>{sub.title}</h3>
            <p class="feed-url">{sub.feedUrl}</p>
            {#if loadingState === 'loading'}
              <span class="loading-status">Loading...</span>
            {:else if loadingState === 'error'}
              <span class="error-status" title={feedError}>Error: {feedError}</span>
            {:else if sub.category}
              <span class="category">{sub.category}</span>
            {/if}
            {#if sub.syncStatus === 'pending'}
              <span class="sync-status">Pending sync</span>
            {/if}
          </div>
          <div class="sub-actions">
            <button
              class="btn btn-secondary"
              onclick={() => sub.id && subscriptionsStore.fetchFeed(sub.id, true)}
              disabled={loadingState === 'loading'}
            >
              {loadingState === 'loading' ? 'Loading...' : 'Refresh'}
            </button>
            <button
              class="btn btn-danger"
              onclick={() => sub.id && removeFeed(sub.id)}
            >
              Remove
            </button>
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .feeds-page {
    max-width: 800px;
    margin: 0 auto;
  }

  .feeds-page h1 {
    margin-bottom: 1.5rem;
  }

  .add-feed {
    margin-bottom: 2rem;
  }

  .add-feed h2 {
    font-size: 1.125rem;
    margin-bottom: 1rem;
  }

  .input-group {
    display: flex;
    gap: 0.5rem;
  }

  .input-group input {
    flex: 1;
  }

  .discovered-feeds {
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid var(--color-border);
  }

  .discovered-feeds p {
    margin-bottom: 0.5rem;
    color: var(--color-text-secondary);
  }

  .feed-option {
    display: block;
    width: 100%;
    text-align: left;
    margin-top: 0.5rem;
    font-size: 0.875rem;
    word-break: break-all;
  }

  .subscription-card {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .sub-info h3 {
    font-size: 1rem;
    margin-bottom: 0.25rem;
  }

  .feed-url {
    font-size: 0.75rem;
    color: var(--color-text-secondary);
    word-break: break-all;
  }

  .category {
    display: inline-block;
    margin-top: 0.5rem;
    padding: 0.125rem 0.5rem;
    background: var(--color-bg-secondary);
    border-radius: 4px;
    font-size: 0.75rem;
  }

  .sync-status {
    display: inline-block;
    margin-top: 0.5rem;
    margin-left: 0.5rem;
    padding: 0.125rem 0.5rem;
    background: var(--color-warning);
    color: white;
    border-radius: 4px;
    font-size: 0.75rem;
  }

  .loading-status {
    display: inline-block;
    margin-top: 0.5rem;
    padding: 0.125rem 0.5rem;
    background: var(--color-primary);
    color: white;
    border-radius: 4px;
    font-size: 0.75rem;
  }

  .error-status {
    display: inline-block;
    margin-top: 0.5rem;
    padding: 0.125rem 0.5rem;
    background: var(--color-error);
    color: white;
    border-radius: 4px;
    font-size: 0.75rem;
  }

  .subscription-card.has-error {
    border-color: var(--color-error);
  }

  .sub-actions {
    display: flex;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .loading-state {
    text-align: center;
    padding: 2rem;
    color: var(--color-text-secondary);
  }

  @media (max-width: 600px) {
    .subscription-card {
      flex-direction: column;
    }

    .sub-actions {
      width: 100%;
    }

    .sub-actions button {
      flex: 1;
    }
  }
</style>
