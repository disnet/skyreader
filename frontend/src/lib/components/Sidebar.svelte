<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { channelPath, feedPath, categoryPath, FEEDS_PATH, SAVED_PATH } from '$lib/utils/viewNav';
  import { auth } from '$lib/stores/auth.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { articlesStore } from '$lib/stores/articles.svelte';
  import { unreadCounts } from '$lib/stores/unreadCounts.svelte';
  import { filteredViewsStore } from '$lib/stores/filteredViews.svelte';
  import { feedViewStore } from '$lib/stores/feedView.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { highlightReviewStore } from '$lib/stores/highlightReview.svelte';
  import { syncAutoRuleChannels } from '$lib/stores/channelAutoUpdate.svelte';
  import { onMount, onDestroy } from 'svelte';
  import AddFeedModal from './AddFeedModal.svelte';
  import EditFeedModal from './EditFeedModal.svelte';
  import type { Subscription } from '$lib/types';
  import AddHandleModal from './AddHandleModal.svelte';
  import SaveArticleModal from './SaveArticleModal.svelte';
  import FilteredViewModal from './FilteredViewModal.svelte';
  import AddSourceInput from './AddSourceInput.svelte';
  import NavSection from './sidebar/NavSection.svelte';
  import ViewItem from './sidebar/ViewItem.svelte';
  import ContextMenu from './sidebar/ContextMenu.svelte';
  import FeedItem from './sidebar/FeedItem.svelte';
  import Icon from './Icon.svelte';
  import NotificationBell from './NotificationBell.svelte';
  import { feedStatusStore } from '$lib/stores/feedStatus.svelte';
  import { fetchSingleFeed } from '$lib/services/feedFetcher';
  import { preferences } from '$lib/stores/preferences.svelte';

  function handleFeedContextMenu(e: MouseEvent, feedId: number) {
    e.preventDefault();
    feedContextMenu = { x: e.clientX, y: e.clientY, feedId };
  }

  function closeFeedContextMenu() {
    feedContextMenu = null;
  }

  function handleEditFeed(feedId: number) {
    const sub = subscriptionsStore.subscriptions.find((s) => s.id === feedId);
    if (sub) editingSubscription = sub;
  }

  async function handleUnsubscribeFeed(feedId: number) {
    if (confirm('Are you sure you want to unsubscribe from this feed?')) {
      await subscriptionsStore.remove(feedId);
      // If we're currently viewing this feed, navigate away
      if (currentFilter().type === 'feed' && currentFilter().id === feedId) {
        selectFilter('all');
      }
    }
  }

  function handleClickOutside(e: MouseEvent) {
    if (viewContextMenu) {
      closeViewContextMenu();
    }
    if (feedContextMenu) {
      closeFeedContextMenu();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (viewContextMenu) closeViewContextMenu();
      if (feedContextMenu) closeFeedContextMenu();
    }
  }

  onMount(() => {
    document.addEventListener('click', handleClickOutside);
    document.addEventListener('keydown', handleKeydown);
  });

  onDestroy(() => {
    document.removeEventListener('click', handleClickOutside);
    document.removeEventListener('keydown', handleKeydown);
    if (viewLongPressTimer) clearTimeout(viewLongPressTimer);
    document.body.classList.remove('sidebar-open-mobile');
  });

  // Lock body scroll when sidebar is open on mobile
  $effect(() => {
    const isMobile = window.matchMedia('(max-width: 1000px)').matches;
    if (isMobile && sidebarStore.isOpen) {
      document.body.classList.add('sidebar-open-mobile');
    } else {
      document.body.classList.remove('sidebar-open-mobile');
    }
  });

  // Auto-update channels with autoRules when subscriptions change
  $effect(() => {
    // Access subscriptions to trigger reactivity
    subscriptionsStore.subscriptions;
    syncAutoRuleChannels();
  });

  let totalUnread = $derived(unreadCounts.totalArticles + unreadCounts.totalSocial);

  // Current filter from URL. Feed filters are active on /feeds, saved on /saved;
  // a channel (?view=) can live under either base depending on its mode.
  let currentFilter = $derived(() => {
    const path = $page.url.pathname;
    const sp = $page.url.searchParams;
    const view = sp.get('view');
    if (path === FEEDS_PATH) {
      const feed = sp.get('feed');
      const category = sp.get('category');
      if (view) return { type: 'view' as const, id: view };
      if (feed) return { type: 'feed' as const, id: parseInt(feed) };
      if (category) return { type: 'category' as const, name: category };
      return { type: 'all' as const };
    }
    if (path === SAVED_PATH) {
      if (view) return { type: 'view' as const, id: view };
      return { type: 'saved' as const };
    }
    return { type: 'none' as const };
  });

  // View context menu state
  let viewContextMenu = $state<{ x: number; y: number; viewId: number } | null>(null);

  // Feed context menu state
  let feedContextMenu = $state<{ x: number; y: number; feedId: number } | null>(null);
  let editingSubscription = $state<Subscription | null>(null);
  let viewLongPressTimer: ReturnType<typeof setTimeout> | null = null;
  let viewLongPressTriggered = $state(false);
  let renamingViewId = $state<number | null>(null);

  // Channel create/edit modal (via sidebarStore)
  let channelModalOpen = $derived(sidebarStore.channelModalOpen);
  let editingChannelId = $derived(sidebarStore.editingChannelId);

  function openChannelModal(
    viewId: number | null = null,
    initialType: 'feed' | 'saved' | null = null
  ) {
    sidebarStore.openChannelModal(viewId, initialType);
  }

  function handleViewContextMenu(e: MouseEvent, viewId: number) {
    e.preventDefault();
    viewContextMenu = { x: e.clientX, y: e.clientY, viewId };
  }

  function handleViewTouchStart(e: TouchEvent, viewId: number) {
    viewLongPressTriggered = false;
    const touch = e.touches[0];
    viewLongPressTimer = setTimeout(() => {
      viewLongPressTriggered = true;
      viewContextMenu = { x: touch.clientX, y: touch.clientY, viewId };
    }, 500);
  }

  function handleViewTouchEnd(e: TouchEvent) {
    if (viewLongPressTimer) {
      clearTimeout(viewLongPressTimer);
      viewLongPressTimer = null;
    }
    if (viewLongPressTriggered) {
      e.preventDefault();
    }
  }

  function handleViewTouchMove() {
    if (viewLongPressTimer) {
      clearTimeout(viewLongPressTimer);
      viewLongPressTimer = null;
    }
  }

  function closeViewContextMenu() {
    viewContextMenu = null;
  }

  function handleRenameView(viewId: number) {
    renamingViewId = viewId;
  }

  async function handleDeleteView(viewId: number) {
    if (confirm('Are you sure you want to delete this channel?')) {
      await filteredViewsStore.remove(viewId);
    }
  }

  function selectFilter(type: string, id?: string | number) {
    let url: string = FEEDS_PATH;
    if (type === 'view' && id != null) url = channelPath(id);
    else if (type === 'feed' && id != null) url = feedPath(id);
    else if (type === 'category' && id != null) url = categoryPath(String(id));
    else if (type === 'saved') url = SAVED_PATH;

    goto(url);

    // Close mobile sidebar after navigation
    sidebarStore.closeMobile();
  }

  // Group subscriptions by category for the Sources section
  interface CategoryGroup {
    name: string;
    subscriptions: typeof subscriptionsStore.subscriptions;
    unreadCount: number;
  }

  function sourceSortRank(sub: Subscription): number {
    if (!sub.sourceType || sub.sourceType === 'rss') return 0;
    if (sub.sourceType === 'atproto.documents' && sub.feedUrl?.startsWith('at://')) return 2;
    if (sub.sourceType === 'atproto.documents') return 3;
    return 4;
  }

  function sortSources(sources: typeof subscriptionsStore.subscriptions) {
    return [...sources].sort((a, b) => {
      const rankDiff = sourceSortRank(a) - sourceSortRank(b);
      if (rankDiff !== 0) return rankDiff;
      return (a.customTitle || a.title || '').localeCompare(
        b.customTitle || b.title || '',
        undefined,
        {
          sensitivity: 'base',
        }
      );
    });
  }

  let sourceCategories = $derived.by((): CategoryGroup[] => {
    const byCategory = new Map<string, typeof subscriptionsStore.subscriptions>();
    for (const sub of subscriptionsStore.subscriptions) {
      if (sub.category) {
        const existing = byCategory.get(sub.category) || [];
        existing.push(sub);
        byCategory.set(sub.category, existing);
      }
    }
    return [...byCategory.entries()]
      .map(([name, subs]) => ({
        name,
        subscriptions: sortSources(subs),
        unreadCount: subs.reduce(
          (sum, s) => sum + (s.id ? (unreadCounts.feedCounts.get(s.id) ?? 0) : 0),
          0
        ),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  let uncategorizedSources = $derived(
    sortSources(subscriptionsStore.subscriptions.filter((s) => !s.category))
  );

  // Split channels: source channels live under Everything, saved channels under Saved
  let sourceChannels = $derived(filteredViewsStore.views.filter((v) => v.mode !== 'saved'));
  let savedChannels = $derived(filteredViewsStore.views.filter((v) => v.mode === 'saved'));

  function handleBackdropClick() {
    sidebarStore.closeMobile();
  }
</script>

<!-- Mobile backdrop -->
{#if sidebarStore.isOpen}
  <button class="sidebar-backdrop" onclick={handleBackdropClick} aria-label="Close sidebar"
  ></button>
{/if}

<aside class="sidebar" class:open={sidebarStore.isOpen}>
  <!-- Header row -->
  <div class="sidebar-header">
    <a href="/settings" class="user-info" onclick={() => sidebarStore.closeMobile()}>
      {#if auth.user?.avatarUrl}
        <img src={auth.user.avatarUrl} alt="" class="avatar" />
      {:else}
        <div class="avatar-placeholder"></div>
      {/if}
      <span class="username">@{auth.user?.handle}</span>
      {#if auth.user?.tier && auth.user.tier !== 'free'}
        <span class="tier-badge">{auth.user.tier}</span>
      {/if}
    </a>
    <!-- Grouped, so `space-between` puts the handle at one end and this pair at
         the other. Left as three children it spaced all three evenly and the
         bell floated into the middle of the row. -->
    <div class="header-actions">
      <NotificationBell />
      <AddSourceInput />
    </div>
  </div>

  <!-- Navigation items -->
  <nav class="sidebar-nav">
    <!-- Home: the default landing surface (a route, not a feed filter) -->
    <a
      href="/home"
      class="nav-item nav-link"
      class:active={$page.url.pathname === '/home'}
      onclick={() => sidebarStore.closeMobile()}
    >
      <span class="nav-icon"><Icon name="home" /></span>
      <span class="nav-label">Home</span>
    </a>

    <!-- Everything: top-level filter + nested source channels -->
    <div class="nav-group" class:expanded={sidebarStore.expandedSections.everything}>
      <div class="nav-row" class:active={currentFilter().type === 'all'}>
        <button class="nav-row-main" onclick={() => selectFilter('all')}>
          <span class="nav-icon"><Icon name="inbox" /></span>
          <span class="nav-label">Feeds</span>
        </button>
        <button
          class="row-add-btn"
          onclick={(e) => {
            e.stopPropagation();
            openChannelModal(null, 'feed');
          }}
          title="New channel"
        >
          <Icon name="plus" size={14} strokeWidth={2} />
        </button>
        {#if totalUnread > 0}
          <span class="nav-count">{totalUnread}</span>
        {/if}
        <button
          class="row-disclosure-btn"
          onclick={(e) => {
            e.stopPropagation();
            sidebarStore.toggleSection('everything');
          }}
          aria-label="Toggle channels"
        >
          <Icon
            name={sidebarStore.expandedSections.everything ? 'chevron-down' : 'chevron-right'}
            size={14}
            strokeWidth={2.5}
          />
        </button>
      </div>
      {#if sidebarStore.expandedSections.everything}
        <div class="nav-children">
          {#each sourceChannels as view (view.uuid)}
            <ViewItem
              {view}
              isActive={currentFilter().type === 'view' && currentFilter().id === view.uuid}
              isRenaming={renamingViewId === view.id}
              unreadCount={view.id != null ? (unreadCounts.channelCounts.get(view.id) ?? 0) : 0}
              onSelect={() => selectFilter('view', view.uuid)}
              onContextMenu={(e) => view.id != null && handleViewContextMenu(e, view.id)}
              onTouchStart={(e) => view.id != null && handleViewTouchStart(e, view.id)}
              onTouchEnd={handleViewTouchEnd}
              onTouchMove={handleViewTouchMove}
              onMoreClick={(e) => view.id != null && handleViewContextMenu(e, view.id)}
              onRename={async (name) => {
                if (view.id != null) {
                  await filteredViewsStore.update(view.id, { name });
                }
                renamingViewId = null;
              }}
              onRenameCancel={() => (renamingViewId = null)}
            />
          {/each}
          {#if sourceChannels.length === 0}
            <div class="empty-section">No channels yet</div>
          {/if}
          <a
            href="/channels/discover"
            class="more-suggestions-link"
            onclick={() => sidebarStore.closeMobile()}
          >
            More channel ideas
            <Icon name="arrow-right" size={12} />
          </a>
        </div>
      {/if}
    </div>

    <!-- Saved: top-level filter + nested saved channels -->
    <div class="nav-group" class:expanded={sidebarStore.expandedSections.saved}>
      <div class="nav-row" class:active={currentFilter().type === 'saved'}>
        <button class="nav-row-main" onclick={() => selectFilter('saved')}>
          <span class="nav-icon"><Icon name="bookmark" /></span>
          <span class="nav-label">Saved</span>
        </button>
        <button
          class="row-add-btn"
          onclick={(e) => {
            e.stopPropagation();
            openChannelModal(null, 'saved');
          }}
          title="New saved channel"
        >
          <Icon name="plus" size={14} strokeWidth={2} />
        </button>
        {#if itemLabelsStore.inboxCount > 0}
          <span class="nav-count">{itemLabelsStore.inboxCount}</span>
        {/if}
        <button
          class="row-disclosure-btn"
          onclick={(e) => {
            e.stopPropagation();
            sidebarStore.toggleSection('saved');
          }}
          aria-label="Toggle saved channels"
        >
          <Icon
            name={sidebarStore.expandedSections.saved ? 'chevron-down' : 'chevron-right'}
            size={14}
            strokeWidth={2.5}
          />
        </button>
      </div>
      {#if sidebarStore.expandedSections.saved}
        <div class="nav-children">
          {#each savedChannels as view (view.uuid)}
            <ViewItem
              {view}
              isActive={currentFilter().type === 'view' && currentFilter().id === view.uuid}
              isRenaming={renamingViewId === view.id}
              unreadCount={view.id != null ? (unreadCounts.channelCounts.get(view.id) ?? 0) : 0}
              onSelect={() => selectFilter('view', view.uuid)}
              onContextMenu={(e) => view.id != null && handleViewContextMenu(e, view.id)}
              onTouchStart={(e) => view.id != null && handleViewTouchStart(e, view.id)}
              onTouchEnd={handleViewTouchEnd}
              onTouchMove={handleViewTouchMove}
              onMoreClick={(e) => view.id != null && handleViewContextMenu(e, view.id)}
              onRename={async (name) => {
                if (view.id != null) {
                  await filteredViewsStore.update(view.id, { name });
                }
                renamingViewId = null;
              }}
              onRenameCancel={() => (renamingViewId = null)}
            />
          {/each}
          {#if savedChannels.length === 0}
            <div class="empty-section">No saved channels yet</div>
          {/if}
          <a
            href="/channels/discover"
            class="more-suggestions-link"
            onclick={() => sidebarStore.closeMobile()}
          >
            More channel ideas
            <Icon name="arrow-right" size={12} />
          </a>
        </div>
      {/if}
    </div>

    <!-- Bottom nav. The linkblog entry hides once the user deletes their
         linkblog; the rest of the nav is unrelated to it and always shows. -->
    {#if !preferences.linkblogDisabled}
      <a
        href="/linkblog"
        class="nav-item nav-link"
        class:active={$page.url.pathname === '/linkblog'}
        onclick={() => sidebarStore.closeMobile()}
      >
        <span class="nav-icon"><Icon name="share" /></span>
        <span class="nav-label">Linkblog</span>
      </a>
    {/if}

    <a
      href="/highlights"
      class="nav-item nav-link"
      class:active={$page.url.pathname === '/highlights'}
      onclick={() => sidebarStore.closeMobile()}
    >
      <span class="nav-icon"><Icon name="highlighter" /></span>
      <span class="nav-label">Highlights</span>
    </a>

    <!-- Review: its own destination, not a mode of /highlights. The count is
         today's deck and disappears when the deck is done — a badge you clear by
         reading, never a streak. Hidden entirely until there's a corpus. -->
    {#if highlightReviewStore.hasHighlights}
      <a
        href="/highlights/review"
        class="nav-item nav-link"
        class:active={$page.url.pathname === '/highlights/review'}
        onclick={() => sidebarStore.closeMobile()}
      >
        <span class="nav-icon"><Icon name="quote" /></span>
        <span class="nav-label">Review</span>
        {#if highlightReviewStore.dueCount > 0}
          <span class="nav-count">{highlightReviewStore.dueCount}</span>
        {/if}
      </a>
    {/if}

    <a
      href="/discover"
      class="nav-item nav-link"
      class:active={$page.url.pathname === '/discover'}
      onclick={() => sidebarStore.closeMobile()}
    >
      <span class="nav-icon"><Icon name="users" /></span>
      <span class="nav-label">Discover</span>
    </a>

    <a
      href="/sources"
      class="nav-item nav-link"
      class:active={$page.url.pathname === '/sources'}
      onclick={() => sidebarStore.closeMobile()}
    >
      <span class="nav-icon"><Icon name="rss" /></span>
      <span class="nav-label">Manage Sources</span>
    </a>

    <a
      href="/settings"
      class="nav-item nav-link"
      class:active={$page.url.pathname === '/settings'}
      onclick={() => sidebarStore.closeMobile()}
    >
      <span class="nav-icon"><Icon name="settings" /></span>
      <span class="nav-label">Settings</span>
    </a>

    <!-- Sources section -->
    <div class="sources-separator"></div>
    <NavSection
      title="Sources"
      icon="rss"
      isExpanded={sidebarStore.expandedSections.feeds}
      showOnlyUnread={sidebarStore.showOnlyUnread.feeds}
      isActive={false}
      onToggle={() => sidebarStore.toggleSection('feeds')}
      onLabelClick={() => sidebarStore.toggleSection('feeds')}
      onUnreadToggle={() => sidebarStore.toggleShowOnlyUnread('feeds')}
    >
      {#if sourceCategories.length > 0 || uncategorizedSources.length > 0}
        {#each sourceCategories as cat (cat.name)}
          <div class="category-group">
            <div class="category-header">
              <button
                class="category-expand-btn"
                onclick={() => sidebarStore.toggleCategory(cat.name)}
                aria-label={sidebarStore.isCategoryExpanded(cat.name) ? 'Collapse' : 'Expand'}
              >
                <Icon
                  name={sidebarStore.isCategoryExpanded(cat.name)
                    ? 'chevron-down'
                    : 'chevron-right'}
                  size={12}
                  strokeWidth={2.5}
                />
              </button>
              <button
                class="category-name-btn"
                class:active={currentFilter().type === 'category' &&
                  currentFilter().name === cat.name}
                onclick={() => selectFilter('category', cat.name)}
              >
                <Icon name="folder" size={14} />
                <span class="category-label">{cat.name}</span>
              </button>
              {#if cat.unreadCount > 0}
                <span class="category-count">{cat.unreadCount}</span>
              {/if}
            </div>
            {#if sidebarStore.isCategoryExpanded(cat.name)}
              <div class="category-items">
                {#each cat.subscriptions as sub (sub.rkey)}
                  {@const feedUrl = sub.feedUrl ?? ''}
                  {@const status = feedStatusStore.getStatus(feedUrl)}
                  {@const hasError =
                    status?.status === 'error' || status?.status === 'circuit-open'}
                  {@const subUnread = sub.id ? (unreadCounts.feedCounts.get(sub.id) ?? 0) : 0}
                  {#if !sidebarStore.showOnlyUnread.feeds || subUnread > 0}
                    <FeedItem
                      subscription={sub}
                      unreadCount={subUnread}
                      isActive={currentFilter().type === 'feed' && currentFilter().id === sub.id}
                      {hasError}
                      errorMessage={status?.errorMessage ?? ''}
                      errorDetails={feedStatusStore.getErrorDetails(feedUrl)}
                      onSelect={() => sub.id && selectFilter('feed', sub.id)}
                      onContextMenu={(e) => sub.id && handleFeedContextMenu(e, sub.id)}
                      onTouchStart={() => {}}
                      onTouchEnd={() => {}}
                      onTouchMove={() => {}}
                      onRetry={() => fetchSingleFeed(sub, true, articlesStore.savedGuids)}
                      onMoreClick={(e) => sub.id && handleFeedContextMenu(e, sub.id)}
                    />
                  {/if}
                {/each}
              </div>
            {/if}
          </div>
        {/each}
        {#each uncategorizedSources as sub (sub.rkey)}
          {@const feedUrl = sub.feedUrl ?? ''}
          {@const status = feedStatusStore.getStatus(feedUrl)}
          {@const hasError = status?.status === 'error' || status?.status === 'circuit-open'}
          {@const subUnread = sub.id ? (unreadCounts.feedCounts.get(sub.id) ?? 0) : 0}
          {#if !sidebarStore.showOnlyUnread.feeds || subUnread > 0}
            <FeedItem
              subscription={sub}
              unreadCount={subUnread}
              isActive={currentFilter().type === 'feed' && currentFilter().id === sub.id}
              {hasError}
              errorMessage={status?.errorMessage ?? ''}
              errorDetails={feedStatusStore.getErrorDetails(feedUrl)}
              onSelect={() => sub.id && selectFilter('feed', sub.id)}
              onContextMenu={(e) => sub.id && handleFeedContextMenu(e, sub.id)}
              onTouchStart={() => {}}
              onTouchEnd={() => {}}
              onTouchMove={() => {}}
              onRetry={() => fetchSingleFeed(sub, true, articlesStore.savedGuids)}
              onMoreClick={(e) => sub.id && handleFeedContextMenu(e, sub.id)}
            />
          {/if}
        {/each}
      {:else}
        <div class="empty-section">No sources yet</div>
      {/if}
    </NavSection>
  </nav>
</aside>

<AddFeedModal
  open={sidebarStore.addFeedModalOpen}
  onclose={() => sidebarStore.closeAddFeedModal()}
  initialValue={sidebarStore.addSourceInitialValue}
/>

<AddHandleModal
  open={sidebarStore.addHandleModalOpen}
  onclose={() => sidebarStore.closeAddHandleModal()}
  initialValue={sidebarStore.addSourceInitialValue}
/>

<SaveArticleModal
  open={sidebarStore.saveArticleModalOpen}
  onclose={() => sidebarStore.closeSaveArticleModal()}
/>

<FilteredViewModal
  open={channelModalOpen}
  editingViewId={editingChannelId}
  initialChannelType={sidebarStore.initialChannelType}
  onclose={() => sidebarStore.closeChannelModal()}
  oncreated={(id) => selectFilter('view', id)}
  ondeleted={() => selectFilter('all')}
/>

{#if viewContextMenu}
  {@const viewId = viewContextMenu.viewId}
  <ContextMenu
    x={viewContextMenu.x}
    y={viewContextMenu.y}
    onEdit={() => openChannelModal(viewId)}
    onRename={() => handleRenameView(viewId)}
    onDelete={() => handleDeleteView(viewId)}
    onClose={closeViewContextMenu}
  />
{/if}

{#if feedContextMenu}
  <ContextMenu
    x={feedContextMenu.x}
    y={feedContextMenu.y}
    onEdit={() => handleEditFeed(feedContextMenu!.feedId)}
    onDelete={() => handleUnsubscribeFeed(feedContextMenu!.feedId)}
    onClose={closeFeedContextMenu}
    deleteLabel="Unsubscribe"
  />
{/if}

<EditFeedModal
  open={editingSubscription !== null}
  subscription={editingSubscription}
  onclose={() => (editingSubscription = null)}
/>

<style>
  .sidebar-backdrop {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 40;
    border: none;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  /* In the framed shell the rail sits directly on the ground colour — no
     surface of its own, no border. Its grid cell already gives it width and
     height, so it fills that rather than sticking to the viewport. Below the
     shell breakpoint it reverts to an opaque full-screen drawer (see the
     max-width block at the end of this file). */
  .sidebar {
    position: relative;
    height: 100%;
    width: var(--sidebar-width, 260px);
    flex-shrink: 0;
    background: transparent;
    display: flex;
    flex-direction: column;
    z-index: 50;
    transition: width 0.2s ease;
    overflow-y: auto;
    padding: 0 0.5rem 0.5rem;
  }

  .sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 0;
    flex-shrink: 0;
  }

  /* In the framed shell this row *is* the head of the frame — it sits in the
     toolbar strip's row, opposite the page's control bar, so it takes the same
     height and centres on the same line. The account then reads as the first
     item in the rail rather than as a caption above it, which is why the avatar
     drops to the nav icons' width: at 1.25rem the handle starts exactly where
     every nav label below it does. */
  @media (min-width: 1001px) {
    .sidebar-header {
      /* Right padding only, matching .nav-row's: it lands the add button's
         edge on the disclosure chevrons below, the way the avatar lands on the
         nav icons. The left side needs none — .user-info carries its own. */
      padding: 0 0.75rem 0 0;
      min-height: var(--shell-bar-height);
    }

    /* Scoped to the header so these win over the rules further down the file,
       wherever this block ends up sitting. The gap matches .nav-item's, which
       is the other half of landing the handle on the nav labels' edge. */
    .sidebar-header .user-info {
      gap: 0.75rem;
    }

    .sidebar-header .avatar,
    .sidebar-header .avatar-placeholder {
      width: 1.25rem;
      height: 1.25rem;
    }
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    flex-shrink: 0;
  }

  .user-info {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    text-decoration: none;
    color: var(--color-text);
    min-width: 0;
    padding: 0.5rem 0.75rem;
    border-radius: 12px;
    transition: background-color 0.15s;
  }

  @media (hover: hover) {
    .user-info:hover {
      background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
    }
  }

  .avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .avatar-placeholder {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--color-border);
    flex-shrink: 0;
  }

  .username {
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tier-badge {
    font-size: var(--text-3xs);
    font-weight: var(--weight-semibold);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wide);
    padding: 0.1rem 0.35rem;
    border-radius: 4px;
    background-color: var(--color-primary, #3b82f6);
    color: #fff;
    flex-shrink: 0;
    line-height: 1.2;
  }

  /* One rhythm for every top-level entry. Expanded groups used to add 8px of
     their own on top of the row gap, to keep two adjacent tinted blocks from
     merging — which made the Feeds/Saved seam the one uneven gap in the list.
     The gap that separation needs is now simply the gap, so the tint no longer
     has a say in the spacing. Nested rows (.nav-children) stay tighter: inside
     a group, closer means subordinate. */
  .sidebar-nav {
    flex: 1;
    padding: 0.5rem 0;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.5rem 0.75rem;
    background: none;
    border: none;
    border-radius: 12px;
    cursor: pointer;
    text-align: left;
    font: inherit;
    color: var(--color-text);
    transition: background-color 0.15s;
  }

  .nav-group {
    border-radius: 12px;
    transition: background-color 0.15s;
  }

  .nav-group.expanded {
    background-color: rgba(0, 0, 0, 0.025);
    padding-bottom: 0.25rem;
  }

  .nav-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.5rem 0.75rem;
    border-radius: 12px;
    color: var(--color-text);
    transition: background-color 0.15s;
  }

  @media (hover: hover) {
    .nav-row:hover {
      background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
    }
  }

  .nav-row.active {
    background-color: var(--color-sidebar-active, rgba(0, 102, 204, 0.1));
    color: var(--color-primary);
  }

  .nav-row-main {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex: 1;
    min-width: 0;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    font: inherit;
    color: inherit;
    padding: 0;
  }

  .nav-row.active .nav-count {
    color: var(--color-primary);
  }

  .row-add-btn,
  .row-disclosure-btn {
    flex-shrink: 0;
    width: 1.25rem;
    height: 1.25rem;
    background: none;
    border: none;
    cursor: pointer;
    padding: 0;
    color: var(--color-text-secondary);
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
  }

  .row-add-btn {
    opacity: 0.6;
    transition: opacity 0.15s;
  }

  @media (hover: hover) {
    .row-add-btn {
      opacity: 0;
    }

    .nav-row:hover .row-add-btn {
      opacity: 0.6;
    }

    .row-add-btn:hover {
      opacity: 1 !important;
      color: var(--color-primary);
    }

    .row-disclosure-btn:hover {
      color: var(--color-text);
    }
  }

  .nav-row.active .row-disclosure-btn {
    color: var(--color-primary);
  }

  .nav-children {
    margin-top: 0.25rem;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  @media (hover: hover) {
    .nav-item:hover {
      background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
    }
  }

  .nav-link {
    text-decoration: none;
  }

  .nav-item.active {
    background-color: var(--color-sidebar-active, rgba(0, 102, 204, 0.1));
    color: var(--color-primary);
  }

  .nav-icon {
    flex-shrink: 0;
    width: 1.25rem;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .nav-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-md);
  }

  .nav-count {
    flex-shrink: 0;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .nav-item.active .nav-count {
    color: var(--color-primary);
  }

  .sources-separator {
    height: 1px;
    background: var(--color-border);
    margin: 0.75rem 0.75rem;
  }

  .empty-section {
    padding: 0.5rem 0.75rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    font-style: italic;
  }

  .more-suggestions-link {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.75rem;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    text-decoration: none;
    transition: color 0.15s;
  }

  @media (hover: hover) {
    .more-suggestions-link:hover {
      color: var(--color-primary);
    }
  }

  .category-group {
    margin-bottom: 2px;
  }

  .category-items {
    padding-left: 1.25rem;
  }

  .category-header {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.375rem 0.5rem;
    border-radius: 8px;
  }

  .category-expand-btn {
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.125rem;
    color: var(--color-text-secondary);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .category-name-btn {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: 1;
    min-width: 0;
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.125rem 0.25rem;
    border-radius: 6px;
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-text-secondary);
    transition:
      color 0.15s,
      background-color 0.15s;
  }

  @media (hover: hover) {
    .category-name-btn:hover {
      color: var(--color-text);
      background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
    }
  }

  .category-name-btn.active {
    color: var(--color-primary);
    background-color: var(--color-sidebar-active, rgba(0, 102, 204, 0.1));
  }

  .category-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .category-count {
    flex-shrink: 0;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    padding-right: 0.25rem;
  }

  .nav-separator {
    height: 0.5rem;
  }

  /* Mobile styles */
  @media (max-width: 1000px) {
    .sidebar-backdrop {
      display: none;
    }

    .sidebar {
      position: fixed;
      left: 0;
      top: 0;
      width: 100% !important;
      height: 100%;
      /* The drawer floats over the page, so unlike the framed rail it needs
         its own opaque surface. */
      background: var(--color-bg);
      transform: translateX(-100%);
      transition: transform 0.25s ease-out;
    }

    .sidebar.open {
      transform: translateX(0);
    }
  }

  @media (hover: hover) and (prefers-color-scheme: dark) {
    .nav-item:hover {
      background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
    }

    .nav-row:hover {
      background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
    }
  }

  @media (prefers-color-scheme: dark) {
    .nav-group.expanded {
      background-color: rgba(255, 255, 255, 0.025);
    }
  }
</style>
