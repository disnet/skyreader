<script lang="ts">
	import PopoverMenu from '$lib/components/PopoverMenu.svelte';

	interface Props {
		title: string;
		feedId?: number;
		showViewToggle?: boolean;
		showOnlyUnread: boolean;
		onToggleUnread: (value: boolean) => void;
		onMarkAllAsRead?: () => void;
		onDelete?: () => void;
		onMobileMenuToggle: () => void;
	}

	let {
		title,
		feedId,
		showViewToggle = true,
		showOnlyUnread,
		onToggleUnread,
		onMarkAllAsRead,
		onDelete,
		onMobileMenuToggle,
	}: Props = $props();

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
	<button class="mobile-menu-btn" onclick={onMobileMenuToggle} aria-label="Open menu">
		&lt;
	</button>
	<div class="feed-title-group">
		<h1>{title}</h1>
		{#if feedId && menuItems.length > 0}
			<PopoverMenu items={menuItems} />
		{/if}
	</div>
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
		padding: 0.75rem 1rem;
		border-bottom: 1px solid var(--color-border);
		position: sticky;
		top: 0;
		background: var(--color-bg);
		z-index: 10;
	}

	.mobile-menu-btn {
		display: none;
		background: none;
		border: none;
		font-size: 1.25rem;
		cursor: pointer;
		padding: 0.25rem 0.5rem;
		color: var(--color-text-secondary);
	}

	.feed-title-group {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: 1;
		min-width: 0;
	}

	.feed-title-group h1 {
		margin: 0;
		font-size: 1.25rem;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.view-toggle {
		display: flex;
		gap: 0.25rem;
		background: var(--color-bg-secondary);
		border-radius: 6px;
		padding: 0.125rem;
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

	@media (max-width: 768px) {
		.mobile-menu-btn {
			display: block;
		}
	}
</style>
