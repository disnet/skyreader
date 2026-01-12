<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { socialStore } from '$lib/stores/social.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import LoadingState from '$lib/components/LoadingState.svelte';

  let followingDids = $state<Set<string>>(new Set());

  onMount(async () => {
    if (!auth.isAuthenticated) {
      goto('/auth/login?returnUrl=/discover');
      return;
    }
    await Promise.all([
      socialStore.loadDiscoverUsers(),
      socialStore.loadFollowedUsers(),
    ]);
  });

  async function shuffle() {
    await socialStore.loadDiscoverUsers();
  }

  async function handleFollow(did: string) {
    followingDids.add(did);
    followingDids = new Set(followingDids);
    const success = await socialStore.followUser(did);
    if (!success) {
      followingDids.delete(did);
      followingDids = new Set(followingDids);
    }
  }

  function isFollowing(did: string): boolean {
    return followingDids.has(did) || socialStore.followedUsers.some(u => u.did === did);
  }
</script>

<div class="discover-page">
  <div class="page-header">
    <div class="header-content">
      <h1>Discover</h1>
      <p class="subtitle">Find active AT-RSS users to follow</p>
    </div>
    <button class="btn btn-secondary" onclick={shuffle} disabled={socialStore.isDiscoverLoading}>
      {socialStore.isDiscoverLoading ? 'Loading...' : 'Shuffle'}
    </button>
  </div>

  {#if socialStore.error}
    <p class="error">{socialStore.error}</p>
  {/if}

  {#if socialStore.isDiscoverLoading && socialStore.discoverUsers.length === 0}
    <LoadingState message="Finding active users..." />
  {:else if socialStore.discoverUsers.length === 0}
    <EmptyState
      title="No users to discover"
      description="Check back later when more users have shared articles"
    />
  {:else}
    <div class="users-grid">
      {#each socialStore.discoverUsers as user (user.did)}
        <div class="user-card card">
          <div class="user-header">
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
          <div class="user-stats">
            <span class="share-count">{user.shareCount} {user.shareCount === 1 ? 'share' : 'shares'} in last 30 days</span>
          </div>
          <button
            class="btn follow-btn"
            class:btn-primary={!isFollowing(user.did)}
            class:btn-secondary={isFollowing(user.did)}
            disabled={isFollowing(user.did) || followingDids.has(user.did)}
            onclick={() => handleFollow(user.did)}
          >
            {#if isFollowing(user.did)}
              Following
            {:else if followingDids.has(user.did)}
              Following...
            {:else}
              Follow
            {/if}
          </button>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .discover-page {
    max-width: 800px;
    margin: 0 auto;
  }

  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 1.5rem;
  }

  .header-content h1 {
    margin: 0;
  }

  .subtitle {
    color: var(--color-text-secondary);
    margin: 0.25rem 0 0 0;
    font-size: 0.875rem;
  }

  .users-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 1rem;
  }

  .user-card {
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .user-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
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
    display: block;
    font-size: 0.875rem;
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .user-stats {
    padding-left: calc(48px + 0.75rem);
  }

  .share-count {
    font-size: 0.875rem;
    color: var(--color-text-secondary);
  }

  .follow-btn {
    width: 100%;
    margin-top: 0.25rem;
  }

  .error {
    color: var(--color-error, #dc3545);
    padding: 1rem;
    background: var(--color-error-bg, #f8d7da);
    border-radius: 8px;
    margin-bottom: 1rem;
  }
</style>
