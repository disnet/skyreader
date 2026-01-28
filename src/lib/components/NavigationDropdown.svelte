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
	import type { BlueskyProfile } from '$lib/types';

	interface Props {
		currentTitle: string;
	}

	let { currentTitle }: Props = $props();

	// Derive data from stores
	let subscriptions = $derived(subscriptionsStore.subscriptions);
	let followedUsers = $derived(socialStore.followedUsers);

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
	let triggerEl = $state<HTMLButtonElement | null>(null);
	let searchInputEl = $state<HTMLInputElement | null>(null);
	let isMobile = $state(false);
	let dropdownPosition = $state({ top: 0, left: 0 });

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

	// Navigation item type
	type NavItem =
		| { type: 'view'; id: string; label: string; count?: number; icon: string }
		| { type: 'feed'; id: number; label: string; count: number; iconUrl: string | null }
		| { type: 'user'; did: string; label: string; count: number; avatarUrl: string | null }
		| { type: 'utility'; id: string; label: string; count?: number; icon: string };

	// Build filtered items list
	let filteredItems = $derived.by((): { section: string; items: NavItem[] }[] => {
		const query = searchQuery.toLowerCase().trim();

		const views: NavItem[] = [
			{ type: 'view', id: 'all', label: 'All', count: totalUnread, icon: '✉' },
			{ type: 'view', id: 'starred', label: 'Starred', count: starredCount, icon: '☆' },
			{ type: 'view', id: 'shared', label: 'Shared', count: sharedCount, icon: '↗' },
		];

		const users: NavItem[] = followedUsers.map((u) => {
			const profile = userProfiles.get(u.did);
			return {
				type: 'user' as const,
				did: u.did,
				label: profile?.displayName || profile?.handle || u.did.slice(0, 20) + '...',
				count: sharerCounts.get(u.did) || 0,
				avatarUrl: profile?.avatar || null,
			};
		});

		const feeds: NavItem[] = subscriptions.map((s) => ({
			type: 'feed' as const,
			id: s.id!,
			label: s.customTitle || s.title,
			count: feedUnreadCounts.get(s.id!) || 0,
			iconUrl: s.customIconUrl || getFaviconUrl(s.siteUrl || s.feedUrl),
		}));

		const utilities: NavItem[] = [
			{ type: 'utility', id: 'discover', label: 'Discover', icon: '🔍' },
			{ type: 'utility', id: 'activity', label: 'Activity', count: activityCount, icon: '🔔' },
			{ type: 'utility', id: 'settings', label: 'Settings', icon: '⚙' },
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
			sections.push({ section: 'Following', items: filteredUsers });
		}

		const filteredFeeds = feeds.filter(filterItem);
		if (filteredFeeds.length > 0) {
			sections.push({ section: 'Feeds', items: filteredFeeds });
		}

		const filteredUtilities = utilities.filter(filterItem);
		if (filteredUtilities.length > 0) {
			sections.push({ section: '', items: filteredUtilities });
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
		if (feed) return { type: 'feed', id: parseInt(feed) };
		if (starred) return { type: 'starred' };
		if (shared) return { type: 'shared' };
		if (sharer) return { type: 'sharer', id: sharer };
		return { type: 'all' };
	});

	function isItemActive(item: NavItem): boolean {
		const filter = currentFilter;
		if (item.type === 'view') {
			if (item.id === 'all' && filter.type === 'all') return true;
			if (item.id === 'starred' && filter.type === 'starred') return true;
			if (item.id === 'shared' && filter.type === 'shared') return true;
		}
		if (item.type === 'feed' && filter.type === 'feed' && filter.id === item.id) return true;
		if (item.type === 'user' && filter.type === 'sharer' && filter.id === item.did) return true;
		return false;
	}

	function open() {
		sidebarStore.toggleNavigationDropdown();
		searchQuery = '';
		highlightedIndex = 0;
		// Calculate dropdown position from trigger button
		if (triggerEl && !isMobile) {
			const rect = triggerEl.getBoundingClientRect();
			dropdownPosition = {
				top: rect.bottom + 8,
				left: rect.left,
			};
		}
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

	// When opened externally (keyboard shortcut), set up positioning and focus
	$effect(() => {
		if (isOpen) {
			searchQuery = '';
			highlightedIndex = 0;
			if (triggerEl && !isMobile) {
				const rect = triggerEl.getBoundingClientRect();
				dropdownPosition = {
					top: rect.bottom + 8,
					left: rect.left,
				};
			}
			requestAnimationFrame(() => {
				searchInputEl?.focus();
			});
		}
	});

	function selectItem(item: NavItem) {
		let url = '/';
		if (item.type === 'view') {
			if (item.id === 'starred') url = '/?starred=true';
			else if (item.id === 'shared') url = '/?shared=true';
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
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="nav-dropdown" bind:this={dropdownEl}>
	<button
		bind:this={triggerEl}
		class="trigger"
		onclick={toggle}
		aria-haspopup="listbox"
		aria-expanded={isOpen}
	>
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

	{#if isOpen}
		<button
			class="backdrop"
			class:mobile={isMobile}
			onclick={handleBackdropClick}
			aria-label="Close navigation"
		></button>
		<div
			class="dropdown-panel"
			class:mobile={isMobile}
			role="listbox"
			style={!isMobile ? `top: ${dropdownPosition.top}px; left: ${dropdownPosition.left}px;` : ''}
		>
			<div class="search-container">
				<input
					bind:this={searchInputEl}
					type="text"
					class="search-input"
					placeholder="Search..."
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
							role="option"
							aria-selected={isItemActive(item)}
							onclick={() => selectItem(item)}
							onmouseenter={() => (highlightedIndex = flatIndex)}
						>
							{#if item.type === 'view' || item.type === 'utility'}
								<span class="item-icon">{item.icon}</span>
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
							{#if item.count && item.count > 0}
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

<style>
	.nav-dropdown {
		position: relative;
		flex: 1 1 auto;
		min-width: 0;
	}

	.trigger {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		background: var(--color-bg-secondary);
		border: 1px solid var(--color-border);
		border-radius: 5px;
		padding: 0.25rem 0.5rem;
		cursor: pointer;
		font: inherit;
		color: var(--color-text);
		max-width: 100%;
		min-width: 0;
		transition:
			background-color 0.15s,
			border-color 0.15s;
	}

	.trigger:hover {
		background: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
		border-color: var(--color-text-secondary);
	}

	.trigger:active {
		background: var(--color-bg-secondary);
	}

	.trigger-title {
		font-size: 0.9375rem;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	@media (prefers-color-scheme: dark) {
		.trigger:hover {
			background: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
		}
	}

	.trigger-chevron {
		flex-shrink: 0;
		transition: transform 0.2s ease;
		opacity: 0.6;
	}

	.trigger:hover .trigger-chevron {
		opacity: 1;
	}

	.trigger-chevron.open {
		transform: rotate(180deg);
	}

	.backdrop {
		position: fixed;
		inset: 0;
		background: transparent;
		z-index: 100;
		border: none;
		cursor: default;
	}

	.backdrop.mobile {
		background: rgba(0, 0, 0, 0.5);
		cursor: pointer;
	}

	.dropdown-panel {
		position: fixed;
		width: 300px;
		max-height: 60vh;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
		z-index: 101;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.dropdown-panel.mobile {
		top: auto !important;
		bottom: 0;
		left: 0 !important;
		right: 0;
		width: 100%;
		max-height: 70vh;
		border-radius: 16px 16px 0 0;
		animation: slideUp 0.25s ease-out;
	}

	@keyframes slideUp {
		from {
			transform: translateY(100%);
		}
		to {
			transform: translateY(0);
		}
	}

	.search-container {
		padding: 0.75rem;
		border-bottom: 1px solid var(--color-border);
	}

	.search-input {
		width: 100%;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		font: inherit;
		font-size: 0.875rem;
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

	.item-icon {
		width: 1.25rem;
		text-align: center;
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
</style>
