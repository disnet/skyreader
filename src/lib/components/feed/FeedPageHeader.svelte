<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import PopoverMenu from '$lib/components/PopoverMenu.svelte';
	import NavigationDropdown from '$lib/components/NavigationDropdown.svelte';
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

	let menuItems = $derived.by(() => {
		if (!feedId) return [];
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
		return items;
	});
</script>

<div class="feed-header">
	<div class="feed-title-group">
		<NavigationDropdown currentTitle={title} />
		{#if feedId && menuItems.length > 0}
			<PopoverMenu items={menuItems} />
		{/if}
	</div>
	{#if relativeTime}
		<span class="last-updated">
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
		</span>
	{/if}
	{#if showViewToggle}
		<div class="view-toggle">
			<button class:active={showOnlyUnread} onclick={() => onToggleUnread(true)}> Unread </button>
			<button class:active={!showOnlyUnread} onclick={() => onToggleUnread(false)}> All </button>
		</div>
	{/if}
</div>

<style>
	.feed-header {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem 0;
		border-bottom: 1px solid var(--color-border);
		position: sticky;
		top: 0;
		background: var(--color-bg);
		z-index: 10;
	}

	.feed-title-group {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		min-width: 0;
	}

	.last-updated {
		font-size: 0.6875rem;
		color: var(--color-text-muted, var(--color-text-secondary));
		opacity: 0.6;
		white-space: nowrap;
		display: flex;
		align-items: center;
		gap: 0.25rem;
		margin-left: auto;
		min-width: 1.25rem;
		overflow: hidden;
	}

	.last-updated-text {
		overflow: hidden;
		text-overflow: ellipsis;
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
		gap: 0.25rem;
		background: var(--color-bg-secondary);
		border-radius: 6px;
		padding: 0.125rem;
		flex-shrink: 0;
	}

	.view-toggle button {
		background: none;
		border: none;
		padding: 0.375rem 0.75rem;
		font-size: 0.8125rem;
		border-radius: 4px;
		cursor: pointer;
		color: var(--color-text-secondary);
		transition: all 0.15s;
	}

	.view-toggle button.active {
		background: var(--color-bg);
		color: var(--color-text);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
	}

	.view-toggle button:hover:not(.active) {
		color: var(--color-text);
	}
</style>
