<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { sharesStore } from '$lib/stores/shares.svelte';
  import { articlesStore } from '$lib/stores/articles.svelte';
  import { activityStore } from '$lib/stores/activity.svelte';
  import { unreadCounts } from '$lib/stores/unreadCounts.svelte';
  import { filteredViewsStore } from '$lib/stores/filteredViews.svelte';
  import { feedViewStore } from '$lib/stores/feedView.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { channelSuggestions } from '$lib/stores/channelSuggestions.svelte';
  import { savedChannelSuggestions } from '$lib/stores/savedChannelSuggestions.svelte';
  import type { SavedChannelSuggestion } from '$lib/stores/savedChannelSuggestions.svelte';
  import { syncAutoRuleChannels } from '$lib/stores/channelAutoUpdate.svelte';
  import { onMount, onDestroy } from 'svelte';
  import AddFeedModal from './AddFeedModal.svelte';
  import AddHandleModal from './AddHandleModal.svelte';
  import SaveArticleModal from './SaveArticleModal.svelte';
  import FilteredViewModal from './FilteredViewModal.svelte';
  import AddSourceInput from './AddSourceInput.svelte';
  import NavSection from './sidebar/NavSection.svelte';
  import ViewItem from './sidebar/ViewItem.svelte';
  import ContextMenu from './sidebar/ContextMenu.svelte';
  import FeedItem from './sidebar/FeedItem.svelte';
  import Icon from './Icon.svelte';
  import Tooltip from './Tooltip.svelte';
  import { feedStatusStore } from '$lib/stores/feedStatus.svelte';
  import { fetchSingleFeed } from '$lib/services/feedFetcher';

  function handleClickOutside(e: MouseEvent) {
    if (viewContextMenu) {
      closeViewContextMenu();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
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

  // Current filter from URL
  let currentFilter = $derived(() => {
    // Only show feed filters as active on the home page
    if ($page.url.pathname !== '/') {
      return { type: 'none' as const };
    }
    const view = $page.url.searchParams.get('view');
    const feed = $page.url.searchParams.get('feed');
    const starred = $page.url.searchParams.get('saved');
    const shared = $page.url.searchParams.get('shared');
    const category = $page.url.searchParams.get('category');
    if (view) return { type: 'view' as const, id: view };
    if (feed) return { type: 'feed' as const, id: parseInt(feed) };
    if (category) return { type: 'category' as const, name: category };
    if (starred) return { type: 'saved' as const };
    if (shared) return { type: 'shared' as const };
    return { type: 'all' as const };
  });

  // View context menu state
  let viewContextMenu = $state<{ x: number; y: number; viewId: number } | null>(null);
  let viewLongPressTimer: ReturnType<typeof setTimeout> | null = null;
  let viewLongPressTriggered = $state(false);
  let renamingViewId = $state<number | null>(null);

  // Channel create/edit modal (via sidebarStore)
  let channelModalOpen = $derived(sidebarStore.channelModalOpen);
  let editingChannelId = $derived(sidebarStore.editingChannelId);

  function openChannelModal(viewId: number | null = null) {
    sidebarStore.openChannelModal(viewId);
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

  async function acceptSuggestion(suggestion: (typeof channelSuggestions.suggestions)[0]) {
    const id = await filteredViewsStore.create({
      name: suggestion.name,
      sourceMode: suggestion.sourceMode,
      sourceKeys: suggestion.sourceKeys,
      typeFilter: suggestion.typeFilter.length > 0 ? suggestion.typeFilter : undefined,
      autoRule: suggestion.autoRule,
      readFilter: 'unread',
      sortOrder: 'newest',
    });
    selectFilter('view', id);
  }

  async function acceptSavedSuggestion(suggestion: SavedChannelSuggestion) {
    const id = await filteredViewsStore.create({
      name: suggestion.name,
      mode: 'saved',
      savedSourceFilter: suggestion.savedSourceFilter,
      savedDomainFilter: suggestion.savedDomainFilter,
      savedReadingLength: suggestion.savedReadingLength,
      savedDateFilter: suggestion.savedDateFilter,
      readFilter: suggestion.readFilter ?? 'all',
      sortOrder: suggestion.sortOrder ?? 'newest',
    });
    selectFilter('view', id);
  }

  function selectFilter(type: string, id?: string | number) {
    const params = new URLSearchParams();
    if (type === 'view' && id) params.set('view', String(id));
    else if (type === 'feed' && id) params.set('feed', String(id));
    else if (type === 'category' && id) params.set('category', String(id));
    else if (type === 'saved') params.set('saved', 'true');
    else if (type === 'shared') params.set('shared', 'true');

    const query = params.toString();
    goto(query ? `/?${query}` : '/');

    // Close mobile sidebar after navigation
    sidebarStore.closeMobile();
  }

  // Group subscriptions by category for the Sources section
  interface CategoryGroup {
    name: string;
    subscriptions: typeof subscriptionsStore.subscriptions;
    unreadCount: number;
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
        subscriptions: subs,
        unreadCount: subs.reduce(
          (sum, s) => sum + (s.id ? (unreadCounts.feedCounts.get(s.id) ?? 0) : 0),
          0
        ),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  let uncategorizedSources = $derived(subscriptionsStore.subscriptions.filter((s) => !s.category));

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
    <AddSourceInput />
  </div>

  <!-- Navigation items -->
  <nav class="sidebar-nav">
    <button
      class="nav-item"
      class:active={currentFilter().type === 'all'}
      onclick={() => selectFilter('all')}
    >
      <span class="nav-icon"><Icon name="inbox" /></span>
      <span class="nav-label">Everything</span>
      {#if totalUnread > 0}
        <span class="nav-count">{totalUnread}</span>
      {/if}
    </button>

    <button
      class="nav-item"
      class:active={currentFilter().type === 'saved'}
      onclick={() => selectFilter('saved')}
    >
      <span class="nav-icon"><Icon name="bookmark" /></span>
      <span class="nav-label">Saved</span>
      {#if itemLabelsStore.inboxCount > 0}
        <span class="nav-count">{itemLabelsStore.inboxCount}</span>
      {/if}
    </button>

    <!-- Channels section (formerly Views) -->
    <NavSection
      title="Channels"
      icon="layers"
      isExpanded={sidebarStore.expandedSections.channels}
      showOnlyUnread={false}
      isActive={false}
      onToggle={() => sidebarStore.toggleSection('channels')}
      onLabelClick={() => sidebarStore.toggleSection('channels')}
      onAdd={() => openChannelModal()}
    >
      {#each filteredViewsStore.views as view (view.uuid)}
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
      {:else}
        {#if channelSuggestions.suggestions.length === 0 && savedChannelSuggestions.suggestions.length === 0}
          <div class="empty-section">No channels yet</div>
        {/if}
      {/each}
      {#each channelSuggestions.suggestions as suggestion (suggestion.id)}
        <div class="suggestion-item">
          <button class="suggestion-accept" onclick={() => acceptSuggestion(suggestion)}>
            <span class="suggestion-icon"><Icon name="plus" size={12} /></span>
            <span class="suggestion-name">{suggestion.name}</span>
          </button>
          <Tooltip text={suggestion.description} />
          <button
            class="suggestion-dismiss"
            onclick={(e) => {
              e.stopPropagation();
              channelSuggestions.dismiss(suggestion.id);
            }}
            title="Dismiss"
          >
            <Icon name="x" size={12} />
          </button>
        </div>
      {/each}
      {#each savedChannelSuggestions.suggestions as suggestion (suggestion.id)}
        <div class="suggestion-item">
          <button class="suggestion-accept" onclick={() => acceptSavedSuggestion(suggestion)}>
            <span class="suggestion-icon"><Icon name="plus" size={12} /></span>
            <span class="suggestion-name">{suggestion.name}</span>
          </button>
          <Tooltip text={suggestion.description} />
          <button
            class="suggestion-dismiss"
            onclick={(e) => {
              e.stopPropagation();
              savedChannelSuggestions.dismiss(suggestion.id);
            }}
            title="Dismiss"
          >
            <Icon name="x" size={12} />
          </button>
        </div>
      {/each}
      {#if channelSuggestions.hasMore || channelSuggestions.suggestions.length > 0 || savedChannelSuggestions.hasMore || savedChannelSuggestions.suggestions.length > 0}
        <a
          href="/channels/discover"
          class="more-suggestions-link"
          onclick={() => sidebarStore.closeMobile()}
        >
          More channel ideas
          <Icon name="arrow-right" size={12} />
        </a>
      {/if}
    </NavSection>

    <button
      class="nav-item"
      class:active={currentFilter().type === 'shared'}
      onclick={() => selectFilter('shared')}
    >
      <span class="nav-icon"><Icon name="share" /></span>
      <span class="nav-label">Shared</span>
      {#if sharesStore.userShares.size > 0}
        <span class="nav-count">{sharesStore.userShares.size}</span>
      {/if}
    </button>

    <!-- Bottom nav -->
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
      href="/activity"
      class="nav-item nav-link"
      class:active={$page.url.pathname === '/activity'}
      onclick={() => sidebarStore.closeMobile()}
    >
      <span class="nav-icon"><Icon name="bell" /></span>
      <span class="nav-label">Activity</span>
      {#if activityStore.totalReshareCount > 0}
        <span class="nav-count">{activityStore.totalReshareCount}</span>
      {/if}
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
                  {@const loadingState = !feedUrl
                    ? 'ready'
                    : status?.status === 'error' || status?.status === 'circuit-open'
                      ? 'error'
                      : status?.status === 'pending'
                        ? 'loading'
                        : 'ready'}
                  {@const subUnread = sub.id ? (unreadCounts.feedCounts.get(sub.id) ?? 0) : 0}
                  {#if !sidebarStore.showOnlyUnread.feeds || subUnread > 0}
                    <FeedItem
                      subscription={sub}
                      unreadCount={subUnread}
                      isActive={currentFilter().type === 'feed' && currentFilter().id === sub.id}
                      {loadingState}
                      errorMessage={status?.errorMessage ?? ''}
                      errorDetails={feedStatusStore.getErrorDetails(feedUrl)}
                      onSelect={() => sub.id && selectFilter('feed', sub.id)}
                      onContextMenu={() => {}}
                      onTouchStart={() => {}}
                      onTouchEnd={() => {}}
                      onTouchMove={() => {}}
                      onRetry={() => fetchSingleFeed(sub, true, articlesStore.savedGuids)}
                      onMoreClick={() => {}}
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
          {@const loadingState = !feedUrl
            ? 'ready'
            : status?.status === 'error' || status?.status === 'circuit-open'
              ? 'error'
              : status?.status === 'pending'
                ? 'loading'
                : 'ready'}
          {@const subUnread = sub.id ? (unreadCounts.feedCounts.get(sub.id) ?? 0) : 0}
          {#if !sidebarStore.showOnlyUnread.feeds || subUnread > 0}
            <FeedItem
              subscription={sub}
              unreadCount={subUnread}
              isActive={currentFilter().type === 'feed' && currentFilter().id === sub.id}
              {loadingState}
              errorMessage={status?.errorMessage ?? ''}
              errorDetails={feedStatusStore.getErrorDetails(feedUrl)}
              onSelect={() => sub.id && selectFilter('feed', sub.id)}
              onContextMenu={() => {}}
              onTouchStart={() => {}}
              onTouchEnd={() => {}}
              onTouchMove={() => {}}
              onRetry={() => fetchSingleFeed(sub, true, articlesStore.savedGuids)}
              onMoreClick={() => {}}
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

  .tier-badge {
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    padding: 0.1rem 0.35rem;
    border-radius: 4px;
    background-color: var(--color-primary, #3b82f6);
    color: #fff;
    flex-shrink: 0;
    line-height: 1.2;
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

  .sources-separator {
    height: 1px;
    background: var(--color-border);
    margin: 0.75rem 0.75rem;
  }

  .empty-section {
    padding: 0.5rem 0.75rem;
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
    font-style: italic;
  }

  .suggestion-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
  }

  .suggestion-accept {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    background: none;
    border: none;
    cursor: pointer;
    padding: 0;
    color: var(--color-text-secondary);
    font: inherit;
    font-size: 0.875rem;
    text-align: left;
    transition: color 0.15s;
  }

  .suggestion-accept:hover {
    color: var(--color-primary);
  }

  .suggestion-icon {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 1px dashed currentColor;
  }

  .suggestion-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }

  .more-suggestions-link {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.75rem;
    font-size: 0.75rem;
    color: var(--color-text-secondary);
    text-decoration: none;
    transition: color 0.15s;
  }

  .more-suggestions-link:hover {
    color: var(--color-primary);
  }

  .suggestion-dismiss {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text-secondary);
    padding: 0;
    opacity: 0;
    transition: opacity 0.15s;
    border-radius: 4px;
  }

  .suggestion-item:hover .suggestion-dismiss {
    opacity: 0.6;
  }

  .suggestion-dismiss:hover {
    opacity: 1 !important;
    color: var(--color-text);
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
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--color-text-secondary);
    transition:
      color 0.15s,
      background-color 0.15s;
  }

  .category-name-btn:hover {
    color: var(--color-text);
    background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
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
    font-size: 0.75rem;
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
