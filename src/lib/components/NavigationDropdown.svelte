<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { onMount, onDestroy } from 'svelte';
	import { profileService } from '$lib/services/profiles';
	import { getFaviconUrl } from '$lib/utils/favicon';
	import { sidebarStore } from '$lib/stores/sidebar.svelte';
	import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
	import { socialStore } from '$lib/stores/social.svelte';
	import { readingStore } from '$lib/stores/reading.svelte';
	import { shareReadingStore } from '$lib/stores/shareReading.svelte';
	import { sharesStore } from '$lib/stores/shares.svelte';
	import { activityStore } from '$lib/stores/activity.svelte';
	import { articlesStore } from '$lib/stores/articles.svelte';
	import { liveDb } from '$lib/services/liveDb.svelte';
	import Icon from './Icon.svelte';
	import type { BlueskyProfile } from '$lib/types';

	interface Props {
		currentTitle: string;
	}

	let { currentTitle }: Props = $props();

	// Derive data from stores
	let subscriptions = $derived(subscriptionsStore.subscriptions);
	// Use inAppFollows instead of followedUsers to show ALL followed accounts,
	// not just those with shares/content
	let followedUsers = $derived(socialStore.inAppFollows);

	// Compute feed unread counts
	let feedUnreadCounts = $derived.by(() => {
		// Track dependencies
		liveDb.articlesVersion;
		readingStore.readPositions;
		const counts = new Map<number, number>();
		for (const sub of subscriptions) {
			if (sub.id) {
				counts.set(sub.id, articlesStore.getUnreadCount(sub.id));
			}
		}
		return counts;
	});

	let totalUnread = $derived(Array.from(feedUnreadCounts.values()).reduce((a, b) => a + b, 0));

	// Group unread shares by author for counts
	let sharerCounts = $derived.by(() => {
		shareReadingStore.shareReadPositions;
		const counts = new Map<string, number>();
		for (const share of socialStore.shares) {
			if (!shareReadingStore.isRead(share.recordUri)) {
				counts.set(share.authorDid, (counts.get(share.authorDid) || 0) + 1);
			}
		}
		return counts;
	});

	let starredCount = $derived(readingStore.starredCount);
	let sharedCount = $derived(sharesStore.userShares.size);
	let activityCount = $derived(activityStore.totalReshareCount);

	let searchQuery = $state('');
	let highlightedIndex = $state(-1);
	let dropdownEl = $state<HTMLDivElement | null>(null);
	let searchInputEl = $state<HTMLInputElement | null>(null);
	let mobilePanelEl = $state<HTMLDivElement | null>(null);
	let isMobile = $state(false);

	// Use store for open state so it can be controlled externally (keyboard shortcut)
	let isOpen = $derived(sidebarStore.navigationDropdownOpen);

	// Profiles cache for followed users
	let userProfiles = $state<Map<string, BlueskyProfile>>(new Map());

	// Check if we're on mobile
	function checkMobile() {
		isMobile = window.matchMedia('(max-width: 768px)').matches;
	}

	onMount(() => {
		checkMobile();
		window.addEventListener('resize', checkMobile);
	});

	onDestroy(() => {
		window.removeEventListener('resize', checkMobile);
	});

	// Load profiles for followed users when they change
	$effect(() => {
		const dids = followedUsers.map((u) => u.did);
		for (const did of dids) {
			if (!userProfiles.has(did)) {
				profileService.getProfile(did).then((profile) => {
					if (profile) {
						userProfiles.set(did, profile);
						userProfiles = new Map(userProfiles);
					}
				});
			}
		}
	});

	// Icon names type (matches Icon.svelte)
	type IconName =
		| 'inbox'
		| 'star'
		| 'share'
		| 'search'
		| 'bell'
		| 'settings'
		| 'users'
		| 'rss'
		| 'newspaper'
		| 'plus';

	// Navigation item type
	type NavItem =
		| { type: 'view'; id: string; label: string; count?: number; icon: IconName }
		| { type: 'feed'; id: number; label: string; count: number; iconUrl: string | null }
		| { type: 'user'; did: string; label: string; count: number; avatarUrl: string | null }
		| { type: 'utility'; id: string; label: string; count?: number; icon: IconName }
		| { type: 'action'; id: string; label: string; icon: IconName };

	// Build filtered items list
	let filteredItems = $derived.by((): { section: string; items: NavItem[] }[] => {
		const query = searchQuery.toLowerCase().trim();

		const views: NavItem[] = [
			{ type: 'view', id: 'all', label: 'All', count: totalUnread, icon: 'inbox' },
			{ type: 'view', id: 'starred', label: 'Later', count: starredCount, icon: 'star' },
			{ type: 'view', id: 'shared', label: 'Shared', count: sharedCount, icon: 'share' },
			{ type: 'utility', id: 'discover', label: 'Discover', icon: 'search' },
			{ type: 'utility', id: 'activity', label: 'Activity', count: activityCount, icon: 'bell' },
			{ type: 'utility', id: 'settings', label: 'Settings', icon: 'settings' },
		];

		const users: NavItem[] = [
			{ type: 'utility', id: 'following', label: 'Following', icon: 'users' },
			{ type: 'action', id: 'follow-user', label: 'Follow user', icon: 'plus' },
			...followedUsers.map((u) => {
				const profile = userProfiles.get(u.did);
				return {
					type: 'user' as const,
					did: u.did,
					label:
						profile?.displayName ||
						u.displayName ||
						profile?.handle ||
						u.handle ||
						u.did.slice(0, 20) + '...',
					count: sharerCounts.get(u.did) || 0,
					avatarUrl: profile?.avatar || u.avatarUrl || null,
				};
			}),
		];

		const feeds: NavItem[] = [
			{ type: 'view', id: 'feeds', label: 'Feeds', count: totalUnread, icon: 'rss' },
			...subscriptions.map((s) => ({
				type: 'feed' as const,
				id: s.id!,
				label: s.customTitle || s.title,
				count: feedUnreadCounts.get(s.id!) || 0,
				iconUrl: s.customIconUrl || getFaviconUrl(s.siteUrl || s.feedUrl),
			})),
			{ type: 'action', id: 'add-feed', label: 'Add Feed', icon: 'plus' },
		];

		// Filter by search query
		const filterItem = (item: NavItem) => {
			if (!query) return true;
			return item.label.toLowerCase().includes(query);
		};

		const sections: { section: string; items: NavItem[] }[] = [];

		const filteredViews = views.filter(filterItem);
		if (filteredViews.length > 0) {
			sections.push({ section: 'Views', items: filteredViews });
		}

		const filteredUsers = users.filter(filterItem);
		if (filteredUsers.length > 0) {
			sections.push({ section: '', items: filteredUsers });
		}

		const filteredFeeds = feeds.filter(filterItem);
		if (filteredFeeds.length > 0) {
			sections.push({ section: '', items: filteredFeeds });
		}

		return sections;
	});

	// Flat list of all items for keyboard navigation
	let flatItems = $derived(filteredItems.flatMap((s) => s.items));

	// Get current filter from URL
	let currentFilter = $derived.by(() => {
		const url = $page.url;
		const feed = url.searchParams.get('feed');
		const starred = url.searchParams.get('starred');
		const shared = url.searchParams.get('shared');
		const sharer = url.searchParams.get('sharer');
		const following = url.searchParams.get('following');
		const feeds = url.searchParams.get('feeds');
		const type = url.searchParams.get('type') as 'shares' | 'documents' | null;
		if (feed) return { type: 'feed', id: parseInt(feed) };
		if (starred) return { type: 'starred' };
		if (shared) return { type: 'shared' };
		if (sharer) return { type: 'sharer', id: sharer };
		if (following) return { type: 'following', contentType: type };
		if (feeds) return { type: 'feeds' };
		return { type: 'all' };
	});

	function isItemActive(item: NavItem): boolean {
		const filter = currentFilter;
		if (item.type === 'view') {
			if (item.id === 'all' && filter.type === 'all') return true;
			if (item.id === 'starred' && filter.type === 'starred') return true;
			if (item.id === 'shared' && filter.type === 'shared') return true;
			if (item.id === 'feeds' && filter.type === 'feeds') return true;
		}
		if (item.type === 'utility' && item.id === 'following' && $page.url.pathname === '/following')
			return true;
		if (item.type === 'feed' && filter.type === 'feed' && filter.id === item.id) return true;
		if (item.type === 'user' && filter.type === 'sharer' && filter.id === item.did) return true;
		return false;
	}

	function open() {
		searchQuery = '';
		highlightedIndex = 0;
		sidebarStore.toggleNavigationDropdown();
		// Focus search input after opening
		requestAnimationFrame(() => {
			searchInputEl?.focus();
		});
	}

	function toggle() {
		if (isOpen) {
			close();
		} else {
			open();
		}
	}

	function close() {
		sidebarStore.closeNavigationDropdown();
		searchQuery = '';
		highlightedIndex = -1;
	}

	// When opened externally (keyboard shortcut), set up focus
	$effect(() => {
		if (isOpen) {
			searchQuery = '';
			highlightedIndex = 0;
			requestAnimationFrame(() => {
				searchInputEl?.focus();
			});
		}
	});

	function selectItem(item: NavItem) {
		if (item.type === 'action') {
			close();
			if (item.id === 'add-feed') {
				sidebarStore.openAddFeedModal();
			} else if (item.id === 'follow-user') {
				sidebarStore.openFollowUserModal();
			}
			return;
		}
		let url = '/';
		if (item.type === 'view') {
			if (item.id === 'starred') url = '/?starred=true';
			else if (item.id === 'shared') url = '/?shared=true';
			else if (item.id === 'feeds') url = '/?feeds=true';
		} else if (item.type === 'feed') {
			url = `/?feed=${item.id}`;
		} else if (item.type === 'user') {
			url = `/?sharer=${item.did}`;
		} else if (item.type === 'utility') {
			url = `/${item.id}`;
		}
		goto(url);
		close();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (!isOpen) return;

		if (e.key === 'Escape') {
			e.preventDefault();
			close();
			return;
		}

		// Arrow down or Ctrl+N
		if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
			e.preventDefault();
			highlightedIndex = Math.min(highlightedIndex + 1, flatItems.length - 1);
			return;
		}

		// Arrow up or Ctrl+P
		if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
			e.preventDefault();
			highlightedIndex = Math.max(highlightedIndex - 1, 0);
			return;
		}

		if (e.key === 'Enter') {
			e.preventDefault();
			const index = highlightedIndex >= 0 ? highlightedIndex : 0;
			const item = flatItems[index];
			if (item) selectItem(item);
			return;
		}
	}

	function handleClickOutside(e: MouseEvent) {
		if (isOpen && dropdownEl && !dropdownEl.contains(e.target as Node)) {
			close();
		}
	}

	function handleBackdropClick() {
		close();
	}

	// Global click listener for click-outside
	$effect(() => {
		if (isOpen && !isMobile) {
			document.addEventListener('click', handleClickOutside);
			return () => {
				document.removeEventListener('click', handleClickOutside);
			};
		}
	});

	// Prevent body scroll on mobile when open
	$effect(() => {
		if (isMobile && isOpen) {
			document.body.style.overflow = 'hidden';
			return () => {
				document.body.style.overflow = '';
			};
		}
	});

	// Adjust panel size when virtual keyboard appears (using Visual Viewport API)
	$effect(() => {
		if (!isMobile || !isOpen || !mobilePanelEl) return;

		const viewport = window.visualViewport;
		if (!viewport) return;

		function updatePanelHeight() {
			if (!mobilePanelEl || !viewport) return;
			// Calculate available height from visual viewport (accounts for keyboard)
			const availableHeight = viewport.height - 24; // 24px for margins
			mobilePanelEl.style.maxHeight = `${availableHeight}px`;
		}

		updatePanelHeight();
		viewport.addEventListener('resize', updatePanelHeight);

		return () => {
			viewport.removeEventListener('resize', updatePanelHeight);
			if (mobilePanelEl) {
				mobilePanelEl.style.maxHeight = '';
			}
		};
	});

	function handlePanelTouchMove(e: TouchEvent) {
		// Allow scrolling within items-container, prevent elsewhere
		const target = e.target as HTMLElement;
		const itemsContainer = target.closest('.items-container');
		if (!itemsContainer) {
			e.preventDefault();
		}
	}

	// Portal action to move element to body
	function portal(node: HTMLElement) {
		document.body.appendChild(node);
		return {
			destroy() {
				node.remove();
			},
		};
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="nav-dropdown" bind:this={dropdownEl}>
	<button class="trigger" onclick={toggle} aria-haspopup="listbox" aria-expanded={isOpen}>
		<span class="trigger-title">{currentTitle}</span>
		<svg
			class="trigger-chevron"
			class:open={isOpen}
			width="12"
			height="12"
			viewBox="0 0 12 12"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
		>
			<path
				d="M2.5 4.5L6 8L9.5 4.5"
				stroke="currentColor"
				stroke-width="1.5"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
		</svg>
	</button>

	{#if isOpen && !isMobile}
		<!-- Desktop dropdown (absolute positioned within container) -->
		<button class="backdrop" onclick={handleBackdropClick} aria-label="Close navigation"></button>
		<div class="dropdown-panel" role="listbox">
			<div class="search-container">
				<input
					bind:this={searchInputEl}
					type="text"
					class="search-input"
					placeholder="Quick switch..."
					bind:value={searchQuery}
				/>
			</div>
			<div class="items-container">
				{#each filteredItems as { section, items }, sectionIndex}
					{#if section}
						<div class="section-header">{section}</div>
					{/if}
					{#each items as item, itemIndex}
						{@const flatIndex =
							filteredItems.slice(0, sectionIndex).reduce((acc, s) => acc + s.items.length, 0) +
							itemIndex}
						<button
							class="nav-item"
							class:active={isItemActive(item)}
							class:highlighted={flatIndex === highlightedIndex}
							class:child={item.type === 'user' ||
								item.type === 'feed' ||
								(item.type === 'action' && item.id === 'follow-user')}
							role="option"
							aria-selected={isItemActive(item)}
							onclick={() => selectItem(item)}
							onmouseenter={() => (highlightedIndex = flatIndex)}
						>
							{#if item.type === 'view' || item.type === 'utility' || item.type === 'action'}
								<span class="item-icon"><Icon name={item.icon} size={16} /></span>
							{:else if item.type === 'feed'}
								{#if item.iconUrl}
									<img src={item.iconUrl} alt="" class="feed-icon" />
								{:else}
									<span class="feed-icon-placeholder"></span>
								{/if}
							{:else if item.type === 'user'}
								{#if item.avatarUrl}
									<img src={item.avatarUrl} alt="" class="user-avatar" />
								{:else}
									<span class="user-avatar-placeholder"></span>
								{/if}
							{/if}
							<span class="item-label">{item.label}</span>
							{#if item.type !== 'action' && item.count && item.count > 0}
								<span class="item-count">{item.count}</span>
							{/if}
						</button>
					{/each}
				{/each}
				{#if flatItems.length === 0}
					<div class="no-results">No matches found</div>
				{/if}
			</div>
		</div>
	{/if}
</div>

{#if isOpen && isMobile}
	<!-- Mobile overlay (portaled to body to escape backdrop-filter containing block) -->
	<div class="mobile-portal" use:portal>
		<button class="backdrop mobile" onclick={handleBackdropClick} aria-label="Close navigation"
		></button>
		<div
			class="dropdown-panel mobile"
			role="listbox"
			ontouchmove={handlePanelTouchMove}
			bind:this={mobilePanelEl}
		>
			<div class="search-container mobile">
				<input
					bind:this={searchInputEl}
					type="text"
					class="search-input"
					placeholder="Quick switch..."
					bind:value={searchQuery}
				/>
				<button class="mobile-close-btn" onclick={close} aria-label="Close">
					<svg width="24" height="24" viewBox="0 0 24 24" fill="none">
						<path
							d="M18 6L6 18M6 6l12 12"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
						/>
					</svg>
				</button>
			</div>
			<div class="items-container">
				{#each filteredItems as { section, items }, sectionIndex}
					{#if section}
						<div class="section-header">{section}</div>
					{/if}
					{#each items as item, itemIndex}
						{@const flatIndex =
							filteredItems.slice(0, sectionIndex).reduce((acc, s) => acc + s.items.length, 0) +
							itemIndex}
						<button
							class="nav-item"
							class:active={isItemActive(item)}
							class:highlighted={flatIndex === highlightedIndex}
							class:child={item.type === 'user' ||
								item.type === 'feed' ||
								(item.type === 'action' && item.id === 'follow-user')}
							role="option"
							aria-selected={isItemActive(item)}
							onclick={() => selectItem(item)}
							onmouseenter={() => (highlightedIndex = flatIndex)}
						>
							{#if item.type === 'view' || item.type === 'utility' || item.type === 'action'}
								<span class="item-icon"><Icon name={item.icon} size={16} /></span>
							{:else if item.type === 'feed'}
								{#if item.iconUrl}
									<img src={item.iconUrl} alt="" class="feed-icon" />
								{:else}
									<span class="feed-icon-placeholder"></span>
								{/if}
							{:else if item.type === 'user'}
								{#if item.avatarUrl}
									<img src={item.avatarUrl} alt="" class="user-avatar" />
								{:else}
									<span class="user-avatar-placeholder"></span>
								{/if}
							{/if}
							<span class="item-label">{item.label}</span>
							{#if item.type !== 'action' && item.count && item.count > 0}
								<span class="item-count">{item.count}</span>
							{/if}
						</button>
					{/each}
				{/each}
				{#if flatItems.length === 0}
					<div class="no-results">No matches found</div>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.nav-dropdown {
		position: relative;
		flex: 0 1 auto;
		min-width: 0;
	}

	.trigger {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		font: inherit;
		color: var(--color-text);
		max-width: 100%;
		min-width: 0;
		transition: color 0.15s;
	}

	.trigger:hover {
		color: var(--color-primary);
	}

	.trigger-title {
		font-size: 1rem;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.trigger-chevron {
		flex-shrink: 0;
		transition: transform 0.2s ease;
		opacity: 0.6;
	}

	.trigger-chevron.open {
		transform: rotate(180deg);
	}

	.backdrop {
		position: fixed;
		inset: 0;
		background: transparent;
		z-index: 1000;
		border: none;
		cursor: default;
		-webkit-tap-highlight-color: transparent;
	}

	/* Mobile styles need :global because content is portaled to body */
	:global(.mobile-portal) {
		display: contents;
	}

	:global(.mobile-portal .backdrop.mobile) {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		z-index: 1000;
		border: none;
		cursor: pointer;
		touch-action: none;
		-webkit-tap-highlight-color: transparent;
	}

	.dropdown-panel {
		position: absolute;
		top: 100%;
		left: 0;
		margin-top: 8px;
		width: 300px;
		max-height: 60vh;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
		z-index: 1001;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	:global(.mobile-portal .dropdown-panel.mobile) {
		position: fixed;
		top: calc(env(safe-area-inset-top, 0px) + 12px);
		left: 12px;
		right: 12px;
		bottom: auto;
		width: auto;
		max-height: calc(
			100vh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 24px
		);
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: 20px;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
		z-index: 1001;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		animation: slideDown 0.2s ease-out;
		overscroll-behavior: contain;
	}

	@keyframes slideDown {
		from {
			opacity: 0;
			transform: translateY(-8px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@keyframes fadeIn {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

	.mobile-close-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.5rem;
		height: 2.5rem;
		background: none;
		border: none;
		border-radius: 50%;
		color: var(--color-text);
		cursor: pointer;
	}

	.mobile-close-btn:hover {
		background: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
	}

	.search-container {
		padding: 0.75rem;
		border-bottom: 1px solid var(--color-border);
	}

	.search-container.mobile {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.search-container.mobile .search-input {
		flex: 1;
	}

	.search-input {
		width: 100%;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		font: inherit;
		font-size: 1rem; /* 16px prevents iOS auto-zoom */
		background: var(--color-bg-secondary);
		color: var(--color-text);
	}

	.search-input:focus {
		outline: none;
		border-color: var(--color-primary);
	}

	.items-container {
		flex: 1;
		overflow-y: auto;
		padding: 0.5rem 0;
		overscroll-behavior: contain;
		-webkit-overflow-scrolling: touch;
	}

	.section-header {
		padding: 0.5rem 0.75rem 0.25rem;
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-secondary);
	}

	.nav-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.5rem 0.75rem;
		background: none;
		border: none;
		cursor: pointer;
		text-align: left;
		font: inherit;
		font-size: 0.875rem;
		color: var(--color-text);
		transition: background-color 0.1s;
	}

	.nav-item:hover,
	.nav-item.highlighted {
		background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
	}

	.nav-item.active {
		background-color: var(--color-sidebar-active, rgba(0, 102, 204, 0.1));
		color: var(--color-primary);
	}

	.nav-item.child {
		padding-left: 1.75rem;
	}

	.item-icon {
		width: 1.25rem;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.feed-icon {
		width: 16px;
		height: 16px;
		flex-shrink: 0;
		border-radius: 2px;
		object-fit: contain;
		display: block;
	}

	.feed-icon-placeholder {
		width: 16px;
		height: 16px;
		flex-shrink: 0;
		background: var(--color-border);
		border-radius: 2px;
		display: block;
	}

	.user-avatar {
		width: 18px;
		height: 18px;
		flex-shrink: 0;
		border-radius: 50%;
		object-fit: cover;
		display: block;
	}

	.user-avatar-placeholder {
		width: 18px;
		height: 18px;
		flex-shrink: 0;
		background: var(--color-border);
		border-radius: 50%;
		display: block;
	}

	.item-label {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.item-count {
		flex-shrink: 0;
		font-size: 0.75rem;
		color: var(--color-text-secondary);
	}

	.nav-item.active .item-count {
		color: var(--color-primary);
	}

	.no-results {
		padding: 1rem 0.75rem;
		text-align: center;
		color: var(--color-text-secondary);
		font-size: 0.875rem;
	}

	@media (prefers-color-scheme: dark) {
		.nav-item:hover,
		.nav-item.highlighted {
			background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
		}

		.dropdown-panel {
			box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
		}
	}

	/* Global styles for mobile portal content */
	:global(.mobile-portal .search-container.mobile) {
		padding: 0.75rem;
		border-bottom: 1px solid var(--color-border);
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	:global(.mobile-portal .search-input) {
		flex: 1;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		font: inherit;
		font-size: 1rem;
		background: var(--color-bg-secondary);
		color: var(--color-text);
	}

	:global(.mobile-portal .search-input:focus) {
		outline: none;
		border-color: var(--color-primary);
	}

	:global(.mobile-portal .mobile-close-btn) {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.5rem;
		height: 2.5rem;
		background: none;
		border: none;
		border-radius: 50%;
		color: var(--color-text);
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
		touch-action: manipulation;
	}

	:global(.mobile-portal .items-container) {
		flex: 1;
		overflow-y: auto;
		padding: 0.5rem 0;
		overscroll-behavior: contain;
		-webkit-overflow-scrolling: touch;
	}

	:global(.mobile-portal .items-container::after) {
		content: '';
		display: block;
		height: calc(env(safe-area-inset-bottom, 0px) + 2rem);
	}

	:global(.mobile-portal .section-header) {
		padding: 0.5rem 0.75rem 0.25rem;
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-secondary);
	}

	:global(.mobile-portal .nav-item) {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.5rem 0.75rem;
		background: none;
		border: none;
		cursor: pointer;
		text-align: left;
		font: inherit;
		font-size: 0.875rem;
		color: var(--color-text);
		-webkit-tap-highlight-color: transparent;
		touch-action: manipulation;
	}

	:global(.mobile-portal .nav-item.active) {
		background-color: var(--color-sidebar-active, rgba(0, 102, 204, 0.1));
		color: var(--color-primary);
	}

	:global(.mobile-portal .nav-item.highlighted) {
		background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
	}

	:global(.mobile-portal .nav-item.child) {
		padding-left: 1.75rem;
	}

	:global(.mobile-portal .item-icon) {
		width: 1.25rem;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	:global(.mobile-portal .feed-icon) {
		width: 16px;
		height: 16px;
		flex-shrink: 0;
		border-radius: 2px;
		object-fit: contain;
	}

	:global(.mobile-portal .feed-icon-placeholder) {
		width: 16px;
		height: 16px;
		flex-shrink: 0;
		background: var(--color-border);
		border-radius: 2px;
	}

	:global(.mobile-portal .user-avatar) {
		width: 18px;
		height: 18px;
		flex-shrink: 0;
		border-radius: 50%;
		object-fit: cover;
	}

	:global(.mobile-portal .user-avatar-placeholder) {
		width: 18px;
		height: 18px;
		flex-shrink: 0;
		background: var(--color-border);
		border-radius: 50%;
	}

	:global(.mobile-portal .item-label) {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	:global(.mobile-portal .item-count) {
		flex-shrink: 0;
		font-size: 0.75rem;
		color: var(--color-text-secondary);
	}

	:global(.mobile-portal .nav-item.active .item-count) {
		color: var(--color-primary);
	}

	:global(.mobile-portal .no-results) {
		padding: 1rem 0.75rem;
		text-align: center;
		color: var(--color-text-secondary);
		font-size: 0.875rem;
	}

	@media (prefers-color-scheme: dark) {
		:global(.mobile-portal .nav-item.highlighted) {
			background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
		}

		:global(.mobile-portal .backdrop.mobile) {
			background: rgba(0, 0, 0, 0.7);
		}

		:global(.mobile-portal .dropdown-panel.mobile) {
			box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
		}
	}
</style>
