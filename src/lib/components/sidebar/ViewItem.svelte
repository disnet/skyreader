<script lang="ts">
	import type { FilteredView } from '$lib/types';
	import Icon from '../Icon.svelte';

	interface Props {
		view: FilteredView;
		isActive: boolean;
		onSelect: () => void;
		onContextMenu: (e: MouseEvent) => void;
		onTouchStart: (e: TouchEvent) => void;
		onTouchEnd: (e: TouchEvent) => void;
		onTouchMove: () => void;
		onMoreClick: (e: MouseEvent) => void;
	}

	let {
		view,
		isActive,
		onSelect,
		onContextMenu,
		onTouchStart,
		onTouchEnd,
		onTouchMove,
		onMoreClick,
	}: Props = $props();
</script>

<button
	class="nav-item sub-item view-item"
	class:active={isActive}
	onclick={onSelect}
	oncontextmenu={onContextMenu}
	ontouchstart={onTouchStart}
	ontouchend={onTouchEnd}
	ontouchmove={onTouchMove}
>
	<span class="view-icon"><Icon name="sliders" size={14} /></span>
	<span class="nav-label">{view.name}</span>
	<span
		class="more-btn"
		role="button"
		tabindex="0"
		onclick={(e) => {
			e.stopPropagation();
			onMoreClick(e);
		}}
		onkeydown={(e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				e.stopPropagation();
				onMoreClick(e as unknown as MouseEvent);
			}
		}}
		title="More options"
	>
		<Icon name="more-horizontal" size={14} />
	</span>
</button>

<style>
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

	.nav-item.active {
		background-color: var(--color-sidebar-active, rgba(0, 102, 204, 0.1));
		color: var(--color-primary);
	}

	.nav-item.sub-item {
		padding-left: 1.5rem;
	}

	.view-icon {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		color: var(--color-text-secondary);
	}

	.nav-item.active .view-icon {
		color: var(--color-primary);
	}

	.nav-label {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.875rem;
	}

	.view-item {
		-webkit-touch-callout: none;
		-webkit-user-select: none;
		user-select: none;
	}

	.more-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.25rem;
		height: 1.25rem;
		background: none;
		border: none;
		cursor: pointer;
		color: var(--color-text-secondary);
		font-size: 1rem;
		padding: 0;
		line-height: 1;
		opacity: 0;
		transition: opacity 0.15s;
		flex-shrink: 0;
		-webkit-tap-highlight-color: transparent;
		touch-action: manipulation;
	}

	.view-item:hover .more-btn,
	.more-btn:focus {
		opacity: 1;
	}

	.more-btn:hover {
		color: var(--color-text);
		background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.1));
		border-radius: 4px;
	}

	@media (prefers-color-scheme: dark) {
		.nav-item:hover {
			background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
		}
	}
</style>
