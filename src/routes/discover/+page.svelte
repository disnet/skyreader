<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { socialStore, FOLLOW_LIMIT } from '$lib/stores/social.svelte';
  import PageHeader from '$lib/components/common/PageHeader.svelte';
  import StateView from '$lib/components/common/StateView.svelte';
  import UserCard from '$lib/components/common/UserCard.svelte';
  import Modal from '$lib/components/common/Modal.svelte';
  import { viewTitleStore } from '$lib/stores/viewTitle.svelte';

  $effect(() => {
    viewTitleStore.set('Discover');
    return () => viewTitleStore.set('');
  });

  let followingDids = $state<Set<string>>(new Set());
  let expandedUsers = $state<Set<string>>(new Set());
  let showLimitModal = $state(false);

  function toggleExpanded(did: string) {
    if (expandedUsers.has(did)) {
      expandedUsers.delete(did);
    } else {
      expandedUsers.add(did);
    }
    expandedUsers = new Set(expandedUsers);
  }

  onMount(async () => {
    if (!auth.isAuthenticated) {
      goto('/auth/login?returnUrl=/discover');
      return;
    }
    await Promise.all([
      socialStore.loadDiscoverUsers(),
      socialStore.loadFollowedUsers(),
      socialStore.loadInAppFollowCount(),
    ]);
  });

  async function shuffle() {
    await socialStore.loadDiscoverUsers();
  }

  async function handleFollow(did: string) {
    // Check if already at follow limit
    if (socialStore.isAtFollowLimit) {
      showLimitModal = true;
      return;
    }

    followingDids.add(did);
    followingDids = new Set(followingDids);
    const success = await socialStore.followUser(did);
    if (!success) {
      followingDids.delete(did);
      followingDids = new Set(followingDids);
    }
  }

  function isFollowing(did: string): boolean {
    return followingDids.has(did) || socialStore.followedUsers.some((u) => u.did === did);
  }
</script>

<div class="discover-page">
  <PageHeader title="Discover" subtitle="Find active Skyreader users to follow">
    <button class="btn btn-secondary" onclick={shuffle} disabled={socialStore.isDiscoverLoading}>
      {socialStore.isDiscoverLoading ? 'Loading...' : 'Shuffle'}
    </button>
  </PageHeader>

  {#if socialStore.error}
    <p class="error">{socialStore.error}</p>
  {/if}

  <StateView
    isLoading={socialStore.isDiscoverLoading && socialStore.discoverUsers.length === 0}
    isEmpty={socialStore.discoverUsers.length === 0}
    loadingMessage="Finding active users..."
    emptyTitle="No users to discover"
    emptyDescription="Check back later when more users have shared articles"
  >
    <div class="users-list">
      {#each socialStore.discoverUsers as user (user.did)}
        {@const isExpanded = expandedUsers.has(user.did)}
        {@const hasShares = user.recentShares && user.recentShares.length > 0}
        <div class="user-row card">
          <div class="user-main">
            <div class="user-info">
              <UserCard
                avatarUrl={user.avatarUrl}
                displayName={user.displayName}
                handle={user.handle}
                size="large"
              />
              <div class="user-stats">
                <span class="share-count">
                  {user.shareCount}
                  {user.shareCount === 1 ? 'share' : 'shares'}
                </span>
                <span class="time-period">in last 30 days</span>
              </div>
            </div>

            <div class="user-actions">
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
                  Follow on Skyreader
                {/if}
              </button>
              <a
                href="https://bsky.app/profile/{user.handle}"
                target="_blank"
                rel="noopener"
                class="btn btn-outline bluesky-link"
              >
                Bluesky Profile
              </a>
            </div>
          </div>

          {#if hasShares}
            <button class="disclosure-toggle" onclick={() => toggleExpanded(user.did)}>
              <span class="disclosure-icon">{isExpanded ? '▼' : '▶'}</span>
              <span>Recent shares</span>
            </button>

            {#if isExpanded}
              <ul class="recent-shares">
                {#each user.recentShares! as share}
                  <li>
                    <a href={share.itemUrl} target="_blank" rel="noopener">
                      {share.itemTitle || share.itemUrl}
                    </a>
                  </li>
                {/each}
              </ul>
            {/if}
          {/if}
        </div>
      {/each}
    </div>
  </StateView>
</div>

<Modal open={showLimitModal} onclose={() => (showLimitModal = false)} title="Follow Limit Reached">
  <div class="limit-modal-content">
    <p>
      While Skyreader is in beta, you can follow up to <strong>{FOLLOW_LIMIT}</strong> accounts.
    </p>
    <p>This limit will be lifted once we're out of beta.</p>
    <p class="current-count">
      You're currently following {socialStore.inAppFollowCount} of {FOLLOW_LIMIT} accounts.
    </p>
  </div>
  {#snippet footer()}
    <button class="btn btn-primary" onclick={() => (showLimitModal = false)}>Got it</button>
  {/snippet}
</Modal>

<style>
  .limit-modal-content {
    text-align: center;
  }

  .limit-modal-content p {
    margin: 0 0 1rem;
    color: var(--color-text-secondary);
  }

  .limit-modal-content p:last-child {
    margin-bottom: 0;
  }

  .limit-modal-content .current-count {
    font-size: 0.875rem;
    color: var(--color-text-tertiary);
  }
  .discover-page {
    max-width: 800px;
    margin: 0 auto;
    padding: 0 1rem;
  }

  .users-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-top: 1rem;
  }

  .user-row {
    display: flex;
    flex-direction: column;
    padding: 1rem;
    gap: 0.75rem;
  }

  .user-main {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    width: 100%;
  }

  .user-info {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
    flex: 1;
  }

  .user-stats {
    display: flex;
    gap: 0.5rem;
    font-size: 0.875rem;
    color: var(--color-text-secondary);
    padding-left: 3.5rem;
  }

  .share-count {
    font-weight: 500;
  }

  .user-actions {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .follow-btn {
    min-width: 150px;
  }

  .bluesky-link {
    text-align: center;
    text-decoration: none;
    font-size: 0.875rem;
  }

  .disclosure-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: none;
    border: none;
    padding: 0.5rem 0;
    font: inherit;
    font-size: 0.875rem;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: color 0.15s;
  }

  .disclosure-toggle:hover {
    color: var(--color-primary);
  }

  .disclosure-icon {
    font-size: 0.625rem;
    width: 1rem;
  }

  .recent-shares {
    list-style: none;
    margin: 0;
    padding: 0 0 0 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .recent-shares li {
    font-size: 0.875rem;
  }

  .recent-shares a {
    color: var(--color-text);
    text-decoration: none;
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .recent-shares a:hover {
    color: var(--color-primary);
    text-decoration: underline;
  }

  .error {
    color: var(--color-error, #dc3545);
    padding: 1rem;
    background: var(--color-error-bg, #f8d7da);
    border-radius: 8px;
    margin-bottom: 1rem;
  }

  @media (max-width: 600px) {
    .user-main {
      flex-direction: column;
      align-items: stretch;
    }

    .user-stats {
      padding-left: 0;
    }

    .user-actions {
      flex-direction: row;
      flex-wrap: wrap;
    }

    .follow-btn,
    .bluesky-link {
      flex: 1;
      min-width: 120px;
    }
  }
</style>
