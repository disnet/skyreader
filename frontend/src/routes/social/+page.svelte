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

  function getFaviconUrl(url: string): string {
    try {
      const domain = new URL(url).hostname;
      return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
    } catch {
      return '';
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
          <div class="share-item">
            <div class="share-attribution">
              shared by <a href="/?sharer={share.authorDid}" class="share-author-link">@{share.authorHandle}</a>
            </div>
            <div class="share-header">
              <img src={getFaviconUrl(share.itemUrl)} alt="" class="favicon" />
              <a href={share.itemUrl} target="_blank" rel="noopener" class="share-title-link">
                {share.itemTitle || share.itemUrl}
              </a>
              <span class="share-date">{formatRelativeDate(share.createdAt)}</span>
            </div>
            <div class="share-content">
              <div class="share-actions">
                <a href={share.itemUrl} target="_blank" rel="noopener" class="action-btn">
                  ↗ Open
                </a>
              </div>
              {#if share.note}
                <blockquote class="share-note">{share.note}</blockquote>
              {/if}
            </div>
          </div>
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

  .shares-list {
    display: flex;
    flex-direction: column;
  }

  .share-item {
    border-bottom: 1px solid var(--color-border);
    transition: background-color 0.15s ease;
  }

  .share-item:last-child {
    border-bottom: none;
  }

  .share-item:hover {
    background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.03));
  }

  .share-attribution {
    font-size: 0.75rem;
    color: var(--color-text-secondary);
    padding: 0.5rem 0.5rem 0;
  }

  .share-author-link {
    color: var(--color-text-secondary);
    text-decoration: none;
  }

  .share-author-link:hover {
    color: var(--color-primary);
    text-decoration: underline;
  }

  .share-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.5rem 0.5rem 0.75rem;
    text-decoration: none;
    color: inherit;
  }

  .favicon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }

  .share-title-link {
    flex: 1;
    font-weight: 500;
    color: var(--color-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-decoration: none;
  }

  .share-title-link:hover {
    text-decoration: underline;
  }

  .share-date {
    flex-shrink: 0;
    font-size: 0.875rem;
    color: var(--color-text-secondary);
  }

  .share-content {
    padding: 0 0.5rem 0.75rem;
  }

  .share-actions {
    display: flex;
    gap: 1rem;
    margin-bottom: 0.75rem;
  }

  .action-btn {
    background: none;
    border: none;
    font-size: 0.875rem;
    color: var(--color-text-secondary);
    padding: 0;
    cursor: pointer;
    text-decoration: none;
  }

  .action-btn:hover {
    color: var(--color-primary);
  }

  .share-note {
    border-left: 3px solid var(--color-primary);
    margin: 0 0.5rem 0.75rem;
    padding-left: 1rem;
    font-style: italic;
    color: var(--color-text);
  }

  @media (prefers-color-scheme: dark) {
    .share-item:hover {
      background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
    }
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
