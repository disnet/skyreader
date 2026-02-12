<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { socialStore } from '$lib/stores/social.svelte';
  import { sharesStore } from '$lib/stores/shares.svelte';
  import { feedStatusStore } from '$lib/stores/feedStatus.svelte';
  import { articlesStore } from '$lib/stores/articles.svelte';
  import { activityStore } from '$lib/stores/activity.svelte';
  import { unreadCounts } from '$lib/stores/unreadCounts.svelte';
  import { filteredViewsStore } from '$lib/stores/filteredViews.svelte';
  import { feedViewStore } from '$lib/stores/feedView.svelte';
  import { fetchSingleFeed } from '$lib/services/feedFetcher';
  import { onMount, onDestroy } from 'svelte';
  import AddFeedModal from './AddFeedModal.svelte';
  import EditFeedModal from './EditFeedModal.svelte';
  import ContextMenu from './sidebar/ContextMenu.svelte';
  import UserContextMenu from './sidebar/UserContextMenu.svelte';
  import NavSection from './sidebar/NavSection.svelte';
  import FeedItem from './sidebar/FeedItem.svelte';
  import UserItem from './sidebar/UserItem.svelte';
  import ViewItem from './sidebar/ViewItem.svelte';
  import UserSearchCompact from './sidebar/UserSearchCompact.svelte';
  import FeedAddCompact from './sidebar/FeedAddCompact.svelte';
  import Icon from './Icon.svelte';
  import type { Subscription } from '$lib/types';

  // Set of DIDs that user is already following (for search)
  let followedDids = $derived(new Set(socialStore.followedUsers.map((u) => u.did)));

  async function handleFollowUser(did: string) {
    const success = await socialStore.followUser(did);
    if (success) {
      await socialStore.loadFollowedUsers();
    }
  }

  async function removeFeed(id: number) {
    if (confirm('Are you sure you want to remove this subscription?')) {
      await subscriptionsStore.remove(id);
    }
  }

  // Context menu state (feeds)
  let contextMenu = $state<{ x: number; y: number; feedId: number } | null>(null);
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let longPressTriggered = $state(false);

  // User context menu state
  let userContextMenu = $state<{ x: number; y: number; userDid: string } | null>(null);
  let userLongPressTimer: ReturnType<typeof setTimeout> | null = null;
  let userLongPressTriggered = $state(false);

  // Edit modal state
  let editingSubscription = $state<Subscription | null>(null);
  let editModalOpen = $state(false);

  function handleEditFeed(feedId: number) {
    const sub = subscriptionsStore.getById(feedId);
    if (sub) {
      editingSubscription = sub;
      editModalOpen = true;
    }
  }

  function closeEditModal() {
    editModalOpen = false;
    editingSubscription = null;
  }

  function handleContextMenu(e: MouseEvent, feedId: number) {
    e.preventDefault();
    contextMenu = { x: e.clientX, y: e.clientY, feedId };
  }

  function handleTouchStart(e: TouchEvent, feedId: number) {
    longPressTriggered = false;
    const touch = e.touches[0];
    longPressTimer = setTimeout(() => {
      longPressTriggered = true;
      contextMenu = { x: touch.clientX, y: touch.clientY, feedId };
    }, 500);
  }

  function handleTouchEnd(e: TouchEvent) {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    if (longPressTriggered) {
      e.preventDefault();
    }
  }

  function handleTouchMove() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  function closeContextMenu() {
    contextMenu = null;
  }

  // User context menu handlers
  function handleUserContextMenu(e: MouseEvent, userDid: string) {
    e.preventDefault();
    userContextMenu = { x: e.clientX, y: e.clientY, userDid };
  }

  function handleUserTouchStart(e: TouchEvent, userDid: string) {
    userLongPressTriggered = false;
    const touch = e.touches[0];
    userLongPressTimer = setTimeout(() => {
      userLongPressTriggered = true;
      userContextMenu = { x: touch.clientX, y: touch.clientY, userDid };
    }, 500);
  }

  function handleUserTouchEnd(e: TouchEvent) {
    if (userLongPressTimer) {
      clearTimeout(userLongPressTimer);
      userLongPressTimer = null;
    }
    if (userLongPressTriggered) {
      e.preventDefault();
    }
  }

  function handleUserTouchMove() {
    if (userLongPressTimer) {
      clearTimeout(userLongPressTimer);
      userLongPressTimer = null;
    }
  }

  function closeUserContextMenu() {
    userContextMenu = null;
  }

  async function handleUnfollowUser(userDid: string) {
    if (confirm('Are you sure you want to unfollow this user?')) {
      await socialStore.unfollowInApp(userDid);
    }
  }

  function handleClickOutside(e: MouseEvent) {
    if (contextMenu) {
      closeContextMenu();
    }
    if (userContextMenu) {
      closeUserContextMenu();
    }
    if (viewContextMenu) {
      closeViewContextMenu();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (contextMenu && e.key === 'Escape') {
      closeContextMenu();
    }
    if (userContextMenu && e.key === 'Escape') {
      closeUserContextMenu();
    }
    if (viewContextMenu && e.key === 'Escape') {
      closeViewContextMenu();
    }
  }

  onMount(() => {
    document.addEventListener('click', handleClickOutside);
    document.addEventListener('keydown', handleKeydown);

    // Load activity count if authenticated
    if (auth.isAuthenticated && !activityStore.hasLoadedInitial) {
      activityStore.loadReshareActivity();
    }
  });

  onDestroy(() => {
    document.removeEventListener('click', handleClickOutside);
    document.removeEventListener('keydown', handleKeydown);
    if (longPressTimer) clearTimeout(longPressTimer);
    if (userLongPressTimer) clearTimeout(userLongPressTimer);
    if (viewLongPressTimer) clearTimeout(viewLongPressTimer);
    document.body.classList.remove('sidebar-open-mobile');
  });

  // Lock body scroll when sidebar is open on mobile
  $effect(() => {
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    if (isMobile && sidebarStore.isOpen) {
      document.body.classList.add('sidebar-open-mobile');
    } else {
      document.body.classList.remove('sidebar-open-mobile');
    }
  });

  let feedUnreadCounts = $derived(unreadCounts.feedCounts);
  let totalUnread = $derived(unreadCounts.totalArticles);
  let sharerCounts = $derived(() => unreadCounts.sharerShareCounts);
  let sharerDocCounts = $derived(() => unreadCounts.sharerDocCounts);

  // Current filter from URL
  let currentFilter = $derived(() => {
    // Only show feed filters as active on the home page
    if ($page.url.pathname !== '/') {
      return { type: 'none' as const, contentType: null as 'shares' | 'documents' | null };
    }
    const view = $page.url.searchParams.get('view');
    const feed = $page.url.searchParams.get('feed');
    const starred = $page.url.searchParams.get('starred');
    const shared = $page.url.searchParams.get('shared');
    const sharer = $page.url.searchParams.get('sharer');
    const following = $page.url.searchParams.get('following');
    const feeds = $page.url.searchParams.get('feeds');
    const type = $page.url.searchParams.get('type') as 'shares' | 'documents' | null;
    if (view)
      return {
        type: 'view' as const,
        id: parseInt(view),
        contentType: null as 'shares' | 'documents' | null,
      };
    if (feed)
      return {
        type: 'feed' as const,
        id: parseInt(feed),
        contentType: null as 'shares' | 'documents' | null,
      };
    if (starred)
      return { type: 'starred' as const, contentType: null as 'shares' | 'documents' | null };
    if (shared)
      return { type: 'shared' as const, contentType: null as 'shares' | 'documents' | null };
    if (following) return { type: 'following' as const, contentType: type };
    if (sharer) return { type: 'sharer' as const, id: sharer, contentType: type };
    if (feeds)
      return { type: 'feeds' as const, contentType: null as 'shares' | 'documents' | null };
    return { type: 'all' as const, contentType: null as 'shares' | 'documents' | null };
  });

  // Sort and optionally filter subscriptions by unread count (descending)
  let sortedSubscriptions = $derived(() => {
    let subs = [...subscriptionsStore.subscriptions].sort((a, b) => {
      const countA = feedUnreadCounts.get(a.id!) || 0;
      const countB = feedUnreadCounts.get(b.id!) || 0;
      return countB - countA;
    });
    if (sidebarStore.showOnlyUnread.feeds) {
      subs = subs.filter((s) => (feedUnreadCounts.get(s.id!) || 0) > 0);
    }
    return subs;
  });

  // Sort followed users: all in-app follows, sorted by unread items (shares + documents) then by DID
  let sortedFollowedUsers = $derived(() => {
    const shareCounts = sharerCounts();
    const docCounts = sharerDocCounts();
    // Use inAppFollows which includes ALL users we follow on Skyreader (not just those with shares)
    let users = socialStore.inAppFollows
      .map((f) => ({ did: f.did, source: 'inapp' as const }))
      .sort((a, b) => {
        const countA = (shareCounts.get(a.did) || 0) + (docCounts.get(a.did) || 0);
        const countB = (shareCounts.get(b.did) || 0) + (docCounts.get(b.did) || 0);
        const hasUnreadA = countA > 0;
        const hasUnreadB = countB > 0;

        // Tier 1: accounts with unread items (shares or documents)
        if (hasUnreadA && !hasUnreadB) return -1;
        if (!hasUnreadA && hasUnreadB) return 1;

        // Within unread tier, sort by count descending
        if (hasUnreadA && hasUnreadB) {
          return countB - countA;
        }

        // Tier 2: by DID (stable sort - profiles are fetched async in UserItem)
        return a.did.localeCompare(b.did);
      });
    if (sidebarStore.showOnlyUnread.shared) {
      const totalCount = (did: string) => (shareCounts.get(did) || 0) + (docCounts.get(did) || 0);
      users = users.filter((u) => totalCount(u.did) > 0);
    }
    return users;
  });

  // Update sorted IDs in store for keyboard navigation
  $effect(() => {
    const sorted = sortedSubscriptions();
    const ids = sorted.map((s) => s.id!).filter((id) => id !== undefined);
    sidebarStore.setSortedFeedIds(ids);
  });

  $effect(() => {
    const sorted = sortedFollowedUsers();
    const dids = sorted.map((u) => u.did);
    sidebarStore.setSortedUserDids(dids);
  });

  // View context menu state
  let viewContextMenu = $state<{ x: number; y: number; viewId: number } | null>(null);
  let viewLongPressTimer: ReturnType<typeof setTimeout> | null = null;
  let viewLongPressTriggered = $state(false);
  let renamingViewId = $state<number | null>(null);

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
    if (confirm('Are you sure you want to delete this view?')) {
      await filteredViewsStore.remove(viewId);
    }
  }

  function selectFilter(type: string, id?: string | number, contentType?: 'shares' | 'documents') {
    const params = new URLSearchParams();
    if (type === 'view' && id) params.set('view', String(id));
    else if (type === 'feed' && id) params.set('feed', String(id));
    else if (type === 'starred') params.set('starred', 'true');
    else if (type === 'shared') params.set('shared', 'true');
    else if (type === 'following') {
      params.set('following', 'true');
      if (contentType) params.set('type', contentType);
    } else if (type === 'sharer' && id) {
      params.set('sharer', String(id));
      if (contentType) params.set('type', contentType);
    } else if (type === 'feeds') params.set('feeds', 'true');

    const query = params.toString();
    goto(query ? `/?${query}` : '/');

    // Close mobile sidebar after navigation
    sidebarStore.closeMobile();
  }

  function handleAddFeed(e: MouseEvent) {
    e.stopPropagation();
    sidebarStore.openAddFeedModal();
    sidebarStore.closeMobile();
  }

  function handleBackdropClick() {
    sidebarStore.closeMobile();
  }
</script>

<!-- Mobile backdrop -->
{#if sidebarStore.isOpen}
  <button class="sidebar-backdrop" onclick={handleBackdropClick} aria-label="Close sidebar"
  ></button>
{/if}

<aside class="sidebar" class:collapsed={sidebarStore.isCollapsed} class:open={sidebarStore.isOpen}>
  <!-- Header row -->
  <div class="sidebar-header">
    <a href="/settings" class="user-info" onclick={() => sidebarStore.closeMobile()}>
      {#if auth.user?.avatarUrl}
        <img src={auth.user.avatarUrl} alt="" class="avatar" />
      {:else}
        <div class="avatar-placeholder"></div>
      {/if}
      {#if !sidebarStore.isCollapsed}
        <span class="username">@{auth.user?.handle}</span>
      {/if}
    </a>
    <button class="add-feed-btn" onclick={handleAddFeed} aria-label="Add feed"> + </button>
  </div>

  <!-- Navigation items -->
  <nav class="sidebar-nav">
    <button
      class="nav-item"
      class:active={currentFilter().type === 'all'}
      onclick={() => selectFilter('all')}
    >
      <span class="nav-icon"><Icon name="inbox" /></span>
      {#if !sidebarStore.isCollapsed}
        <span class="nav-label">All</span>
        {#if totalUnread > 0}
          <span class="nav-count">{totalUnread}</span>
        {/if}
      {/if}
    </button>

    <button
      class="nav-item"
      class:active={currentFilter().type === 'starred'}
      onclick={() => selectFilter('starred')}
    >
      <span class="nav-icon"><Icon name="star" /></span>
      {#if !sidebarStore.isCollapsed}
        <span class="nav-label">Later</span>
      {/if}
    </button>

    <button
      class="nav-item"
      class:active={currentFilter().type === 'shared'}
      onclick={() => selectFilter('shared')}
    >
      <span class="nav-icon"><Icon name="share" /></span>
      {#if !sidebarStore.isCollapsed}
        <span class="nav-label">Shared</span>
        {#if sharesStore.userShares.size > 0}
          <span class="nav-count">{sharesStore.userShares.size}</span>
        {/if}
      {/if}
    </button>

    <a
      href="/discover"
      class="nav-item nav-link"
      class:active={$page.url.pathname === '/discover'}
      onclick={() => sidebarStore.closeMobile()}
    >
      <span class="nav-icon"><Icon name="search" /></span>
      {#if !sidebarStore.isCollapsed}
        <span class="nav-label">Discover</span>
      {/if}
    </a>

    <a
      href="/activity"
      class="nav-item nav-link"
      class:active={$page.url.pathname === '/activity'}
      onclick={() => sidebarStore.closeMobile()}
    >
      <span class="nav-icon"><Icon name="bell" /></span>
      {#if !sidebarStore.isCollapsed}
        <span class="nav-label">Activity</span>
        {#if activityStore.totalReshareCount > 0}
          <span class="nav-count">{activityStore.totalReshareCount}</span>
        {/if}
      {/if}
    </a>

    <a
      href="/settings"
      class="nav-item nav-link"
      class:active={$page.url.pathname === '/settings'}
      onclick={() => sidebarStore.closeMobile()}
    >
      <span class="nav-icon"><Icon name="settings" /></span>
      {#if !sidebarStore.isCollapsed}
        <span class="nav-label">Settings</span>
      {/if}
    </a>

    <a
      href="https://github.com/disnet/skyreader/issues"
      class="nav-item nav-link"
      target="_blank"
      rel="noopener noreferrer"
    >
      <span class="nav-icon"><Icon name="message-circle" /></span>
      {#if !sidebarStore.isCollapsed}
        <span class="nav-label">Feedback</span>
      {/if}
    </a>

    <!-- Views section -->
    {#if filteredViewsStore.views.length > 0 || !sidebarStore.isCollapsed}
      <NavSection
        title="Views"
        isExpanded={sidebarStore.expandedSections.views}
        isCollapsed={sidebarStore.isCollapsed}
        showOnlyUnread={false}
        isActive={false}
        onToggle={() => sidebarStore.toggleSection('views')}
        onLabelClick={() => sidebarStore.toggleSection('views')}
        onUnreadToggle={() => {}}
      >
        {@const filter = currentFilter()}
        {#each filteredViewsStore.views as view (view.id)}
          <ViewItem
            {view}
            isActive={filter.type === 'view' && filter.id === view.id}
            isRenaming={renamingViewId === view.id}
            onSelect={() => selectFilter('view', view.id)}
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
        <button
          class="add-view-btn"
          onclick={async (e) => {
            e.stopPropagation();
            const id = await filteredViewsStore.create({
              name: 'new view',
              sourceMode: 'include',
              sourceKeys: [],
              readFilter: 'unread',
              sortOrder: 'newest',
            });
            selectFilter('view', id);
            feedViewStore.setFilterToolbarOpen(true);
            feedViewStore.setSourcePopoverOpen(true);
          }}
        >
          <Icon name="plus" size={14} />
          <span>New View</span>
        </button>
      </NavSection>
    {/if}

    <!-- Following section -->
    <NavSection
      title="Following"
      isExpanded={sidebarStore.expandedSections.shared}
      isCollapsed={sidebarStore.isCollapsed}
      showOnlyUnread={sidebarStore.showOnlyUnread.shared}
      isActive={$page.url.pathname === '/following'}
      onToggle={() => sidebarStore.toggleSection('shared')}
      onLabelClick={() => {
        goto('/following');
        sidebarStore.closeMobile();
      }}
      onUnreadToggle={() => sidebarStore.toggleShowOnlyUnread('shared')}
    >
      {@const totalShareCount = Array.from(sharerCounts().values()).reduce((a, b) => a + b, 0)}
      {@const totalDocCount = Array.from(sharerDocCounts().values()).reduce((a, b) => a + b, 0)}
      {@const filter = currentFilter()}
      <UserSearchCompact {followedDids} onFollow={handleFollowUser} />
      {@const allUsers = sortedFollowedUsers()}
      {@const displayedUsers = allUsers.slice(0, 10)}
      {#each displayedUsers as user (user.did)}
        {@const shareCount = sharerCounts().get(user.did) || 0}
        {@const docCount = sharerDocCounts().get(user.did) || 0}
        {@const filter = currentFilter()}
        <UserItem
          {user}
          {shareCount}
          documentCount={docCount}
          isActive={filter.type === 'sharer' && filter.id === user.did}
          contentType={filter.type === 'sharer' && filter.id === user.did
            ? filter.contentType
            : null}
          onSelect={() => selectFilter('sharer', user.did)}
          onSelectShares={() => selectFilter('sharer', user.did, 'shares')}
          onSelectDocuments={() => selectFilter('sharer', user.did, 'documents')}
          onContextMenu={(e) => handleUserContextMenu(e, user.did)}
          onTouchStart={(e) => handleUserTouchStart(e, user.did)}
          onTouchEnd={handleUserTouchEnd}
          onTouchMove={handleUserTouchMove}
          onMoreClick={(e) => handleUserContextMenu(e, user.did)}
        />
      {:else}
        <div class="empty-section">No followed users</div>
      {/each}
      {#if allUsers.length > 10}
        <div class="more-indicator">...</div>
      {/if}
    </NavSection>

    <!-- Feeds section -->
    <NavSection
      title="Feeds"
      isExpanded={sidebarStore.expandedSections.feeds}
      isCollapsed={sidebarStore.isCollapsed}
      showOnlyUnread={sidebarStore.showOnlyUnread.feeds}
      isActive={currentFilter().type === 'feeds'}
      onToggle={() => sidebarStore.toggleSection('feeds')}
      onLabelClick={() => selectFilter('feeds')}
      onUnreadToggle={() => sidebarStore.toggleShowOnlyUnread('feeds')}
    >
      <FeedAddCompact />
      {#each sortedSubscriptions() as sub (sub.id)}
        {@const count = feedUnreadCounts.get(sub.id!) || 0}
        {@const status = feedStatusStore.getStatus(sub.feedUrl)}
        {@const loadingState =
          status?.status === 'pending'
            ? 'loading'
            : status?.status === 'error' || status?.status === 'circuit-open'
              ? 'error'
              : undefined}
        {@const feedError = feedStatusStore.getStatusMessage(sub.feedUrl)}
        {@const errorDetails = feedStatusStore.getErrorDetails(sub.feedUrl)}
        <FeedItem
          subscription={sub}
          unreadCount={count}
          isActive={currentFilter().type === 'feed' && currentFilter().id === sub.id}
          {loadingState}
          errorMessage={feedError || undefined}
          {errorDetails}
          onSelect={() => selectFilter('feed', sub.id)}
          onContextMenu={(e) => sub.id && handleContextMenu(e, sub.id)}
          onTouchStart={(e) => sub.id && handleTouchStart(e, sub.id)}
          onTouchEnd={handleTouchEnd}
          onTouchMove={handleTouchMove}
          onRetry={() => fetchSingleFeed(sub, true, articlesStore.starredGuids)}
          onMoreClick={(e) => sub.id && handleContextMenu(e, sub.id)}
        />
      {:else}
        <div class="empty-section">No subscriptions</div>
      {/each}
    </NavSection>
  </nav>
</aside>

<AddFeedModal
  open={sidebarStore.addFeedModalOpen}
  onclose={() => sidebarStore.closeAddFeedModal()}
/>

{#if contextMenu}
  {@const feedId = contextMenu.feedId}
  <ContextMenu
    x={contextMenu.x}
    y={contextMenu.y}
    onEdit={() => handleEditFeed(feedId)}
    onDelete={() => removeFeed(feedId)}
    onClose={closeContextMenu}
  />
{/if}

{#if userContextMenu}
  {@const userDid = userContextMenu.userDid}
  <UserContextMenu
    x={userContextMenu.x}
    y={userContextMenu.y}
    onUnfollow={() => handleUnfollowUser(userDid)}
    onClose={closeUserContextMenu}
  />
{/if}

<EditFeedModal open={editModalOpen} subscription={editingSubscription} onclose={closeEditModal} />

{#if viewContextMenu}
  {@const viewId = viewContextMenu.viewId}
  <ContextMenu
    x={viewContextMenu.x}
    y={viewContextMenu.y}
    onRename={() => handleRenameView(viewId)}
    onDelete={() => handleDeleteView(viewId)}
    onClose={closeViewContextMenu}
  />
{/if}

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

  .sidebar {
    position: sticky;
    top: 0;
    height: 100vh;
    width: var(--sidebar-width, 260px);
    flex-shrink: 0;
    background: var(--color-bg);
    display: flex;
    flex-direction: column;
    z-index: 50;
    transition: width 0.2s ease;
    overflow-y: auto;
    padding: 0 0.5rem;
  }

  .sidebar.collapsed {
    width: var(--sidebar-collapsed-width, 60px);
  }

  .sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 0;
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

  .user-info:hover {
    background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
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
    font-size: 0.875rem;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .add-feed-btn {
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.5rem 0.75rem;
    color: var(--color-text-secondary);
    font-size: 1.25rem;
    line-height: 1;
    flex-shrink: 0;
    border-radius: 12px;
    transition: background-color 0.15s;
  }

  .add-feed-btn:hover {
    color: var(--color-primary);
    background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
  }

  .sidebar-nav {
    flex: 1;
    padding: 0.5rem 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
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

  .nav-item:hover {
    background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
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
    font-size: 0.875rem;
  }

  .nav-count {
    flex-shrink: 0;
    font-size: 0.75rem;
    color: var(--color-text-secondary);
  }

  .nav-item.active .nav-count {
    color: var(--color-primary);
  }

  .empty-section {
    padding: 0.5rem 1.5rem;
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
    font-style: italic;
  }

  .more-indicator {
    padding: 0.25rem 1.5rem;
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
  }

  .add-view-btn {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.375rem 1.5rem;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text-secondary);
    font-size: 0.8125rem;
    border-radius: 8px;
    transition: background-color 0.15s;
  }

  .add-view-btn:hover {
    background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
    color: var(--color-primary);
  }

  /* Mobile styles */
  @media (max-width: 768px) {
    .sidebar-backdrop {
      display: none;
    }

    .sidebar {
      position: fixed;
      left: 0;
      top: 0;
      width: 100% !important;
      height: 100%;
      transform: translateX(-100%);
      transition: transform 0.25s ease-out;
    }

    .sidebar.open {
      transform: translateX(0);
    }
  }

  @media (prefers-color-scheme: dark) {
    .nav-item:hover {
      background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
    }
  }
</style>
