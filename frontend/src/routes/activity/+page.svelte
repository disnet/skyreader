<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { activityStore } from '$lib/stores/activity.svelte';
  import { profileService } from '$lib/services/profiles';
  import InfiniteScrollSentinel from '$lib/components/common/InfiniteScrollSentinel.svelte';
  import FeedPageHeader from '$lib/components/feed/FeedPageHeader.svelte';
  import MobileBottomBar from '$lib/components/feed/MobileBottomBar.svelte';
  import MobileFeedSwitcher from '$lib/components/feed/MobileFeedSwitcher.svelte';
  import BottomSheet from '$lib/components/common/BottomSheet.svelte';
  import StateView from '$lib/components/common/StateView.svelte';
  import { mobileStore } from '$lib/stores/mediaQuery.svelte';
  import { formatRelativeDate } from '$lib/utils/date';
  import type { BlueskyProfile, ReshareActivity } from '$lib/types';
  import { viewTitleStore } from '$lib/stores/viewTitle.svelte';

  $effect(() => {
    viewTitleStore.set('Activity');
    return () => viewTitleStore.set('');
  });

  let profiles = $state<Map<string, BlueskyProfile>>(new Map());

  onMount(async () => {
    if (!auth.isAuthenticated) {
      goto('/auth/login?returnUrl=/activity');
      return;
    }
    await activityStore.loadReshareActivity();
  });

  // Load profiles for resharers
  $effect(() => {
    for (const item of activityStore.reshareActivity) {
      for (const resharer of item.resharers.slice(0, 3)) {
        if (!profiles.has(resharer.did)) {
          profileService.getProfile(resharer.did).then((p) => {
            if (p) {
              profiles.set(resharer.did, p);
              profiles = new Map(profiles);
            }
          });
        }
      }
    }
  });

  function getHandle(did: string): string {
    const profile = profiles.get(did);
    return profile?.handle || did.slice(0, 16) + '...';
  }

  function formatResharers(item: ReshareActivity): string {
    const resharers = item.resharers;
    if (resharers.length === 0) return '';

    const first = `@${getHandle(resharers[0].did)}`;

    if (resharers.length === 1) {
      return first;
    }

    if (resharers.length === 2) {
      return `${first} and @${getHandle(resharers[1].did)}`;
    }

    const othersCount = resharers.length - 1;
    return `${first} and ${othersCount} others`;
  }

  let feedSwitcherOpen = $state(false);

  async function loadMore() {
    await activityStore.loadReshareActivity(true);
  }
</script>

<FeedPageHeader title="Activity" hideControls />

<div class="activity-page">
  <StateView
    isLoading={activityStore.isLoading && activityStore.reshareActivity.length === 0}
    isEmpty={activityStore.reshareActivity.length === 0}
    loadingMessage="Loading activity..."
    emptyTitle="No reshares yet"
    emptyDescription="When someone reshares your articles, you'll see it here"
  >
    <div class="activity-list">
      {#each activityStore.reshareActivity as item (item.originalShare.uri)}
        <div class="activity-item card">
          <div class="activity-content">
            <span class="resharers-text">{formatResharers(item)}</span>
            <span class="activity-text">reshared your article</span>
          </div>
          <a href={item.originalShare.itemUrl} target="_blank" rel="noopener" class="article-link">
            {item.originalShare.itemTitle || item.originalShare.itemUrl}
          </a>
          <div class="activity-date">
            {formatRelativeDate(item.latestReshareAt)}
          </div>
        </div>
      {/each}
    </div>

    <InfiniteScrollSentinel
      hasMore={activityStore.hasMore}
      isLoading={activityStore.isLoading}
      onLoadMore={loadMore}
    />
  </StateView>

  {#if mobileStore.isMobile}
    <MobileBottomBar
      controlsVisible={true}
      currentTitle="Activity"
      onScrollToTop={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      onOpenFeedSwitcher={() => (feedSwitcherOpen = true)}
      onOpenFilterSheet={() => {}}
      hasActiveFilters={false}
      hideFilterButton
    />

    <BottomSheet
      open={feedSwitcherOpen}
      onclose={() => (feedSwitcherOpen = false)}
      title="Switch Feed"
    >
      <MobileFeedSwitcher onclose={() => (feedSwitcherOpen = false)} currentTitle="Activity" />
    </BottomSheet>
  {/if}
</div>

<style>
  .activity-page {
    display: flex;
    flex-direction: column;
    max-width: 600px;
    margin: 0 auto;
    padding: 3.5rem 1rem 1rem;
    gap: 1rem;
  }

  @media (max-width: 1000px) {
    .activity-page {
      padding-top: 0.5rem;
      padding-bottom: calc(var(--bottom-bar-height) + var(--safe-area-bottom) + 1rem);
    }
  }

  .activity-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .activity-item {
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .activity-content {
    font-size: 0.9375rem;
  }

  .resharers-text {
    color: var(--color-primary);
    font-weight: 500;
  }

  .activity-text {
    color: var(--color-text);
  }

  .article-link {
    color: var(--color-text);
    text-decoration: none;
    font-weight: 500;
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .article-link:hover {
    color: var(--color-primary);
    text-decoration: underline;
  }

  .activity-date {
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
  }
</style>
