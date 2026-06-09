<script lang="ts">
  import FeedPageHeader from './FeedPageHeader.svelte';
  import MobileBottomBar from './MobileBottomBar.svelte';
  import MobileFeedSwitcher from './MobileFeedSwitcher.svelte';
  import BottomSheet from '$lib/components/common/BottomSheet.svelte';
  import NotificationList from '$lib/components/NotificationList.svelte';
  import { notificationsStore } from '$lib/stores/notifications.svelte';
  import { mobileStore } from '$lib/stores/mediaQuery.svelte';

  // Navigation chrome for static (non-feed) pages like Settings, Sources, and
  // Discover. On desktop it renders the sticky FeedPageHeader (title + nav
  // dropdown, controls hidden); on mobile it renders the bottom bar whose feed
  // switcher is the only in-app way to navigate away (the installed PWA has no
  // browser back button). FeedPageHeader / MobileBottomBar each carry their own
  // breakpoint guards, so only one is ever visible.
  interface Props {
    title: string;
  }

  let { title }: Props = $props();

  let feedSwitcherOpen = $state(false);
  let notifSheetOpen = $state(false);
</script>

<FeedPageHeader {title} hideControls />

{#if mobileStore.isMobile}
  <MobileBottomBar
    controlsVisible={true}
    currentTitle={title}
    onScrollToTop={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
    onOpenFeedSwitcher={() => (feedSwitcherOpen = true)}
    onOpenFilterSheet={() => {}}
    onOpenNotifications={() => {
      notifSheetOpen = true;
      void notificationsStore.load();
    }}
    hasActiveFilters={false}
    hideFilterButton
  />

  <BottomSheet
    open={feedSwitcherOpen}
    onclose={() => (feedSwitcherOpen = false)}
    title="Switch Feed"
  >
    <MobileFeedSwitcher onclose={() => (feedSwitcherOpen = false)} currentTitle={title} />
  </BottomSheet>

  <BottomSheet
    open={notifSheetOpen}
    onclose={() => {
      notifSheetOpen = false;
      void notificationsStore.markAllSeen();
    }}
    title="Notifications"
  >
    <NotificationList onItemClick={() => (notifSheetOpen = false)} />
  </BottomSheet>
{/if}
