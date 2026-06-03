<script lang="ts">
  import { onMount, onDestroy, tick, untrack } from 'svelte';
  import { page } from '$app/stores';
  import { auth } from '$lib/stores/auth.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { linkblogStore } from '$lib/stores/linkblog.svelte';
  import { myLinkblogStore } from '$lib/stores/myLinkblog.svelte';
  import { preferences } from '$lib/stores/preferences.svelte';
  import { feedViewStore } from '$lib/stores/feedView.svelte';
  import { unreadCounts } from '$lib/stores/unreadCounts.svelte';
  import { filteredViewsStore } from '$lib/stores/filteredViews.svelte';
  import { appManager } from '$lib/stores/app.svelte';
  import { articlesStore } from '$lib/stores/articles.svelte';
  import { viewTitleStore } from '$lib/stores/viewTitle.svelte';
  import { profileService } from '$lib/services/profiles';
  import { api, ScopeUpgradeError } from '$lib/services/api';
  import { syncQueue, type IntegrationPayload } from '$lib/services/sync-queue';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import LibraryEmptyState from '$lib/components/LibraryEmptyState.svelte';
  import LoadingState from '$lib/components/LoadingState.svelte';
  import WelcomePage from '$lib/components/feed/WelcomePage.svelte';
  import FeedPageHeader from '$lib/components/feed/FeedPageHeader.svelte';
  import FeedListView from '$lib/components/feed/FeedListView.svelte';
  import SavedListView from '$lib/components/feed/SavedListView.svelte';
  import EditFeedModal from '$lib/components/EditFeedModal.svelte';
  import MobileBottomBar from '$lib/components/feed/MobileBottomBar.svelte';
  import MobileFeedSwitcher from '$lib/components/feed/MobileFeedSwitcher.svelte';
  import MobileFilterSheet from '$lib/components/feed/MobileFilterSheet.svelte';
  import PullToRefresh from '$lib/components/PullToRefresh.svelte';
  import CollectionPicker, {
    type CollectionSelection,
  } from '$lib/components/CollectionPicker.svelte';

  import BottomSheet from '$lib/components/common/BottomSheet.svelte';
  import { useScrollDirection } from '$lib/hooks/useScrollDirection.svelte';
  import { mobileStore } from '$lib/stores/mediaQuery.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { syncStore } from '$lib/stores/sync.svelte';
  import type { Subscription, BlueskyProfile } from '$lib/types';
  import { useScrollMarkAsRead } from '$lib/hooks/useScrollMarkAsRead.svelte';
  import { useFeedKeyboardShortcuts } from '$lib/hooks/useFeedKeyboardShortcuts.svelte';
  import { goto } from '$app/navigation';
  import LinkblogIntro from '$lib/components/feed/LinkblogIntro.svelte';

  // `linkblog` renders the current user's own linkblog (their shared documents)
  // through the same feed UI as the main feed.
  let { mode = 'feed' }: { mode?: 'feed' | 'linkblog' } = $props();

  // Scroll-hide state (shared by desktop header + mobile bottom bar)
  const scrollDirection = useScrollDirection({
    onHide: () => feedViewStore.setFilterToolbarOpen(false),
  });
  let feedSwitcherOpen = $state(false);
  let filterSheetOpen = $state(false);
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

  // Integration collection picker state
  let collectionPickerOpen = $state(false);
  let collectionPickerIntegration = $state<'semble' | 'margin'>('semble');
  let pendingIntegrationData = $state<{
    url: string;
    title?: string;
    description?: string;
    author?: string;
    publishedAt?: string;
  } | null>(null);

  function handleSaveToSemble(data: {
    url: string;
    title?: string;
    description?: string;
    author?: string;
    publishedAt?: string;
  }) {
    pendingIntegrationData = data;
    collectionPickerIntegration = 'semble';
    collectionPickerOpen = true;
  }

  function handleSaveToMargin(data: { url: string; title?: string; description?: string }) {
    pendingIntegrationData = data;
    collectionPickerIntegration = 'margin';
    collectionPickerOpen = true;
  }

  async function handleCollectionSelected(selection: CollectionSelection[]) {
    collectionPickerOpen = false;
    const data = pendingIntegrationData;
    if (!data) return;
    pendingIntegrationData = null;

    const integrationType = collectionPickerIntegration;
    const isMargin = integrationType === 'margin';
    const label = isMargin ? 'Margin' : 'Semble';

    const payload: IntegrationPayload = {
      type: integrationType,
      url: data.url,
      title: data.title,
      description: data.description,
      author: data.author,
      publishedAt: data.publishedAt,
      collections: selection,
    };

    const savedSuffix =
      selection.length > 0
        ? ` (${selection.length} collection${selection.length === 1 ? '' : 's'})`
        : '';

    if (syncStore.isOnline) {
      const id = toastStore.add(`Saving to ${label}...`);
      try {
        if (isMargin) {
          await api.createMarginBookmark({
            url: data.url,
            title: data.title,
            description: data.description,
            collectionUris: selection.map((c) => c.uri),
          });
        } else {
          await api.createSembleCard({
            ...data,
            collections: selection,
          });
        }
        toastStore.update(id, 'success', `Saved to ${label}${savedSuffix}`);
      } catch (err) {
        if (err instanceof ScopeUpgradeError) {
          toastStore.update(id, 'error', 'Please log in again to grant integration permissions');
          return;
        }
        console.error(`Failed to save to ${label}, queueing:`, err);
        await syncQueue.enqueue('create', 'integration', data.url, payload);
        toastStore.update(id, 'success', `Queued save to ${label}`);
      }
    } else {
      await syncQueue.enqueue('create', 'integration', data.url, payload);
      const id = toastStore.add(`Queued save to ${label}`);
      toastStore.update(id, 'success');
    }
  }

  function handleCollectionPickerClose() {
    collectionPickerOpen = false;
    pendingIntegrationData = null;
  }

  function scrollToTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
      saved: url.searchParams.get('saved'),
      sharer: url.searchParams.get('sharer'),
      following: url.searchParams.get('following'),
      feeds: null,
      contentType,
      view: url.searchParams.get('view'),
      category: url.searchParams.get('category'),
    };
    untrack(() => feedViewStore.setFilters(filters));
  });

  // Tab visibility state
  let lastVisibleTime = $state(Date.now());
  const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

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
    if (mode === 'linkblog') return 'Your Linkblog';
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
    return 'Everything';
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

    await itemLabelsStore.markAllAsRead(articlesToMark);
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
      promises.push(itemLabelsStore.markAllAsRead(articlesToMark));
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
      goto('/');
    }
  }

  async function handleVisibilityChange() {
    if (document.visibilityState === 'visible' && auth.isAuthenticated) {
      // Check if data is actually stale using persisted lastRefreshAt
      if (appManager.isStale(STALE_THRESHOLD_MS)) {
        console.log('Data is stale, refreshing...');
        await appManager.refreshFromBackend();
        feedViewStore.clearReadThisSession();
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

  onDestroy(() => {
    if (mode === 'linkblog') {
      feedViewStore.setMyLinkblogMode(false);
    }
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  });
</script>

<EditFeedModal open={editModalOpen} subscription={editingSubscription} onclose={closeEditModal} />
<CollectionPicker
  open={collectionPickerOpen}
  integration={collectionPickerIntegration}
  onselect={handleCollectionSelected}
  onclose={handleCollectionPickerClose}
/>

{#if !auth.isAuthenticated}
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
        controlsVisible={scrollDirection.controlsVisible}
        onToggleExpandAll={(value) => {
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

    {#if mode === 'linkblog'}
      <LinkblogIntro />
    {/if}

    <PullToRefresh
      onRefresh={handleRefreshWithToast}
      disabled={!syncStore.isOnline || appManager.isRefreshing}
    >
      {#if (appManager.isHydrating || appManager.isRefreshing || (mode === 'linkblog' && myLinkblogStore.loading && !myLinkblogStore.loaded)) && feedViewStore.currentItems.length === 0}
        <LoadingState />
      {:else if !isSavedView && feedViewStore.currentItems.length === 0}
        {#if mode === 'linkblog'}
          {#if feedViewStore.showOnlyUnread}
            <EmptyState title="No unread posts" description="You're all caught up." />
          {:else}
            <EmptyState
              title="No shares yet"
              description="Share an article from your feed and it'll appear here — and on your public page."
            />
          {/if}
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
            <EmptyState title="No unread posts" description="You're all caught up on this person" />
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
          <LibraryEmptyState onAddFeed={() => sidebarStore.openAddFeedModal()} />
        {:else if feedViewStore.showOnlyUnread}
          <EmptyState title="No unread articles" description="You're all caught up!" />
        {:else}
          <EmptyState
            title="No articles"
            description="Your feeds haven't published anything yet. Check back later."
          />
        {/if}
      {:else if isSavedView}
        <SavedListView
          bind:this={savedListView}
          onReaderChange={(open) => (readerOpen = open)}
          onSaveToSemble={handleSaveToSemble}
          onSaveToMargin={handleSaveToMargin}
        />
      {:else}
        <FeedListView
          bind:this={feedListView}
          onToggleSave={(article) =>
            itemLabelsStore.toggleSave(article.guid, 'article', article.url, article.title, {
              type: 'article',
              guid: article.guid,
              url: article.url,
              title: article.title,
              author: article.author,
              summary: article.summary,
              imageUrl: article.imageUrl,
              publishedAt: article.publishedAt,
            })}
          onShare={(article, _sub, note) => linkblogStore.shareLink(article, note)}
          onUnshare={(url) => linkblogStore.unshare(url)}
          onReaderChange={(open) => (readerOpen = open)}
          onSaveToSemble={handleSaveToSemble}
          onSaveToMargin={handleSaveToMargin}
        />
      {/if}
    </PullToRefresh>

    {#if mobileStore.isMobile && !readerOpen}
      <MobileBottomBar
        controlsVisible={scrollDirection.controlsVisible}
        currentTitle={pageTitle}
        onScrollToTop={scrollToTop}
        onOpenFeedSwitcher={() => (feedSwitcherOpen = true)}
        onOpenFilterSheet={() => {
          filterSheetInitialTab = 'filters';
          editingChannelId = feedViewStore.activeFilteredView?.id ?? null;
          channelCreateMode = false;
          filterSheetOpen = true;
        }}
        {hasActiveFilters}
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
            goto(`/?view=${id}`);
          }}
          ondeleted={() => {
            filterSheetOpen = false;
            goto('/');
          }}
        />
      </BottomSheet>
    {/if}
  </div>
{/if}

<style>
  .feed-page {
    max-width: 800px;
    margin: 0 auto;
    padding-top: 3.5rem;
  }

  @media (max-width: 1000px) {
    .feed-page {
      padding-top: 0.5rem;
      padding-bottom: calc(var(--bottom-bar-height) + var(--safe-area-bottom) + 1rem);
    }
  }
</style>
