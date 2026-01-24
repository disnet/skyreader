<script lang="ts">
	import { getFaviconUrl } from '$lib/utils/favicon';
	import type { Subscription } from '$lib/types';

	type LoadingState = 'loading' | 'error' | 'ready';

	interface Props {
		subscription: Subscription;
		unreadCount: number;
		isActive: boolean;
		loadingState?: LoadingState;
		errorMessage?: string;
		onSelect: () => void;
		onContextMenu: (e: MouseEvent) => void;
		onTouchStart: (e: TouchEvent) => void;
		onTouchEnd: (e: TouchEvent) => void;
		onTouchMove: () => void;
		onRetry: () => void;
	}

	let {
		subscription,
		unreadCount,
		isActive,
		loadingState = 'ready',
		errorMessage = '',
		onSelect,
		onContextMenu,
		onTouchStart,
		onTouchEnd,
		onTouchMove,
		onRetry,
	}: Props = $props();

	let faviconUrl = $derived(getFaviconUrl(subscription.siteUrl || subscription.feedUrl));
</script>

<button
	class="nav-item sub-item feed-item"
	class:active={isActive}
	class:has-error={loadingState === 'error'}
	onclick={onSelect}
	oncontextmenu={onContextMenu}
	ontouchstart={onTouchStart}
	ontouchend={onTouchEnd}
	ontouchmove={onTouchMove}
	title={errorMessage}
>
	{#if loadingState === 'loading'}
		<span class="feed-loading-spinner"></span>
	{:else if loadingState === 'error'}
		<span class="feed-error-icon" title={errorMessage}>!</span>
	{:else if faviconUrl}
		<img src={faviconUrl} alt="" class="feed-favicon" />
	{:else}
		<span class="feed-favicon-placeholder"></span>
	{/if}
	<span class="nav-label">{subscription.title}</span>
	{#if loadingState === 'error'}
		<span
			class="retry-btn"
			role="button"
			tabindex="0"
			onclick={(e) => {
				e.stopPropagation();
				onRetry();
			}}
			onkeydown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					e.stopPropagation();
					onRetry();
				}
			}}
			title="Retry"
		>
			↻
		</span>
	{:else if unreadCount > 0}
		<span class="nav-count">{unreadCount}</span>
	{/if}
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

	.nav-item.has-error {
		color: var(--color-error);
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

	.feed-item {
		-webkit-touch-callout: none;
		-webkit-user-select: none;
		user-select: none;
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

	@media (prefers-color-scheme: dark) {
		.nav-item:hover {
			background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
		}
	}
</style>
