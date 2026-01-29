<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import PopoverMenu from '$lib/components/PopoverMenu.svelte';
	import NavigationDropdown from '$lib/components/NavigationDropdown.svelte';
	import { sidebarStore } from '$lib/stores/sidebar.svelte';
	import { formatRelativeTime } from '$lib/utils/date';

	interface Props {
		title: string;
		feedId?: number;
		showViewToggle?: boolean;
		showOnlyUnread: boolean;
		lastRefreshAt?: number | null;
		isRefreshing?: boolean;
		onToggleUnread: (value: boolean) => void;
		onRefresh?: () => void;
		onMarkAllAsRead?: () => void;
		onEdit?: () => void;
		onDelete?: () => void;
	}

	let {
		title,
		feedId,
		showViewToggle = true,
		showOnlyUnread,
		lastRefreshAt,
		isRefreshing = false,
		onToggleUnread,
		onRefresh,
		onMarkAllAsRead,
		onEdit,
		onDelete,
	}: Props = $props();

	// Tick counter to force re-evaluation of relative time
	let tick = $state(0);
	let intervalId: ReturnType<typeof setInterval> | null = null;

	// Debounce refresh button
	let lastRefreshClick = 0;
	const DEBOUNCE_MS = 2000;

	function handleRefresh() {
		const now = Date.now();
		if (now - lastRefreshClick < DEBOUNCE_MS) return;
		lastRefreshClick = now;
		onRefresh?.();
	}

	onMount(() => {
		// Update relative time every minute
		intervalId = setInterval(() => {
			tick++;
		}, 60000);
	});

	onDestroy(() => {
		if (intervalId) clearInterval(intervalId);
	});

	// Use tick to force re-evaluation (void to suppress unused warning)
	let relativeTime = $derived(
		lastRefreshAt ? (void tick, formatRelativeTime(lastRefreshAt)) : null
	);

	let dropdownOpen = $derived(sidebarStore.navigationDropdownOpen);
	let sidebarCollapsed = $derived(sidebarStore.isCollapsed);

	let menuItems = $derived.by(() => {
		const items: Array<{ label: string; icon: string; onclick: () => void; variant?: 'danger' }> =
			[];
		if (onMarkAllAsRead) {
			items.push({
				label: 'Mark all as read',
				icon: '✓',
				onclick: onMarkAllAsRead,
			});
		}
		if (onEdit) {
			items.push({
				label: 'Edit',
				icon: '✏',
				onclick: onEdit,
			});
		}
		if (onDelete) {
			items.push({
				label: 'Delete',
				icon: '🗑',
				variant: 'danger',
				onclick: onDelete,
			});
		}
		console.log(
			'FeedPageHeader menuItems:',
			items.length,
			'onMarkAllAsRead:',
			!!onMarkAllAsRead,
			'onEdit:',
			!!onEdit,
			'onDelete:',
			!!onDelete
		);
		return items;
	});
</script>

<div class="feed-header-fixed" class:sidebar-collapsed={sidebarCollapsed}>
	<div class="feed-header-controls">
		<div class="control-left feed-title-group" class:dropdown-open={dropdownOpen}>
			<NavigationDropdown currentTitle={title} />
			{#if menuItems.length > 0}
				<PopoverMenu items={menuItems} />
			{/if}
			{#if relativeTime}
				<span class="divider"></span>
			{/if}
			{#if relativeTime}
				<div class="last-updated">
					<span class="last-updated-text">Updated {relativeTime}</span>
					{#if onRefresh}
						<button
							class="refresh-btn"
							onclick={handleRefresh}
							disabled={isRefreshing}
							aria-label="Refresh feeds"
						>
							<span class:spinning={isRefreshing}>↻</span>
						</button>
					{/if}
				</div>
			{/if}
		</div>

		<div class="control-right">
			{#if showViewToggle}
				<div class="view-toggle">
					<button class:active={showOnlyUnread} onclick={() => onToggleUnread(true)}>
						Unread
					</button>
					<button class:active={!showOnlyUnread} onclick={() => onToggleUnread(false)}>
						All
					</button>
				</div>
			{/if}
		</div>
	</div>
</div>

<style>
	.feed-header-fixed {
		position: fixed;
		top: 0;
		left: var(--sidebar-width, 260px);
		right: 0;
		pointer-events: none;
		z-index: 10;
		padding: 0 1rem;
	}

	.feed-header-fixed.sidebar-collapsed {
		left: var(--sidebar-collapsed-width, 60px);
	}

	.feed-header-controls {
		display: flex;
		justify-content: space-between;
		align-items: stretch;
		gap: 0.75rem;
		max-width: 800px;
		margin: 0 auto;
		padding: 0.75rem 0;
	}

	.control-left,
	.control-right {
		pointer-events: auto;
	}

	.control-left {
		min-width: 0;
		flex: 0 1 auto;
	}

	.control-right {
		display: flex;
		align-items: stretch;
		gap: 0.5rem;
		flex-shrink: 0;
	}

	.feed-title-group {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		background: rgba(255, 255, 255, 0.85);
		backdrop-filter: blur(8px);
		border-radius: 999px;
		padding: 0.25rem 0.75rem;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
		min-width: 0;
		max-width: 100%;
	}

	.feed-title-group.dropdown-open {
		z-index: 1002;
	}

	.divider {
		width: 1px;
		height: 1rem;
		background: var(--color-border);
		opacity: 0.5;
		flex-shrink: 0;
	}

	@media (max-width: 768px) {
		.feed-header-fixed {
			left: 0;
		}

		.feed-header-fixed.sidebar-collapsed {
			left: 0;
		}
	}

	@media (max-width: 480px) {
		.last-updated-text,
		.divider {
			display: none;
		}
	}

	.last-updated {
		font-size: 0.6875rem;
		color: var(--color-text-muted, var(--color-text-secondary));
		display: flex;
		align-items: center;
		gap: 0.25rem;
		flex-shrink: 0;
	}

	.last-updated-text {
		white-space: nowrap;
	}

	.refresh-btn {
		background: none;
		border: none;
		padding: 0.125rem;
		cursor: pointer;
		color: inherit;
		font-size: 0.875rem;
		line-height: 1;
		opacity: 0.8;
		transition: opacity 0.15s;
	}

	.refresh-btn:hover:not(:disabled) {
		opacity: 1;
	}

	.refresh-btn:disabled {
		cursor: default;
	}

	.refresh-btn .spinning {
		display: inline-block;
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		from {
			transform: rotate(0deg);
		}
		to {
			transform: rotate(360deg);
		}
	}

	.view-toggle {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		background: rgba(255, 255, 255, 0.85);
		backdrop-filter: blur(8px);
		border-radius: 999px;
		padding: 0.25rem;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
	}

	.view-toggle button {
		background: none;
		border: none;
		padding: 0.5rem;
		font-size: 0.8125rem;
		font-weight: 500;
		border-radius: 999px;
		cursor: pointer;
		color: var(--color-text-secondary);
		transition: all 0.2s ease;
	}

	.view-toggle button.active {
		background: var(--color-bg-secondary, #f5f5f5);
		color: var(--color-text);
	}

	.view-toggle button:hover:not(.active) {
		color: var(--color-text);
	}

	@media (prefers-color-scheme: dark) {
		.feed-title-group,
		.view-toggle {
			background: rgba(40, 40, 40, 0.95);
		}
	}
</style>
