<script lang="ts">
    import { page } from "$app/stores";
    import { goto } from "$app/navigation";
    import { auth } from "$lib/stores/auth.svelte";
    import { sidebarStore } from "$lib/stores/sidebar.svelte";
    import { subscriptionsStore } from "$lib/stores/subscriptions.svelte";
    import { readingStore } from "$lib/stores/reading.svelte";
    import { socialStore } from "$lib/stores/social.svelte";
    import { sharesStore } from "$lib/stores/shares.svelte";
    import { shareReadingStore } from "$lib/stores/shareReading.svelte";
    import { onMount, onDestroy } from "svelte";
    import AddFeedModal from "./AddFeedModal.svelte";

    async function removeFeed(id: number) {
        if (confirm('Are you sure you want to remove this subscription?')) {
            await subscriptionsStore.remove(id);
        }
    }

    let showAddFeedModal = $state(false);

    // Sidebar resize state
    const MIN_WIDTH = 180;
    const MAX_WIDTH = 400;
    const DEFAULT_WIDTH = 260;
    let sidebarWidth = $state(DEFAULT_WIDTH);
    let isResizing = $state(false);

    function loadSavedWidth() {
        const saved = localStorage.getItem('sidebar-width');
        if (saved) {
            const width = parseInt(saved, 10);
            if (width >= MIN_WIDTH && width <= MAX_WIDTH) {
                sidebarWidth = width;
            }
        }
        updateCssVariable(sidebarWidth);
    }

    function saveWidth(width: number) {
        localStorage.setItem('sidebar-width', String(width));
    }

    function updateCssVariable(width: number) {
        document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
    }

    // Update CSS variable whenever width changes
    $effect(() => {
        updateCssVariable(sidebarWidth);
    });

    function startResize(e: MouseEvent) {
        e.preventDefault();
        isResizing = true;
        document.body.classList.add('sidebar-resizing');
        document.addEventListener('mousemove', handleResize);
        document.addEventListener('mouseup', stopResize);
    }

    function handleResize(e: MouseEvent) {
        if (!isResizing) return;
        const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, e.clientX));
        sidebarWidth = newWidth;
    }

    function stopResize() {
        if (isResizing) {
            isResizing = false;
            document.body.classList.remove('sidebar-resizing');
            saveWidth(sidebarWidth);
            document.removeEventListener('mousemove', handleResize);
            document.removeEventListener('mouseup', stopResize);
        }
    }

    // Context menu state
    let contextMenu = $state<{ x: number; y: number; feedId: number } | null>(null);
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    let longPressTriggered = $state(false);

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

    function handleClickOutside(e: MouseEvent) {
        if (contextMenu) {
            closeContextMenu();
        }
    }

    function handleKeydown(e: KeyboardEvent) {
        if (contextMenu && e.key === 'Escape') {
            closeContextMenu();
        }
    }

    onMount(() => {
        loadSavedWidth();
        document.addEventListener('click', handleClickOutside);
        document.addEventListener('keydown', handleKeydown);
    });

    onDestroy(() => {
        document.removeEventListener('click', handleClickOutside);
        document.removeEventListener('keydown', handleKeydown);
        document.removeEventListener('mousemove', handleResize);
        document.removeEventListener('mouseup', stopResize);
        if (longPressTimer) clearTimeout(longPressTimer);
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

    let feedUnreadCounts = $state<Map<number, number>>(new Map());

    // Calculate total unread
    let totalUnread = $derived(
        Array.from(feedUnreadCounts.values()).reduce((a, b) => a + b, 0),
    );

    // Group unread shares by author for counts
    let sharerCounts = $derived(() => {
        // Track dependency on read positions
        shareReadingStore.shareReadPositions;
        const counts = new Map<string, number>();
        for (const share of socialStore.shares) {
            if (!shareReadingStore.isRead(share.recordUri)) {
                counts.set(share.authorDid, (counts.get(share.authorDid) || 0) + 1);
            }
        }
        return counts;
    });

    // Current filter from URL
    let currentFilter = $derived(() => {
        const feed = $page.url.searchParams.get("feed");
        const starred = $page.url.searchParams.get("starred");
        const shared = $page.url.searchParams.get("shared");
        const sharer = $page.url.searchParams.get("sharer");
        const following = $page.url.searchParams.get("following");
        const feeds = $page.url.searchParams.get("feeds");
        if (feed) return { type: "feed" as const, id: parseInt(feed) };
        if (starred) return { type: "starred" as const };
        if (shared) return { type: "shared" as const };
        if (following) return { type: "following" as const };
        if (sharer) return { type: "sharer" as const, id: sharer };
        if (feeds) return { type: "feeds" as const };
        return { type: "all" as const };
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

    // Sort followed users: 1) with unread shares, 2) followed in-app, 3) others
    let sortedFollowedUsers = $derived(() => {
        const counts = sharerCounts();
        let users = [...socialStore.followedUsers].sort((a, b) => {
            const countA = counts.get(a.did) || 0;
            const countB = counts.get(b.did) || 0;
            const hasUnreadA = countA > 0;
            const hasUnreadB = countB > 0;

            // Tier 1: accounts with unread shares
            if (hasUnreadA && !hasUnreadB) return -1;
            if (!hasUnreadA && hasUnreadB) return 1;

            // Within unread tier, sort by count descending
            if (hasUnreadA && hasUnreadB) {
                return countB - countA;
            }

            // Tier 2: accounts followed in-app
            if (a.onApp && !b.onApp) return -1;
            if (!a.onApp && b.onApp) return 1;

            // Tier 3: alphabetical by display name or handle
            const nameA = (a.displayName || a.handle).toLowerCase();
            const nameB = (b.displayName || b.handle).toLowerCase();
            return nameA.localeCompare(nameB);
        });
        if (sidebarStore.showOnlyUnread.shared) {
            users = users.filter((u) => (counts.get(u.did) || 0) > 0);
        }
        return users;
    });

    // Load unread counts when subscriptions, articles, or read state changes
    $effect(() => {
        // Track dependencies
        subscriptionsStore.subscriptions;
        subscriptionsStore.articlesVersion;
        readingStore.readPositions;
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
        if (type === "feed" && id) params.set("feed", String(id));
        else if (type === "starred") params.set("starred", "true");
        else if (type === "shared") params.set("shared", "true");
        else if (type === "following") params.set("following", "true");
        else if (type === "sharer" && id) params.set("sharer", String(id));
        else if (type === "feeds") params.set("feeds", "true");

        const query = params.toString();
        goto(query ? `/?${query}` : "/");

        // Close mobile sidebar after navigation
        sidebarStore.closeMobile();
    }

    function handleAddFeed(e: MouseEvent) {
        e.stopPropagation();
        showAddFeedModal = true;
        sidebarStore.closeMobile();
    }

    function handleBackdropClick() {
        sidebarStore.closeMobile();
    }

    function getFaviconUrl(sub: typeof subscriptionsStore.subscriptions[0]): string | null {
        const url = sub.siteUrl || sub.feedUrl;
        try {
            const domain = new URL(url).hostname;
            return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
        } catch {
            return null;
        }
    }
</script>

<!-- Mobile backdrop -->
{#if sidebarStore.isOpen}
    <button
        class="sidebar-backdrop"
        onclick={handleBackdropClick}
        aria-label="Close sidebar"
    ></button>
{/if}

<aside
    class="sidebar"
    class:collapsed={sidebarStore.isCollapsed}
    class:open={sidebarStore.isOpen}
    class:resizing={isResizing}
    style="--sidebar-width: {sidebarWidth}px"
>
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <!-- Resize handle -->
    <div
        class="resize-handle"
        onmousedown={startResize}
        role="separator"
        aria-orientation="vertical"
    ></div>

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
        <button
            class="add-feed-btn"
            onclick={handleAddFeed}
            aria-label="Add feed"
        >
            +
        </button>
    </div>

    <!-- Navigation items -->
    <nav class="sidebar-nav">
        <button
            class="nav-item"
            class:active={currentFilter().type === "all"}
            onclick={() => selectFilter("all")}
        >
            <span class="nav-icon">&#x2709;</span>
            {#if !sidebarStore.isCollapsed}
                <span class="nav-label">All</span>
                {#if totalUnread > 0}
                    <span class="nav-count">{totalUnread}</span>
                {/if}
            {/if}
        </button>

        <button
            class="nav-item"
            class:active={currentFilter().type === "starred"}
            onclick={() => selectFilter("starred")}
        >
            <span class="nav-icon">&#x2606;</span>
            {#if !sidebarStore.isCollapsed}
                <span class="nav-label">Starred</span>
            {/if}
        </button>

        <button
            class="nav-item"
            class:active={currentFilter().type === "shared"}
            onclick={() => selectFilter("shared")}
        >
            <span class="nav-icon">&#x2197;</span>
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
            onclick={() => sidebarStore.closeMobile()}
        >
            <span class="nav-icon">&#x1F50D;</span>
            {#if !sidebarStore.isCollapsed}
                <span class="nav-label">Discover</span>
            {/if}
        </a>

        <a
            href="/settings"
            class="nav-item nav-link"
            onclick={() => sidebarStore.closeMobile()}
        >
            <span class="nav-icon">⚙</span>
            {#if !sidebarStore.isCollapsed}
                <span class="nav-label">Settings</span>
            {/if}
        </a>

        <!-- Following section -->
        <div class="nav-section">
            <div class="section-header" class:active={currentFilter().type === "following"}>
                <button
                    class="disclosure-btn"
                    onclick={() => sidebarStore.toggleSection("shared")}
                    aria-label="Toggle section"
                >
                    <span class="disclosure"
                        >{sidebarStore.expandedSections.shared ? "▼" : "▶"}</span
                    >
                </button>
                {#if !sidebarStore.isCollapsed}
                    <button
                        class="section-label-btn"
                        class:active={currentFilter().type === "following"}
                        onclick={() => selectFilter("following")}
                    >
                        Following
                    </button>
                    <button
                        class="filter-toggle"
                        class:active={sidebarStore.showOnlyUnread.shared}
                        onclick={(e) => {
                            e.stopPropagation();
                            sidebarStore.toggleShowOnlyUnread("shared");
                        }}
                        title={sidebarStore.showOnlyUnread.shared
                            ? "Show all"
                            : "Show only with unread"}
                    >
                        {sidebarStore.showOnlyUnread.shared ? "●" : "○"}
                    </button>
                {/if}
            </div>
            {#if sidebarStore.expandedSections.shared && !sidebarStore.isCollapsed}
                <div class="section-items">
                    {#each sortedFollowedUsers() as user (user.did)}
                        {@const count = sharerCounts().get(user.did) || 0}
                        <button
                            class="nav-item sub-item"
                            class:active={currentFilter().type === "sharer" &&
                                currentFilter().id === user.did}
                            class:not-on-app={!user.onApp}
                            onclick={() => selectFilter("sharer", user.did)}
                        >
                            {#if user.avatarUrl}
                                <img src={user.avatarUrl} alt="" class="small-avatar" />
                            {:else}
                                <div class="small-avatar-placeholder"></div>
                            {/if}
                            <span class="nav-label"
                                >{user.displayName || user.handle}</span
                            >
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
            <div class="section-header" class:active={currentFilter().type === "feeds"}>
                <button
                    class="disclosure-btn"
                    onclick={() => sidebarStore.toggleSection("feeds")}
                    aria-label="Toggle section"
                >
                    <span class="disclosure"
                        >{sidebarStore.expandedSections.feeds ? "▼" : "▶"}</span
                    >
                </button>
                {#if !sidebarStore.isCollapsed}
                    <button
                        class="section-label-btn"
                        class:active={currentFilter().type === "feeds"}
                        onclick={() => selectFilter("feeds")}
                    >
                        Feeds
                    </button>
                    <button
                        class="filter-toggle"
                        class:active={sidebarStore.showOnlyUnread.feeds}
                        onclick={(e) => {
                            e.stopPropagation();
                            sidebarStore.toggleShowOnlyUnread("feeds");
                        }}
                        title={sidebarStore.showOnlyUnread.feeds
                            ? "Show all"
                            : "Show only unread"}
                    >
                        {sidebarStore.showOnlyUnread.feeds ? "●" : "○"}
                    </button>
                {/if}
            </div>
            {#if sidebarStore.expandedSections.feeds && !sidebarStore.isCollapsed}
                <div class="section-items">
                    {#each sortedSubscriptions() as sub (sub.id)}
                        {@const count = feedUnreadCounts.get(sub.id!) || 0}
                        {@const faviconUrl = getFaviconUrl(sub)}
                        {@const loadingState = subscriptionsStore.feedLoadingStates.get(sub.id!)}
                        {@const feedError = subscriptionsStore.feedErrors.get(sub.id!)}
                        <button
                            class="nav-item sub-item feed-item"
                            class:active={currentFilter().type === "feed" &&
                                currentFilter().id === sub.id}
                            class:has-error={loadingState === "error"}
                            onclick={() => selectFilter("feed", sub.id)}
                            oncontextmenu={(e) => sub.id && handleContextMenu(e, sub.id)}
                            ontouchstart={(e) => sub.id && handleTouchStart(e, sub.id)}
                            ontouchend={handleTouchEnd}
                            ontouchmove={handleTouchMove}
                            title={feedError || ""}
                        >
                            {#if loadingState === "loading"}
                                <span class="feed-loading-spinner"></span>
                            {:else if loadingState === "error"}
                                <span class="feed-error-icon" title={feedError}>!</span>
                            {:else if faviconUrl}
                                <img src={faviconUrl} alt="" class="feed-favicon" />
                            {:else}
                                <span class="feed-favicon-placeholder"></span>
                            {/if}
                            <span class="nav-label">{sub.title}</span>
                            {#if loadingState === "error"}
                                <span
                                    class="retry-btn"
                                    role="button"
                                    tabindex="0"
                                    onclick={(e) => {
                                        e.stopPropagation();
                                        subscriptionsStore.fetchFeed(sub.id!, true);
                                    }}
                                    onkeydown={(e) => {
                                        if (e.key === 'Enter' || e.key === ' ') {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            subscriptionsStore.fetchFeed(sub.id!, true);
                                        }
                                    }}
                                    title="Retry"
                                >
                                    ↻
                                </span>
                            {:else if count > 0}
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

<AddFeedModal open={showAddFeedModal} onclose={() => showAddFeedModal = false} />

{#if contextMenu}
    <div
        class="context-menu"
        style="left: {contextMenu.x}px; top: {contextMenu.y}px;"
        role="menu"
    >
        <button
            class="context-menu-item danger"
            onclick={() => {
                if (contextMenu) removeFeed(contextMenu.feedId);
                closeContextMenu();
            }}
            role="menuitem"
        >
            <span class="context-menu-icon">🗑</span>
            Delete
        </button>
    </div>
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
        transition:
            width 0.2s ease,
            transform 0.2s ease;
        overflow-y: auto;
    }

    .sidebar.resizing {
        transition: none;
        user-select: none;
    }

    .resize-handle {
        position: absolute;
        top: 0;
        right: 0;
        width: 4px;
        height: 100%;
        cursor: col-resize;
        background: transparent;
        z-index: 10;
        transition: background-color 0.15s;
    }

    .resize-handle:hover,
    .sidebar.resizing .resize-handle {
        background: var(--color-primary);
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

    .add-feed-btn {
        background: none;
        border: none;
        cursor: pointer;
        padding: 0.25rem 0.5rem;
        color: var(--color-text-secondary);
        font-size: 1.25rem;
        line-height: 1;
        flex-shrink: 0;
    }

    .add-feed-btn:hover {
        color: var(--color-primary);
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

    .nav-link {
        text-decoration: none;
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
        color: var(--color-text-secondary);
    }

    .nav-item.active .nav-count {
        color: var(--color-primary);
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

    .disclosure-btn {
        background: none;
        border: none;
        cursor: pointer;
        padding: 0;
        color: inherit;
        font-size: inherit;
        line-height: 1;
    }

    .disclosure-btn:hover {
        color: var(--color-text);
    }

    .section-label-btn {
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

    .section-label-btn:hover {
        color: var(--color-text);
    }

    .section-label-btn.active {
        color: var(--color-primary);
    }

    .section-header:hover {
        background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
    }

    .section-header.active {
        background-color: var(--color-sidebar-active, rgba(0, 102, 204, 0.1));
    }

    .disclosure {
        font-size: 0.625rem;
        flex-shrink: 0;
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

    .feed-favicon {
        width: 16px;
        height: 16px;
        flex-shrink: 0;
        border-radius: 2px;
    }

    .feed-favicon-placeholder {
        width: 16px;
        height: 16px;
        flex-shrink: 0;
        background: var(--color-border);
        border-radius: 2px;
    }

    .feed-loading-spinner {
        width: 16px;
        height: 16px;
        flex-shrink: 0;
        border: 2px solid var(--color-border);
        border-top-color: var(--color-primary);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
        to {
            transform: rotate(360deg);
        }
    }

    .feed-error-icon {
        width: 16px;
        height: 16px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--color-error);
        color: white;
        border-radius: 50%;
        font-size: 0.75rem;
        font-weight: bold;
    }

    .nav-item.has-error {
        color: var(--color-error);
    }

    .nav-item.not-on-app {
        opacity: 0.5;
    }

    /* Feed item */
    .feed-item {
        -webkit-touch-callout: none;
        -webkit-user-select: none;
        user-select: none;
    }

    .retry-btn {
        background: none;
        border: none;
        cursor: pointer;
        color: var(--color-text-secondary);
        font-size: 1rem;
        padding: 0 0.25rem;
        line-height: 1;
    }

    .retry-btn:hover {
        color: var(--color-primary);
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
            display: none;
        }

        .sidebar {
            width: 100% !important;
            height: 100%;
            border-right: none;
            transform: translateX(-100%);
            transition: transform 0.25s ease-out;
        }

        .sidebar.open {
            transform: translateX(0);
        }

        .resize-handle {
            display: none;
        }
    }

    @media (prefers-color-scheme: dark) {
        .nav-item:hover {
            background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
        }
    }

    /* Context menu */
    .context-menu {
        position: fixed;
        min-width: 140px;
        background: var(--color-bg);
        border: 1px solid var(--color-border);
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        z-index: 100;
        overflow: hidden;
    }

    .context-menu-item {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        padding: 0.625rem 0.875rem;
        border: none;
        background: transparent;
        color: var(--color-text);
        font-size: 0.875rem;
        text-align: left;
        cursor: pointer;
        transition: background-color 0.15s;
    }

    .context-menu-item:hover {
        background: var(--color-bg-secondary);
    }

    .context-menu-item.danger {
        color: var(--color-error);
    }

    .context-menu-item.danger:hover {
        background: rgba(244, 67, 54, 0.1);
    }

    .context-menu-icon {
        font-size: 1rem;
    }
</style>
