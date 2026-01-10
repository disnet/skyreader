<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { socialStore } from '$lib/stores/social.svelte';

  let activeTab = $state<'following' | 'popular'>('following');

  onMount(async () => {
    if (!auth.isAuthenticated) {
      goto('/auth/login?returnUrl=/social');
      return;
    }
    await socialStore.loadFeed(true);
  });

  async function loadMore() {
    await socialStore.loadFeed(false);
  }

  async function syncFollows() {
    const count = await socialStore.syncFollows();
    if (count > 0) {
      alert(`Synced ${count} follows`);
    }
  }

  function switchTab(tab: 'following' | 'popular') {
    activeTab = tab;
    if (tab === 'popular') {
      socialStore.loadPopular('week');
    } else {
      socialStore.loadFeed(true);
    }
  }

  function formatDate(dateString: string): string {
    const date = new Date(dateString);
    return date.toLocaleDateString();
  }
</script>

<div class="social-page">
  <div class="page-header">
    <h1>Social Feed</h1>
    <button class="btn btn-secondary" onclick={syncFollows}>
      Sync Follows
    </button>
  </div>

  <div class="tabs">
    <button
      class="tab"
      class:active={activeTab === 'following'}
      onclick={() => switchTab('following')}
    >
      Following
    </button>
    <button
      class="tab"
      class:active={activeTab === 'popular'}
      onclick={() => switchTab('popular')}
    >
      Popular
    </button>
  </div>

  {#if socialStore.error}
    <p class="error">{socialStore.error}</p>
  {/if}

  {#if socialStore.isLoading && (activeTab === 'following' ? socialStore.shares : socialStore.popularShares).length === 0}
    <div class="loading-state">Loading shares...</div>
  {:else}
    <div class="shares-list">
      {#each activeTab === 'following' ? socialStore.shares : socialStore.popularShares as share (share.recordUri)}
        <article class="share-card card">
          <div class="share-header">
            {#if share.authorAvatar}
              <img src={share.authorAvatar} alt="" class="author-avatar" />
            {:else}
              <div class="author-avatar placeholder"></div>
            {/if}
            <div class="author-info">
              <span class="author-name">{share.authorDisplayName || share.authorHandle}</span>
              <span class="author-handle">@{share.authorHandle}</span>
            </div>
            <span class="share-date">{formatDate(share.createdAt)}</span>
          </div>

          {#if share.note}
            <p class="share-note">{share.note}</p>
          {/if}

          <a href={share.itemUrl} target="_blank" rel="noopener" class="shared-article">
            {#if share.itemImage}
              <img src={share.itemImage} alt="" class="article-image" />
            {/if}
            <div class="article-info">
              <h3>{share.itemTitle || share.itemUrl}</h3>
              {#if share.itemDescription}
                <p>{share.itemDescription.slice(0, 150)}{share.itemDescription.length > 150 ? '...' : ''}</p>
              {/if}
            </div>
          </a>
        </article>
      {:else}
        <div class="empty-state">
          <h2>No shares yet</h2>
          <p>Shares from people you follow will appear here</p>
        </div>
      {/each}

      {#if activeTab === 'following' && socialStore.hasMore && !socialStore.isLoading}
        <button class="btn btn-secondary load-more" onclick={loadMore}>
          Load More
        </button>
      {/if}

      {#if socialStore.isLoading && (activeTab === 'following' ? socialStore.shares : socialStore.popularShares).length > 0}
        <div class="loading-state">Loading more...</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .social-page {
    max-width: 800px;
    margin: 0 auto;
  }

  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  .tabs {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
    border-bottom: 1px solid var(--color-border);
  }

  .tab {
    background: none;
    border: none;
    padding: 0.75rem 1rem;
    color: var(--color-text-secondary);
    font-weight: 500;
    position: relative;
  }

  .tab.active {
    color: var(--color-primary);
  }

  .tab.active::after {
    content: '';
    position: absolute;
    bottom: -1px;
    left: 0;
    right: 0;
    height: 2px;
    background: var(--color-primary);
  }

  .share-card {
    margin-bottom: 1rem;
  }

  .share-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
  }

  .author-avatar {
    width: 40px;
    height: 40px;
    border-radius: 50%;
  }

  .author-avatar.placeholder {
    background: var(--color-bg-secondary);
  }

  .author-info {
    flex: 1;
  }

  .author-name {
    display: block;
    font-weight: 600;
  }

  .author-handle {
    font-size: 0.875rem;
    color: var(--color-text-secondary);
  }

  .share-date {
    font-size: 0.875rem;
    color: var(--color-text-secondary);
  }

  .share-note {
    margin-bottom: 0.75rem;
  }

  .shared-article {
    display: flex;
    gap: 1rem;
    padding: 0.75rem;
    background: var(--color-bg-secondary);
    border-radius: 8px;
    text-decoration: none;
    color: inherit;
  }

  .shared-article:hover {
    background: var(--color-border);
  }

  .shared-article .article-image {
    width: 100px;
    height: 70px;
    object-fit: cover;
    border-radius: 4px;
    flex-shrink: 0;
  }

  .article-info h3 {
    font-size: 0.875rem;
    margin-bottom: 0.25rem;
  }

  .article-info p {
    font-size: 0.75rem;
    color: var(--color-text-secondary);
  }

  .load-more {
    width: 100%;
    margin-top: 1rem;
  }

  .loading-state {
    text-align: center;
    padding: 2rem;
    color: var(--color-text-secondary);
  }
</style>
