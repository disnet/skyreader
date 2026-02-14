<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { socialStore } from '$lib/stores/social.svelte';
  import { profileService } from '$lib/services/profiles';
  import InfiniteScrollSentinel from '$lib/components/common/InfiniteScrollSentinel.svelte';
  import PageHeader from '$lib/components/common/PageHeader.svelte';
  import StateView from '$lib/components/common/StateView.svelte';
  import UserSearch from '$lib/components/UserSearch.svelte';
  import FollowLimitModal from '$lib/components/FollowLimitModal.svelte';
  import FollowingUserRow from '$lib/components/following/FollowingUserRow.svelte';
  import StandardSubscriptionsTab from '$lib/components/following/StandardSubscriptionsTab.svelte';
  import type { BlueskyProfile, FollowedUserDetailed } from '$lib/types';
  import { viewTitleStore } from '$lib/stores/viewTitle.svelte';

  $effect(() => {
    viewTitleStore.set('Following');
    return () => viewTitleStore.set('');
  });

  let activeTab = $state<'skyreader' | 'bluesky' | 'standard'>('skyreader');
  let profiles = $state<Map<string, BlueskyProfile>>(new Map());
  let actionInProgress = $state<Set<string>>(new Set());
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
      goto('/auth/login?returnUrl=/following');
      return;
    }
    await Promise.all([
      loadCurrentTab(true),
      socialStore.loadFollowedUsers(),
      socialStore.loadInAppFollowCount(),
    ]);
  });

  async function loadCurrentTab(reset = true) {
    if (activeTab === 'skyreader') {
      await socialStore.loadSkyreaderFollows(reset);
      const dids = socialStore.skyreaderFollows.map((u) => u.did);
      const fetched = await profileService.getProfiles(dids);
      profiles = new Map([...profiles, ...fetched]);
    } else if (activeTab === 'bluesky') {
      await socialStore.loadBlueskyFollows(reset, auth.user?.did);
      const dids = socialStore.blueskyFollows.map((u) => u.did);
      const fetched = await profileService.getProfiles(dids);
      profiles = new Map([...profiles, ...fetched]);
    }
    // standard tab manages its own loading via onMount
  }

  async function switchTab(tab: 'skyreader' | 'bluesky' | 'standard') {
    if (activeTab === tab) return;
    activeTab = tab;
    if (tab !== 'standard') {
      await loadCurrentTab(true);
    }
  }

  async function loadMore() {
    await loadCurrentTab(false);
  }

  async function handleUnfollow(user: FollowedUserDetailed) {
    if (!user.rkey) return;
    actionInProgress.add(user.did);
    actionInProgress = new Set(actionInProgress);

    const success = await socialStore.unfollowInApp(user.did);
    if (success) {
      await loadCurrentTab();
      await socialStore.loadFollowedUsers();
    }

    actionInProgress.delete(user.did);
    actionInProgress = new Set(actionInProgress);
  }

  async function handleFollow(user: FollowedUserDetailed) {
    if (socialStore.isAtFollowLimit) {
      showLimitModal = true;
      return;
    }

    actionInProgress.add(user.did);
    actionInProgress = new Set(actionInProgress);

    const success = await socialStore.followUser(user.did);
    if (success) {
      await loadCurrentTab();
      await socialStore.loadFollowedUsers();
    }

    actionInProgress.delete(user.did);
    actionInProgress = new Set(actionInProgress);
  }

  function getProfile(did: string): BlueskyProfile | undefined {
    return profiles.get(did);
  }

  let isLoading = $derived(
    activeTab === 'skyreader'
      ? socialStore.isLoadingSkyreaderFollows
      : socialStore.isLoadingBlueskyFollows
  );

  let currentUsers = $derived(
    activeTab === 'skyreader' ? socialStore.skyreaderFollows : socialStore.blueskyFollows
  );

  let hasMore = $derived(
    activeTab === 'skyreader'
      ? socialStore.hasMoreSkyreaderFollows
      : activeTab === 'bluesky'
        ? socialStore.hasMoreBlueskyFollows
        : false
  );

  let followedDids = $derived(new Set(socialStore.followedUsers.map((u) => u.did)));

  async function handleSearchFollow(did: string) {
    if (socialStore.isAtFollowLimit) {
      showLimitModal = true;
      return;
    }

    const success = await socialStore.followUser(did);
    if (success) {
      await loadCurrentTab();
      await socialStore.loadFollowedUsers();
    }
  }
</script>

<div class="following-page">
  <PageHeader title="Following" subtitle="Manage who you follow on Skyreader" />

  <div class="search-section">
    <UserSearch {followedDids} onFollow={handleSearchFollow} />
  </div>

  {#if socialStore.error}
    <p class="error">{socialStore.error}</p>
  {/if}

  <div class="tabs">
    <button
      class="tab"
      class:active={activeTab === 'skyreader'}
      onclick={() => switchTab('skyreader')}
    >
      Following on Skyreader
    </button>
    <button class="tab" class:active={activeTab === 'bluesky'} onclick={() => switchTab('bluesky')}>
      Following on Bluesky
    </button>
    <button
      class="tab"
      class:active={activeTab === 'standard'}
      onclick={() => switchTab('standard')}
    >
      Subscriptions
    </button>
  </div>

  {#if activeTab === 'standard'}
    <StandardSubscriptionsTab />
  {:else}
    <StateView
      {isLoading}
      isEmpty={currentUsers.length === 0}
      loadingMessage="Loading follows..."
      emptyTitle={activeTab === 'skyreader'
        ? 'Not following anyone on Skyreader'
        : 'No Bluesky follows found'}
      emptyDescription={activeTab === 'skyreader'
        ? 'Follow users from the Discover page to see their shared articles'
        : 'Sync your Bluesky follows from Settings to see them here'}
      emptyActionHref={activeTab === 'skyreader' ? '/discover' : '/settings'}
      emptyActionText={activeTab === 'skyreader' ? 'Discover Users' : 'Go to Settings'}
    >
      <div class="users-list">
        {#each currentUsers as user (user.did)}
          <FollowingUserRow
            {user}
            profile={getProfile(user.did)}
            mode={activeTab}
            isExpanded={expandedUsers.has(user.did)}
            isActionInProgress={actionInProgress.has(user.did)}
            onToggleExpanded={() => toggleExpanded(user.did)}
            onFollow={handleFollow}
            onUnfollow={handleUnfollow}
          />
        {/each}
      </div>

      <InfiniteScrollSentinel {hasMore} {isLoading} onLoadMore={loadMore} />
    </StateView>
  {/if}
</div>

<FollowLimitModal open={showLimitModal} onclose={() => (showLimitModal = false)} />

<style>
  .search-section {
    margin: 1rem 0;
  }

  .following-page {
    max-width: 800px;
    margin: 0 auto;
    padding: 0 1rem;
  }

  .tabs {
    display: flex;
    gap: 0;
    margin: 1rem 0;
    border-bottom: 1px solid var(--color-border);
  }

  .tab {
    background: none;
    border: none;
    padding: 0.75rem 1rem;
    font: inherit;
    font-size: 0.875rem;
    color: var(--color-text-secondary);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    transition:
      color 0.15s,
      border-color 0.15s;
  }

  .tab:hover {
    color: var(--color-text);
  }

  .tab.active {
    color: var(--color-primary);
    border-bottom-color: var(--color-primary);
  }

  .users-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .error {
    color: var(--color-error, #dc3545);
    padding: 1rem;
    background: var(--color-error-bg, #f8d7da);
    border-radius: 8px;
    margin-bottom: 1rem;
  }
</style>
