<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { socialStore } from '$lib/stores/social.svelte';
  import { formatRelativeDate } from '$lib/utils/date';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import LoadingState from '$lib/components/LoadingState.svelte';

  let activeTab = $state<'following' | 'shares'>('following');

  onMount(async () => {
    if (!auth.isAuthenticated) {
      goto('/auth/login?returnUrl=/social');
      return;
    }
    await socialStore.loadFollowedUsers();

    // Auto-sync if follows are empty (e.g., new user whose backend sync is still running)
    if (socialStore.followedUsers.length === 0 && !socialStore.isSyncing) {
      await socialStore.syncFollows();
    }
  });

  async function loadMore() {
    await socialStore.loadFeed(false);
  }

  async function syncFollows() {
    await socialStore.syncFollows();
  }

  function switchTab(tab: 'following' | 'shares') {
    activeTab = tab;
    if (tab === 'shares') {
      socialStore.loadFeed(true);
    } else {
      socialStore.loadFollowedUsers();
    }
  }
</script>

<div class="social-page">
  <div class="page-header">
    <h1>Social</h1>
    <button class="btn btn-secondary" onclick={syncFollows} disabled={socialStore.isSyncing}>
      {socialStore.isSyncing ? 'Syncing...' : 'Sync Follows'}
    </button>
  </div>

  <div class="tabs">
    <button
      class="tab"
      class:active={activeTab === 'following'}
      onclick={() => switchTab('following')}
    >
      Following
      {#if socialStore.followedUsers.length > 0}
        <span class="count">({socialStore.followedUsers.length})</span>
      {/if}
    </button>
    <button
      class="tab"
      class:active={activeTab === 'shares'}
      onclick={() => switchTab('shares')}
    >
      Shares
    </button>
  </div>

  {#if socialStore.error}
    <p class="error">{socialStore.error}</p>
  {/if}

  {#if activeTab === 'following'}
    {#if (socialStore.isLoading || socialStore.isSyncing) && socialStore.followedUsers.length === 0}
      <LoadingState message={socialStore.isSyncing ? 'Syncing follows from Bluesky...' : 'Loading followed users...'} />
    {:else if socialStore.followedUsers.length === 0}
      <EmptyState
        title="No follows yet"
        description="Click 'Sync Follows' to import your Bluesky follows"
      />
    {:else}
      <div class="users-list">
        {#each socialStore.followedUsers as user (user.did)}
          <div class="user-card card">
            {#if user.avatarUrl}
              <img src={user.avatarUrl} alt="" class="user-avatar" />
            {:else}
              <div class="user-avatar placeholder"></div>
            {/if}
            <div class="user-info">
              <span class="user-name">{user.displayName || user.handle}</span>
              <span class="user-handle">@{user.handle}</span>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {:else}
    {#if socialStore.isLoading && socialStore.shares.length === 0}
      <LoadingState message="Loading shares..." />
    {:else if socialStore.shares.length === 0}
      <EmptyState
        title="No shares yet"
        description="Shares from people you follow will appear here"
      />
    {:else}
      <div class="shares-list">
        {#each socialStore.shares as share (share.recordUri)}
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
              <span class="share-date">{formatRelativeDate(share.createdAt)}</span>
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
        {/each}

        {#if socialStore.hasMore && !socialStore.isLoading}
          <button class="btn btn-secondary load-more" onclick={loadMore}>
            Load More
          </button>
        {/if}

        {#if socialStore.isLoading && socialStore.shares.length > 0}
          <LoadingState message="Loading more..." />
        {/if}
      </div>
    {/if}
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
    cursor: pointer;
  }

  .tab:hover {
    color: var(--color-text);
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

  .tab .count {
    font-weight: normal;
    color: var(--color-text-secondary);
  }

  .users-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .user-card {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
  }

  .user-avatar {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .user-avatar.placeholder {
    background: var(--color-bg-secondary);
  }

  .user-info {
    flex: 1;
    min-width: 0;
  }

  .user-name {
    display: block;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .user-handle {
    font-size: 0.875rem;
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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

  .error {
    color: var(--color-error, #dc3545);
    padding: 1rem;
    background: var(--color-error-bg, #f8d7da);
    border-radius: 8px;
    margin-bottom: 1rem;
  }
</style>
