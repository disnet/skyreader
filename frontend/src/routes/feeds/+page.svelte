<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import FeedDiscoveryForm from '$lib/components/FeedDiscoveryForm.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import LoadingState from '$lib/components/LoadingState.svelte';

  onMount(async () => {
    if (!auth.isAuthenticated) {
      goto('/auth/login?returnUrl=/feeds');
      return;
    }
    await subscriptionsStore.load();
  });

  async function handleFeedSelected(feedUrl: string) {
    // Add subscription with URL as temporary title
    const tempTitle = new URL(feedUrl).hostname;
    const id = await subscriptionsStore.add(feedUrl, tempTitle, {});

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
    <FeedDiscoveryForm onFeedSelected={handleFeedSelected} />
  </div>

  <div class="subscriptions-list">
    {#if subscriptionsStore.isLoading}
      <LoadingState message="Loading subscriptions..." />
    {:else if subscriptionsStore.subscriptions.length === 0}
      <EmptyState
        title="No subscriptions yet"
        description="Add your first RSS feed above"
      />
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
