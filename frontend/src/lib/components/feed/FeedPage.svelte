<script lang="ts">
  import { appScrollTo } from '$lib/utils/appScroll';
  import { onMount, onDestroy, tick, untrack } from 'svelte';
  import { page } from '$app/stores';
  import { browser } from '$app/environment';
  import { READ_PARAM } from '$lib/utils/readerLink';
  import { auth } from '$lib/stores/auth.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { linkblogStore } from '$lib/stores/linkblog.svelte';
  import { myLinkblogStore } from '$lib/stores/myLinkblog.svelte';
  import { preferences } from '$lib/stores/preferences.svelte';
  import { feedViewStore } from '$lib/stores/feedView.svelte';
  import { savedSearchStore } from '$lib/stores/savedSearch.svelte';
  import { unreadCounts } from '$lib/stores/unreadCounts.svelte';
  import { filteredViewsStore } from '$lib/stores/filteredViews.svelte';
  import { appManager } from '$lib/stores/app.svelte';
  import { articlesStore } from '$lib/stores/articles.svelte';
  import { viewTitleStore } from '$lib/stores/viewTitle.svelte';
  import { profileService } from '$lib/services/profiles';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import LibraryEmptyState from '$lib/components/LibraryEmptyState.svelte';
  import LoadingState from '$lib/components/LoadingState.svelte';
  import WelcomePage from '$lib/components/feed/WelcomePage.svelte';
  import FeedPageHeader from '$lib/components/feed/FeedPageHeader.svelte';
  import FeedListView from '$lib/components/feed/FeedListView.svelte';
  import SavedListView from '$lib/components/feed/SavedListView.svelte';
  import SavedSearchBar from '$lib/components/feed/SavedSearchBar.svelte';
  import EditFeedModal from '$lib/components/EditFeedModal.svelte';
  import MobileBottomBar from '$lib/components/feed/MobileBottomBar.svelte';
  import MobileFeedSwitcher from '$lib/components/feed/MobileFeedSwitcher.svelte';
  import MobileFilterSheet from '$lib/components/feed/MobileFilterSheet.svelte';
  import PullToRefresh from '$lib/components/PullToRefresh.svelte';
  import BottomSheet from '$lib/components/common/BottomSheet.svelte';
  import NotificationList from '$lib/components/NotificationList.svelte';
  import { notificationsStore } from '$lib/stores/notifications.svelte';
  import { useScrollDirection } from '$lib/hooks/useScrollDirection.svelte';
  import { mobileStore } from '$lib/stores/mediaQuery.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { syncStore } from '$lib/stores/sync.svelte';
  import type { Subscription, BlueskyProfile } from '$lib/types';
  import { useScrollMarkAsRead } from '$lib/hooks/useScrollMarkAsRead.svelte';
  import { useFeedKeyboardShortcuts } from '$lib/hooks/useFeedKeyboardShortcuts.svelte';
  import { goto } from '$app/navigation';
  import { channelPath, FEEDS_PATH } from '$lib/utils/viewNav';
  import LinkblogIntro from '$lib/components/feed/LinkblogIntro.svelte';
  import LinkblogListView from '$lib/components/feed/LinkblogListView.svelte';
  import { shareDraftsStore } from '$lib/stores/shareDrafts.svelte';

  // `linkblog` renders the current user's own linkblog (their shared documents)
  // through the same feed UI as the main feed.
  let { mode = 'feed' }: { mode?: 'feed' | 'linkblog' } = $props();

  // Scroll-hide state — drives the mobile bottom bar's hide-on-scroll. The
  // desktop header stays pinned, so its inline filter/style rows are left open
  // while scrolling (they close on click-outside) rather than snapping shut.
  const scrollDirection = useScrollDirection();
  let feedSwitcherOpen = $state(false);
  let filterSheetOpen = $state(false);
  let notifSheetOpen = $state(false);
  let readerOpen = $state(false);
  let filterSheetInitialTab = $state<'filters' | 'channel'>('filters');
  let editingChannelId = $state<number | null>(null);
  let channelCreateMode = $state(false);
  let channelCreateInitialType = $state<'feed' | 'saved' | null>(null);

  function handleEditChannel(id: number) {
    feedSwitcherOpen = false;
    editingChannelId = id;
    channelCreateMode = false;
    channelCreateInitialType = null;
    filterSheetInitialTab = 'channel';
    filterSheetOpen = true;
  }

  function handleCreateChannel(type: 'feed' | 'saved' = 'feed') {
    feedSwitcherOpen = false;
    editingChannelId = null;
    channelCreateMode = true;
    channelCreateInitialType = type;
    filterSheetInitialTab = 'channel';
    filterSheetOpen = true;
  }

  function scrollToTop() {
    appScrollTo({ top: 0, behavior: 'smooth' });
  }

  let hasActiveFilters = $derived(
    feedViewStore.toolbarTypeFilter.length > 0 ||
      feedViewStore.toolbarTagFilter.length > 0 ||
      feedViewStore.effectiveFilters.sourceMode !== 'all'
  );

  // Profile for sharer filter title
  let sharerProfile = $state<BlueskyProfile | null>(null);

  // Fetch sharer profile when filter changes
  $effect(() => {
    const sharerDid = feedViewStore.sharerFilter;
    if (sharerDid) {
      profileService.getProfile(sharerDid).then((p) => {
        sharerProfile = p;
      });
    } else {
      sharerProfile = null;
    }
  });

  // Sync URL filters to feedViewStore
  // Use untrack for setFilters to prevent re-running when saved view data changes
  // (syncToolbarToSavedView updates filteredViewsStore which setFilters reads from)
  $effect(() => {
    // The linkblog view isn't URL-param driven; it's set via setMyLinkblogMode.
    if (mode === 'linkblog') return;
    const url = $page.url;
    const typeParam = url.searchParams.get('type');
    const contentType: 'documents' | null = typeParam === 'documents' ? typeParam : null;
    const filters = {
      feed: url.searchParams.get('feed'),
      // The Saved surface is now its own route; treat /saved as the saved view
      // (the legacy ?saved=true still works for old deep links).
      saved: url.pathname === '/saved' ? 'true' : url.searchParams.get('saved'),
      sharer: url.searchParams.get('sharer'),
      following: url.searchParams.get('following'),
      feeds: null,
      contentType,
      view: url.searchParams.get('view'),
      category: url.searchParams.get('category'),
    };
    untrack(() => feedViewStore.setFilters(filters));
  });

  // Canonicalize a linkblog deep link. "Open in Skyreader" on a public linkblog
  // points at /?feed=<publicationUri> (or /?feed=<did>) — a stable, cross-user
  // identifier the page can emit without knowing the visitor's local DB. Once
  // subscriptions hydrate, swap it for the numeric subscription id so the sidebar
  // highlights and subsequent in-app navigation match every other feed link.
  $effect(() => {
    if (mode === 'linkblog') return;
    const feed = $page.url.searchParams.get('feed');
    if (!feed || /^\d+$/.test(feed)) return;
    const subs = subscriptionsStore.subscriptions;
    const match = feed.startsWith('at://')
      ? subs.find((s) => s.sourceType === 'atproto.documents' && s.feedUrl === feed)
      : feed.startsWith('did:')
        ? subs.find((s) => s.sourceType === 'atproto.documents' && s.subjectDid === feed)
        : undefined;
    if (match?.id != null) {
      const url = new URL($page.url);
      url.searchParams.set('feed', String(match.id));
      goto(url.pathname + url.search, { replaceState: true, keepFocus: true, noScroll: true });
    }
  });

  // Tab visibility state
  let lastVisibleTime = $state(Date.now());
  const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
  // Floor between delta-only pulls, so a flapping tab doesn't poll.
  const DELTA_MIN_INTERVAL_MS = 60 * 1000;
  // Gentle while-open cadence. A tab left open all afternoon used to observe
  // nothing another device did; this is what makes read state converge without
  // adding a push channel (deliberately out of scope — the delta is cheap and
  // the product is calm).
  const DELTA_POLL_INTERVAL_MS = 5 * 60 * 1000;
  let deltaPollTimer: ReturnType<typeof setInterval> | null = null;

  // Reference to FeedListView or SavedListView component for accessing article elements
  let feedListView = $state<ReturnType<typeof FeedListView> | null>(null);
  let savedListView = $state<ReturnType<typeof SavedListView> | null>(null);

  let isSavedView = $derived(feedViewStore.isSavedView);

  function getArticleElements(): HTMLElement[] {
    if (isSavedView) {
      return savedListView?.getArticleElements() ?? [];
    }
    return feedListView?.getArticleElements() ?? [];
  }

  function scrollToCenter() {
    if (isSavedView) {
      savedListView?.scrollToCenter();
    } else {
      feedListView?.scrollToCenter();
    }
  }

  // Edit modal state
  let editingSubscription = $state<Subscription | null>(null);
  let editModalOpen = $state(false);

  function handleEditFeed() {
    if (!feedViewStore.feedFilter) return;
    const feedId = parseInt(feedViewStore.feedFilter);
    const sub = subscriptionsStore.subscriptions.find((s) => s.id === feedId);
    if (sub) {
      editingSubscription = sub;
      editModalOpen = true;
    }
  }

  function closeEditModal() {
    editModalOpen = false;
    editingSubscription = null;
  }

  // Get page title based on filter
  let pageTitle = $derived.by(() => {
    if (mode === 'linkblog') return 'Linkblog';
    if (feedViewStore.viewFilter) {
      const fv = feedViewStore.activeFilteredView;
      return fv?.name || 'Channel';
    }
    if (feedViewStore.categoryFilter) {
      return feedViewStore.categoryFilter;
    }
    if (feedViewStore.feedFilter) {
      const sub = subscriptionsStore.subscriptions.find(
        (s) => s.id === parseInt(feedViewStore.feedFilter!)
      );
      return sub?.customTitle || sub?.title || 'Feed';
    }
    if (feedViewStore.savedFilter) return 'Saved';
    if (feedViewStore.followingFilter) return 'Following';
    if (feedViewStore.sharerFilter) {
      return sharerProfile?.displayName || sharerProfile?.handle || 'Articles';
    }
    return 'Feeds';
  });

  // Get unread count for the current view
  let viewUnreadCount = $derived.by(() => {
    if (mode === 'linkblog') return 0;
    if (feedViewStore.feedFilter) {
      return unreadCounts.feedCounts.get(parseInt(feedViewStore.feedFilter)) || 0;
    }
    if (feedViewStore.savedFilter) {
      return 0;
    }
    if (feedViewStore.sharerFilter) {
      return unreadCounts.getUnreadForSharer(feedViewStore.sharerFilter);
    }
    if (feedViewStore.followingFilter) {
      return unreadCounts.totalSocial;
    }
    // "All" view
    return unreadCounts.totalArticles + unreadCounts.totalSocial;
  });

  $effect(() => {
    viewTitleStore.set(pageTitle, viewUnreadCount);
    return () => viewTitleStore.set('');
  });

  // Mark an item as read by its stable key
  function markItemAsReadByKey(key: string) {
    const items = feedViewStore.currentItems;
    const item = items.find((i) => i.key === key);
    if (!item) return;

    // Track the item so it stays visible in unread filter until view changes
    feedViewStore.trackSeenThisSession(item);

    if (item.type === 'article') {
      const article = item.item;
      if (itemLabelsStore.isRead(article.guid)) return;

      const sub = subscriptionsStore.subscriptions.find((s) => s.id === article.subscriptionId);
      if (sub) {
        itemLabelsStore.markAsRead(sub.rkey, article.guid, article.url, article.title);
      }
    } else if (item.type === 'document') {
      const doc = item.item;
      if (itemLabelsStore.isSocialRead(doc.recordUri)) return;

      itemLabelsStore.markSocialAsRead(
        'document',
        doc.recordUri,
        doc.authorDid,
        doc.canonicalUrl || '',
        doc.title
      );
    }
  }

  // Initialize scroll-to-mark-as-read hook
  const scrollMarkAsRead = useScrollMarkAsRead({
    getArticleElements,
    getItemKey: (index) => feedViewStore.currentItems[index]?.key,
    enabled: preferences.scrollToMarkAsRead,
    onMarkAsRead: markItemAsReadByKey,
  });

  // Setup/teardown scroll-to-mark-as-read observer when content changes
  $effect(() => {
    const _items = feedViewStore.currentItems;
    const _enabled = preferences.scrollToMarkAsRead;

    tick().then(() => {
      scrollMarkAsRead.setupObserver();
    });
  });

  async function markAllAsReadInCurrentFeed() {
    if (!feedViewStore.feedFilter) return;

    const feedId = parseInt(feedViewStore.feedFilter);
    const sub = subscriptionsStore.subscriptions.find((s) => s.id === feedId);
    if (!sub) return;

    const allFeedArticles = articlesStore.getForSubscription(feedId);

    const articlesToMark = allFeedArticles
      .filter((a) => !itemLabelsStore.isRead(a.guid))
      .map((a) => ({
        subscriptionRkey: sub.rkey,
        articleGuid: a.guid,
        articleUrl: a.url,
        articleTitle: a.title,
      }));

    if (articlesToMark.length === 0) return;

    if (articlesToMark.length > 100) {
      if (!confirm(`Mark ${articlesToMark.length} items as read?`)) return;
    }

    // Track in session sets so items stay visible (greyed out) in unread filter
    feedViewStore.trackItemsAsReadThisSession(
      articlesToMark.map((a) => a.articleGuid),
      []
    );

    // Scoped to the feed so the server marks its whole canonical window, not
    // just the slice this device happens to hold — otherwise another device
    // holding older items would still show them unread after this. Only RSS:
    // atproto sources aren't in the archive and reconcile by digest instead.
    const isRss = !sub.sourceType || sub.sourceType === 'rss';
    await itemLabelsStore.markAllAsRead(
      articlesToMark,
      isRss && sub.feedUrl
        ? { feedUrl: sub.feedUrl, beforeSeq: unreadCounts.serverCountsHead }
        : undefined
    );
  }

  async function markAllAsReadInCurrentView() {
    // Use all filtered items (not just paginated/displayed) for articles
    const allArticles = feedViewStore.filteredArticles;
    const allDocuments = feedViewStore.displayedDocuments;

    const articlesToMark: Array<{
      subscriptionRkey: string;
      articleGuid: string;
      articleUrl: string;
      articleTitle: string;
    }> = [];
    const documentUrisToTrack: string[] = [];

    for (const article of allArticles) {
      if (!itemLabelsStore.isRead(article.guid)) {
        const sub = subscriptionsStore.subscriptions.find((s) => s.id === article.subscriptionId);
        if (sub) {
          articlesToMark.push({
            subscriptionRkey: sub.rkey,
            articleGuid: article.guid,
            articleUrl: article.url,
            articleTitle: article.title,
          });
        }
      }
    }

    for (const doc of allDocuments) {
      if (!itemLabelsStore.isSocialRead(doc.recordUri)) {
        documentUrisToTrack.push(doc.recordUri);
      }
    }

    const totalCount = articlesToMark.length + documentUrisToTrack.length;
    if (totalCount === 0) return;

    if (totalCount > 100) {
      if (!confirm(`Mark ${totalCount} items as read?`)) return;
    }

    // Track in session sets so items stay visible (greyed out) in unread filter
    feedViewStore.trackItemsAsReadThisSession(
      articlesToMark.map((a) => a.articleGuid),
      documentUrisToTrack
    );

    // Build social items for bulk marking
    const socialItemsToMark: Array<{
      type: 'document';
      itemUri: string;
      authorDid: string;
      itemUrl: string;
      itemTitle?: string;
    }> = [];

    for (const doc of allDocuments) {
      if (documentUrisToTrack.includes(doc.recordUri)) {
        socialItemsToMark.push({
          type: 'document',
          itemUri: doc.recordUri,
          authorDid: doc.authorDid,
          itemUrl: doc.canonicalUrl || '',
          itemTitle: doc.title,
        });
      }
    }

    // Mark all using bulk operations
    const promises: Promise<void>[] = [];
    if (articlesToMark.length > 0) {
      // The all-feeds server variant only applies to the unfiltered view: a
      // channel or source filter means the user asked to clear THAT set, and
      // marking every subscribed feed would read as the action doing far more
      // than it said. Filtered views keep the per-item path.
      const wholeView =
        !feedViewStore.feedFilter &&
        !feedViewStore.viewFilter &&
        !feedViewStore.sharerFilter &&
        !feedViewStore.categoryFilter;
      promises.push(
        itemLabelsStore.markAllAsRead(
          articlesToMark,
          wholeView ? { beforeSeq: unreadCounts.serverCountsHead } : undefined
        )
      );
    }
    if (socialItemsToMark.length > 0) {
      promises.push(itemLabelsStore.markAllSocialAsRead(socialItemsToMark));
    }
    await Promise.all(promises);
  }

  // Keyboard shortcuts hook
  const keyboardShortcuts = useFeedKeyboardShortcuts({
    scrollToCenter,
    markAllAsReadInCurrentFeed,
    openSavedReader: () => savedListView?.openSelectedReader(),
    openFullscreenReader: () => feedListView?.openSelectedReader(),
  });

  async function removeFeed(id: number) {
    if (confirm('Are you sure you want to remove this subscription?')) {
      await subscriptionsStore.remove(id);
      goto(FEEDS_PATH);
    }
  }

  async function handleVisibilityChange() {
    if (document.visibilityState === 'visible' && auth.isAuthenticated) {
      // Check if data is actually stale using persisted lastRefreshAt
      if (appManager.isStale(STALE_THRESHOLD_MS)) {
        console.log('Data is stale, refreshing...');
        await appManager.refreshFromBackend();
        feedViewStore.clearReadThisSession();
      } else {
        // Not stale enough for a full refresh, but coming back to this tab is
        // exactly when someone expects their phone's reading to be here. A
        // delta-only pull is two indexed queries that usually return nothing,
        // so it gets a one-minute gate rather than the full refresh's thirty.
        void itemLabelsStore.pullDelta(DELTA_MIN_INTERVAL_MS);
      }
    }
    lastVisibleTime = Date.now();
  }

  async function handleRefreshWithToast() {
    const newArticles = await appManager.refreshFromBackend();
    feedViewStore.clearReadThisSession();
    if (newArticles > 0) {
      const id = toastStore.add(`${newArticles} new article${newArticles === 1 ? '' : 's'}`);
      toastStore.update(id, 'success');
    } else {
      const id = toastStore.add('All caught up!');
      toastStore.update(id, 'success');
    }
  }

  onMount(async () => {
    if (mode === 'linkblog') {
      feedViewStore.setMyLinkblogMode(true);
      myLinkblogStore.load();
    }

    if (auth.isAuthenticated) {
      // Use the new centralized app initialization
      await appManager.initialize();
    }

    scrollMarkAsRead.init();
    keyboardShortcuts.register();

    document.addEventListener('visibilitychange', handleVisibilityChange);
    lastVisibleTime = Date.now();

    deltaPollTimer = setInterval(() => {
      // Skipped when hidden or offline — pullDelta no-ops offline, and a hidden
      // tab has no one to show the result to (visibilitychange covers the
      // return). Same scheduling shape as the notifications timer.
      if (!auth.isAuthenticated) return;
      if (document.visibilityState !== 'visible') return;
      void itemLabelsStore.pullDelta(DELTA_MIN_INTERVAL_MS);
    }, DELTA_POLL_INTERVAL_MS);
  });

  // The linkblog stream carries unposted drafts alongside published entries, so
  // an empty published set is not an empty page.
  let hasLinkblogDrafts = $derived(mode === 'linkblog' && shareDraftsStore.list.length > 0);

  // Is a `?read=` link waiting to be honoured? The reader stack lives inside the
  // list views, so a surface that swaps its list for an empty state would
  // swallow the link — a shared or bookmarked article landing on a feed-less or
  // filtered-empty page would show a bare empty state with an unexplained param
  // still in the address bar. While the param is there the list mounts instead
  // (empty, and covered by the reader anyway); the hook then either opens the
  // article or toasts and strips the param, which brings the empty state back.
  let readerLinkPending = $derived.by(() => {
    // `$page` notifies on every push, pop and navigation and is the trigger; the
    // live location is the truth, because shallow routing moves the address bar
    // without touching `$page.url` (see `useReaderStack`).
    void $page.state;
    if (!browser) return false;
    return new URL(location.href).searchParams.has(READ_PARAM);
  });

  // Reset selection when any filter changes
  $effect(() => {
    const _ = [
      feedViewStore.feedFilter,
      feedViewStore.savedFilter,
      feedViewStore.sharerFilter,
      feedViewStore.followingFilter,
      feedViewStore.contentTypeFilter,
      feedViewStore.viewFilter,
    ];
    feedViewStore.resetSelection();
  });

  // This page owns the saved search row, so it owns the window in which search
  // exists at all: the global `/` shortcut asks the store whether there is a
  // row to open. The view filters can't answer that — they survive unmount.
  $effect(() => {
    savedSearchStore.setSurfaceActive(isSavedView);
  });

  onDestroy(() => {
    if (mode === 'linkblog') {
      feedViewStore.setMyLinkblogMode(false);
    }
    // Leaving the surface ends the search; a stale query must not come back
    // pre-applied (and silently emptying the list) on the next visit.
    savedSearchStore.setSurfaceActive(false);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    if (deltaPollTimer) clearInterval(deltaPollTimer);
  });
</script>

<EditFeedModal open={editModalOpen} subscription={editingSubscription} onclose={closeEditModal} />

{#if !auth.isAuthenticated && !auth.isGuest}
  <WelcomePage />
{:else}
  <!-- Lift any floating action bar above the fixed mobile nav while it's visible;
       drops to 0 when the nav hides on scroll so the bar settles to the bottom. -->
  <div
    class="feed-page"
    style:--mobile-nav-lift={mobileStore.isMobile && !readerOpen && scrollDirection.controlsVisible
      ? 'var(--bottom-bar-height)'
      : '0px'}
  >
    {#if !readerOpen}
      <FeedPageHeader
        title={pageTitle}
        feedId={feedViewStore.feedFilter ? parseInt(feedViewStore.feedFilter) : undefined}
        expandAllItems={preferences.expandAllItems}
        lastRefreshAt={appManager.lastRefreshAt}
        isRefreshing={appManager.isRefreshing}
        onToggleExpandAll={mode === 'linkblog'
          ? undefined
          : (value) => {
              preferences.setExpandAllItems(value);
              if (!value) {
                feedViewStore.resetSelection();
              }
            }}
        onRefresh={handleRefreshWithToast}
        onMarkAllAsRead={!feedViewStore.savedFilter ? markAllAsReadInCurrentView : undefined}
        onEdit={feedViewStore.feedFilter ? handleEditFeed : undefined}
        onDelete={feedViewStore.feedFilter
          ? () => removeFeed(parseInt(feedViewStore.feedFilter!))
          : undefined}
        showSourceFilter={mode !== 'linkblog' &&
          !feedViewStore.feedFilter &&
          !feedViewStore.savedFilter &&
          !feedViewStore.sharerFilter &&
          !feedViewStore.followingFilter}
        onEditChannel={(id) => sidebarStore.openChannelModal(id)}
      />
    {/if}

    <div class="feed-page-body">
      {#if mode === 'linkblog'}
        <LinkblogIntro />
      {/if}

      <!-- Sits here rather than inside the header because the header is hidden
           below 1000px (the mobile bottom bar takes over) — this way the same
           row serves desktop and mobile, directly beneath the header on both. -->
      {#if isSavedView && savedSearchStore.open && !readerOpen}
        <SavedSearchBar />
      {/if}

      <PullToRefresh
        onRefresh={handleRefreshWithToast}
        disabled={!syncStore.isOnline || appManager.isRefreshing}
      >
        {#if (appManager.isHydrating || appManager.isRefreshing || (mode === 'linkblog' && myLinkblogStore.loading && !myLinkblogStore.loaded)) && feedViewStore.currentItems.length === 0 && !hasLinkblogDrafts}
          <LoadingState />
        {:else if !isSavedView && feedViewStore.currentItems.length === 0 && !hasLinkblogDrafts && !readerLinkPending}
          {#if mode === 'linkblog'}
            <!-- Linkblog always shows all shares, so there's no "no unread" case. -->
            <EmptyState
              title="Nothing posted yet"
              description="Share an article from your feed and it lands here, and on your public page."
            />
          {:else if feedViewStore.viewFilter}
            <EmptyState
              title="No matching items"
              description="This filtered view has no items matching its criteria"
              actionHref="/"
              actionText="Show everything"
            />
          {:else if feedViewStore.followingFilter}
            {#if feedViewStore.showOnlyUnread}
              <EmptyState
                title="No unread posts"
                description="You're all caught up on people you follow"
              />
            {:else}
              <EmptyState
                title="No posts"
                description="People you follow haven't posted to their linkblogs yet"
              />
            {/if}
          {:else if feedViewStore.sharerFilter}
            {#if feedViewStore.showOnlyUnread}
              <EmptyState
                title="No unread posts"
                description="You're all caught up on this person"
              />
            {:else}
              <EmptyState
                title="No posts from this person"
                description="This person hasn't posted to their linkblog yet"
              />
            {/if}
          {:else if feedViewStore.feedFilter}
            {#if feedViewStore.showOnlyUnread}
              <EmptyState
                title="No unread articles"
                description="You're all caught up on this feed"
              />
            {:else}
              <EmptyState title="No articles" description="This feed has no articles" />
            {/if}
          {:else if subscriptionsStore.subscriptions.length === 0}
            <LibraryEmptyState
              onAddFeed={() => sidebarStore.openAddFeedModal()}
              onAddHandle={() => sidebarStore.openAddHandleModal()}
            />
          {:else if feedViewStore.showOnlyUnread}
            <EmptyState title="No unread articles" description="You're all caught up!" />
          {:else}
            <EmptyState
              title="No articles"
              description="Your feeds haven't published anything yet. Check back later."
            />
          {/if}
        {:else if mode === 'linkblog'}
          <LinkblogListView onReaderChange={(open) => (readerOpen = open)} />
        {:else if isSavedView}
          <SavedListView bind:this={savedListView} onReaderChange={(open) => (readerOpen = open)} />
        {:else}
          <FeedListView
            bind:this={feedListView}
            onToggleSave={(article) =>
              itemLabelsStore.toggleSave(article.guid, 'article', article.url, article.title, {
                type: 'article',
                guid: article.guid,
                subscriptionId: article.subscriptionId,
                url: article.url,
                title: article.title,
                author: article.author,
                summary: article.summary,
                imageUrl: article.imageUrl,
                publishedAt: article.publishedAt,
              })}
            onUnshare={(url) => linkblogStore.unshare(url)}
            onReaderChange={(open) => (readerOpen = open)}
          />
        {/if}
      </PullToRefresh>
    </div>

    {#if mobileStore.isMobile && !readerOpen}
      <MobileBottomBar
        controlsVisible={scrollDirection.controlsVisible}
        currentTitle={pageTitle}
        onScrollToTop={scrollToTop}
        onOpenFeedSwitcher={() => (feedSwitcherOpen = true)}
        onOpenNotifications={() => {
          notifSheetOpen = true;
          // Load the enriched list; the badge already polled the source list. Items
          // stay highlighted while the sheet is open, then mark seen on close.
          void notificationsStore.load();
        }}
        onOpenFilterSheet={() => {
          filterSheetInitialTab = 'filters';
          editingChannelId = feedViewStore.activeFilteredView?.id ?? null;
          channelCreateMode = false;
          filterSheetOpen = true;
        }}
        {hasActiveFilters}
        onOpenSearch={isSavedView ? () => savedSearchStore.openSearch() : undefined}
        searchActive={savedSearchStore.active}
      />

      <BottomSheet
        open={feedSwitcherOpen}
        onclose={() => (feedSwitcherOpen = false)}
        title="Switch Feed"
      >
        <MobileFeedSwitcher
          onclose={() => (feedSwitcherOpen = false)}
          currentTitle={pageTitle}
          onEditChannel={handleEditChannel}
          onCreateChannel={handleCreateChannel}
        />
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

      <BottomSheet
        open={filterSheetOpen}
        onclose={() => (filterSheetOpen = false)}
        title={filterSheetInitialTab === 'channel'
          ? editingChannelId != null
            ? 'Edit Channel'
            : 'New Channel'
          : 'Filters & Style'}
      >
        <MobileFilterSheet
          expandAllItems={preferences.expandAllItems}
          onToggleExpandAll={(value) => {
            preferences.setExpandAllItems(value);
            if (!value) {
              feedViewStore.resetSelection();
            }
          }}
          {isSavedView}
          onMarkAllAsRead={!feedViewStore.savedFilter ? markAllAsReadInCurrentView : undefined}
          onclose={() => (filterSheetOpen = false)}
          initialTab={filterSheetInitialTab}
          {editingChannelId}
          {channelCreateMode}
          initialChannelType={channelCreateInitialType}
          oncreated={(id) => {
            filterSheetOpen = false;
            goto(channelPath(id));
          }}
          ondeleted={() => {
            filterSheetOpen = false;
            goto(FEEDS_PATH);
          }}
        />
      </BottomSheet>
    {/if}
  </div>
{/if}

<style>
  /* Full main-area width so the sticky header bar can span edge-to-edge; the
     reading content is re-centered by .feed-page-body below. */
  .feed-page {
    width: 100%;
  }

  .feed-page-body {
    max-width: 800px;
    margin: 0 auto;
  }

  /* Breathing room below the sticky divider so the first card — especially when
     highlighted — doesn't sit flush against the line. (Desktop only; the mobile
     layout has no header divider.) */
  @media (min-width: 1001px) {
    .feed-page-body {
      padding-top: 0.5rem;
    }
  }

  @media (max-width: 1000px) {
    .feed-page {
      padding-top: 0.5rem;
      padding-bottom: calc(var(--bottom-bar-height) + var(--safe-area-bottom) + 1rem);
    }
  }
</style>
