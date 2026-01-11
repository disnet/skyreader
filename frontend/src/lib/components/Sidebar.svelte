<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { readingStore } from '$lib/stores/reading.svelte';
  import { socialStore } from '$lib/stores/social.svelte';

  let feedUnreadCounts = $state<Map<number, number>>(new Map());

  // Calculate total unread
  let totalUnread = $derived(
    Array.from(feedUnreadCounts.values()).reduce((a, b) => a + b, 0)
  );

  // Group shares by author for counts
  let sharerCounts = $derived(() => {
    const counts = new Map<string, number>();
    for (const share of socialStore.shares) {
      counts.set(share.authorDid, (counts.get(share.authorDid) || 0) + 1);
    }
    return counts;
  });

  // Current filter from URL
  let currentFilter = $derived(() => {
    const feed = $page.url.searchParams.get('feed');
    const starred = $page.url.searchParams.get('starred');
    const sharer = $page.url.searchParams.get('sharer');
    if (feed) return { type: 'feed' as const, id: parseInt(feed) };
    if (starred) return { type: 'starred' as const };
    if (sharer) return { type: 'sharer' as const, id: sharer };
    return { type: 'all' as const };
  });

  // Sort and optionally filter subscriptions by unread count (descending)
  let sortedSubscriptions = $derived(() => {
    let subs = [...subscriptionsStore.subscriptions].sort((a, b) => {
      const countA = feedUnreadCounts.get(a.id!) || 0;
      const countB = feedUnreadCounts.get(b.id!) || 0;
      return countB - countA;
    });
    if (sidebarStore.showOnlyUnread.feeds) {
      subs = subs.filter(s => (feedUnreadCounts.get(s.id!) || 0) > 0);
    }
    return subs;
  });

  // Sort and optionally filter followed users by share count (descending)
  let sortedFollowedUsers = $derived(() => {
    const counts = sharerCounts();
    let users = [...socialStore.followedUsers].sort((a, b) => {
      const countA = counts.get(a.did) || 0;
      const countB = counts.get(b.did) || 0;
      return countB - countA;
    });
    if (sidebarStore.showOnlyUnread.shared) {
      users = users.filter(u => (counts.get(u.did) || 0) > 0);
    }
    return users;
  });

  // Load unread counts when subscriptions change
  $effect(() => {
    loadUnreadCounts();
  });

  async function loadUnreadCounts() {
    const counts = new Map<number, number>();
    for (const sub of subscriptionsStore.subscriptions) {
      if (sub.id) {
        counts.set(sub.id, await readingStore.getUnreadCount(sub.id));
      }
    }
    feedUnreadCounts = counts;
  }

  function selectFilter(type: string, id?: string | number) {
    const params = new URLSearchParams();
    if (type === 'feed' && id) params.set('feed', String(id));
    else if (type === 'starred') params.set('starred', 'true');
    else if (type === 'sharer' && id) params.set('sharer', String(id));

    const query = params.toString();
    goto(query ? `/?${query}` : '/');

    // Close mobile sidebar after navigation
    sidebarStore.closeMobile();
  }

  function handleAddFeed(e: MouseEvent) {
    e.stopPropagation();
    goto('/feeds');
    sidebarStore.closeMobile();
  }

  function handleBackdropClick() {
    sidebarStore.closeMobile();
  }
</script>

<!-- Mobile backdrop -->
{#if sidebarStore.isOpen}
  <button class="sidebar-backdrop" onclick={handleBackdropClick} aria-label="Close sidebar"></button>
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
    <button class="toggle-btn" onclick={() => sidebarStore.toggle()} aria-label="Toggle sidebar">
      {#if sidebarStore.isCollapsed}
        <span class="toggle-icon">›</span>
      {:else}
        <span class="toggle-icon">‹</span>
      {/if}
    </button>
  </div>

  <!-- Navigation items -->
  <nav class="sidebar-nav">
    <button
      class="nav-item"
      class:active={currentFilter().type === 'all'}
      onclick={() => selectFilter('all')}
    >
      <span class="nav-icon">&#x2709;</span>
      {#if !sidebarStore.isCollapsed}
        <span class="nav-label">All Unread</span>
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
      <span class="nav-icon">&#x2606;</span>
      {#if !sidebarStore.isCollapsed}
        <span class="nav-label">Starred</span>
      {/if}
    </button>

    <!-- Shared section -->
    <div class="nav-section">
      <div class="section-header">
        <button class="section-toggle" onclick={() => sidebarStore.toggleSection('shared')}>
          <span class="disclosure">{sidebarStore.expandedSections.shared ? '▼' : '▶'}</span>
          {#if !sidebarStore.isCollapsed}
            <span class="section-label">Shared</span>
          {/if}
        </button>
        {#if !sidebarStore.isCollapsed}
          <button
            class="filter-toggle"
            class:active={sidebarStore.showOnlyUnread.shared}
            onclick={(e) => { e.stopPropagation(); sidebarStore.toggleShowOnlyUnread('shared'); }}
            title={sidebarStore.showOnlyUnread.shared ? 'Show all' : 'Show only with shares'}
          >
            {sidebarStore.showOnlyUnread.shared ? '●' : '○'}
          </button>
        {/if}
      </div>
      {#if sidebarStore.expandedSections.shared && !sidebarStore.isCollapsed}
        <div class="section-items">
          {#each sortedFollowedUsers() as user (user.did)}
            {@const count = sharerCounts().get(user.did) || 0}
            <button
              class="nav-item sub-item"
              class:active={currentFilter().type === 'sharer' && currentFilter().id === user.did}
              onclick={() => selectFilter('sharer', user.did)}
            >
              {#if user.avatarUrl}
                <img src={user.avatarUrl} alt="" class="small-avatar" />
              {:else}
                <div class="small-avatar-placeholder"></div>
              {/if}
              <span class="nav-label">{user.displayName || user.handle}</span>
              {#if count > 0}
                <span class="nav-count">{count}</span>
              {/if}
            </button>
          {:else}
            <div class="empty-section">No followed users</div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Feeds section -->
    <div class="nav-section">
      <div class="section-header">
        <button class="section-toggle" onclick={() => sidebarStore.toggleSection('feeds')}>
          <span class="disclosure">{sidebarStore.expandedSections.feeds ? '▼' : '▶'}</span>
          {#if !sidebarStore.isCollapsed}
            <span class="section-label">Feeds</span>
          {/if}
        </button>
        {#if !sidebarStore.isCollapsed}
          <button
            class="filter-toggle"
            class:active={sidebarStore.showOnlyUnread.feeds}
            onclick={(e) => { e.stopPropagation(); sidebarStore.toggleShowOnlyUnread('feeds'); }}
            title={sidebarStore.showOnlyUnread.feeds ? 'Show all' : 'Show only unread'}
          >
            {sidebarStore.showOnlyUnread.feeds ? '●' : '○'}
          </button>
          <button class="add-btn" onclick={handleAddFeed} aria-label="Add feed">+</button>
        {/if}
      </div>
      {#if sidebarStore.expandedSections.feeds && !sidebarStore.isCollapsed}
        <div class="section-items">
          {#each sortedSubscriptions() as sub (sub.id)}
            {@const count = feedUnreadCounts.get(sub.id!) || 0}
            <button
              class="nav-item sub-item"
              class:active={currentFilter().type === 'feed' && currentFilter().id === sub.id}
              onclick={() => selectFilter('feed', sub.id)}
            >
              <span class="nav-label">{sub.title}</span>
              {#if count > 0}
                <span class="nav-count">{count}</span>
              {/if}
            </button>
          {:else}
            <div class="empty-section">No subscriptions</div>
          {/each}
        </div>
      {/if}
    </div>
  </nav>
</aside>

<style>
  .sidebar-backdrop {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 40;
    border: none;
    cursor: pointer;
  }

  .sidebar {
    position: fixed;
    left: 0;
    top: 0;
    bottom: 0;
    width: var(--sidebar-width, 260px);
    background: var(--color-bg-secondary);
    border-right: 1px solid var(--color-border);
    display: flex;
    flex-direction: column;
    z-index: 50;
    transition: width 0.2s ease, transform 0.2s ease;
    overflow-y: auto;
  }

  .sidebar.collapsed {
    width: var(--sidebar-collapsed-width, 60px);
  }

  .sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem;
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  .user-info {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    text-decoration: none;
    color: var(--color-text);
    min-width: 0;
    flex: 1;
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

  .toggle-btn {
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.25rem;
    color: var(--color-text-secondary);
    font-size: 1.25rem;
    line-height: 1;
    flex-shrink: 0;
  }

  .toggle-btn:hover {
    color: var(--color-text);
  }

  .toggle-icon {
    display: block;
  }

  .sidebar-nav {
    flex: 1;
    padding: 0.5rem 0;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.5rem 0.75rem;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    font: inherit;
    color: var(--color-text);
    transition: background-color 0.15s;
  }

  .nav-item:hover {
    background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
  }

  .nav-item.active {
    background-color: var(--color-sidebar-active, rgba(0, 102, 204, 0.1));
    color: var(--color-primary);
  }

  .nav-item.sub-item {
    padding-left: 1.5rem;
  }

  .nav-icon {
    font-size: 1rem;
    flex-shrink: 0;
    width: 1.25rem;
    text-align: center;
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
    background: var(--color-text-secondary);
    color: var(--color-bg);
    padding: 0.125rem 0.375rem;
    border-radius: 10px;
    min-width: 1.25rem;
    text-align: center;
  }

  .nav-item.active .nav-count {
    background: var(--color-primary);
    color: white;
  }

  .nav-section {
    margin-top: 0.5rem;
  }

  .section-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.5rem 0.75rem;
    color: var(--color-text-secondary);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .section-header:hover {
    color: var(--color-text);
  }

  .section-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: 1;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    font: inherit;
    color: inherit;
    font-size: inherit;
    text-transform: inherit;
    letter-spacing: inherit;
    padding: 0;
  }

  .disclosure {
    font-size: 0.625rem;
    flex-shrink: 0;
  }

  .section-label {
    flex: 1;
  }

  .filter-toggle {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.75rem;
    color: var(--color-text-secondary);
    padding: 0 0.25rem;
    line-height: 1;
    opacity: 0.6;
  }

  .filter-toggle:hover {
    opacity: 1;
  }

  .filter-toggle.active {
    color: var(--color-primary);
    opacity: 1;
  }

  .add-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 1rem;
    color: var(--color-text-secondary);
    padding: 0 0.25rem;
    line-height: 1;
  }

  .add-btn:hover {
    color: var(--color-primary);
  }

  .section-items {
    margin-top: 0.25rem;
  }

  .small-avatar {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .small-avatar-placeholder {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--color-border);
    flex-shrink: 0;
  }

  .empty-section {
    padding: 0.5rem 1.5rem;
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
    font-style: italic;
  }

  /* Mobile styles */
  @media (max-width: 768px) {
    .sidebar-backdrop {
      display: block;
    }

    .sidebar-backdrop:not(.sidebar.open ~ .sidebar-backdrop) {
      display: none;
    }

    .sidebar {
      transform: translateX(-100%);
      width: var(--sidebar-width, 260px) !important;
    }

    .sidebar.open {
      transform: translateX(0);
    }

    .toggle-btn {
      display: none;
    }
  }

  @media (prefers-color-scheme: dark) {
    .nav-item:hover {
      background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
    }
  }
</style>
