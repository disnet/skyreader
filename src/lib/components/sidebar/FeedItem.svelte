<script lang="ts">
	import { getFaviconUrl } from '$lib/utils/favicon';
	import type { Subscription } from '$lib/types';
	import type { ErrorDetails } from '$lib/stores/feedStatus.svelte';
	import FeedErrorPopover from './FeedErrorPopover.svelte';

	type LoadingState = 'loading' | 'error' | 'ready';

	interface Props {
		subscription: Subscription;
		unreadCount: number;
		isActive: boolean;
		loadingState?: LoadingState;
		errorMessage?: string;
		errorDetails?: ErrorDetails | null;
		onSelect: () => void;
		onContextMenu: (e: MouseEvent) => void;
		onTouchStart: (e: TouchEvent) => void;
		onTouchEnd: (e: TouchEvent) => void;
		onTouchMove: () => void;
		onRetry: () => void | Promise<unknown>;
	}

	const MIN_SPINNER_TIME = 600;

	let {
		subscription,
		unreadCount,
		isActive,
		loadingState = 'ready',
		errorMessage = '',
		errorDetails = null,
		onSelect,
		onContextMenu,
		onTouchStart,
		onTouchEnd,
		onTouchMove,
		onRetry,
	}: Props = $props();

	let faviconUrl = $derived(getFaviconUrl(subscription.siteUrl || subscription.feedUrl));
	let faviconLoaded = $state(false);

	function handleFaviconLoad() {
		faviconLoaded = true;
	}

	function handleFaviconError() {
		faviconLoaded = true; // Show broken state rather than staying hidden
	}

	let showErrorPopover = $state(false);
	let errorIconRef: HTMLSpanElement | null = $state(null);
	let popoverPosition = $state({ top: 0, left: 0 });
	let hideTimeout: ReturnType<typeof setTimeout> | null = null;

	function handleErrorIconMouseEnter() {
		if (hideTimeout) {
			clearTimeout(hideTimeout);
			hideTimeout = null;
		}
		if (errorIconRef) {
			const rect = errorIconRef.getBoundingClientRect();
			popoverPosition = {
				top: rect.bottom + 4,
				left: rect.left,
			};
		}
		showErrorPopover = true;
	}

	function handleErrorIconMouseLeave() {
		hideTimeout = setTimeout(() => {
			showErrorPopover = false;
		}, 150);
	}

	function handlePopoverMouseEnter() {
		if (hideTimeout) {
			clearTimeout(hideTimeout);
			hideTimeout = null;
		}
	}

	function handlePopoverMouseLeave() {
		hideTimeout = setTimeout(() => {
			showErrorPopover = false;
		}, 150);
	}

	let retrying = $state(false);

	async function handleRetry() {
		if (retrying) return;
		retrying = true;

		const minTimePromise = new Promise((resolve) => setTimeout(resolve, MIN_SPINNER_TIME));
		const retryPromise = Promise.resolve(onRetry());

		await Promise.all([minTimePromise, retryPromise]);
		retrying = false;
	}
</script>

<div class="feed-item-wrapper">
	<button
		class="nav-item sub-item feed-item"
		class:active={isActive}
		class:has-error={loadingState === 'error'}
		onclick={onSelect}
		oncontextmenu={onContextMenu}
		ontouchstart={onTouchStart}
		ontouchend={onTouchEnd}
		ontouchmove={onTouchMove}
	>
		{#if loadingState === 'loading'}
			<span class="feed-loading-spinner"></span>
		{:else if loadingState === 'error'}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<span
				bind:this={errorIconRef}
				class="feed-error-icon"
				class:permanent={errorDetails?.isPermanent}
				onmouseenter={handleErrorIconMouseEnter}
				onmouseleave={handleErrorIconMouseLeave}>!</span
			>
		{:else if faviconUrl}
			<img
				src={faviconUrl}
				alt=""
				class="feed-favicon"
				class:favicon-loaded={faviconLoaded}
				onload={handleFaviconLoad}
				onerror={handleFaviconError}
			/>
		{:else}
			<span class="feed-favicon-placeholder"></span>
		{/if}
		<span class="nav-label">{subscription.title}</span>
		{#if loadingState === 'error'}
			<span
				class="retry-btn"
				class:retrying
				role="button"
				tabindex="0"
				onclick={(e) => {
					e.stopPropagation();
					handleRetry();
				}}
				onkeydown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						e.stopPropagation();
						handleRetry();
					}
				}}
				title="Retry"
			>
				{#if retrying}
					<span class="retry-spinner"></span>
				{:else}
					↻
				{/if}
			</span>
		{:else if unreadCount > 0}
			<span class="nav-count">{unreadCount}</span>
		{/if}
	</button>

	{#if showErrorPopover && errorDetails}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="error-popover-container"
			style="top: {popoverPosition.top}px; left: {popoverPosition.left}px;"
			onmouseenter={handlePopoverMouseEnter}
			onmouseleave={handlePopoverMouseLeave}
		>
			<FeedErrorPopover {errorDetails} />
		</div>
	{/if}
</div>

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

	.feed-item-wrapper {
		position: relative;
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
		opacity: 0;
		transition: opacity 0.2s ease;
	}

	.feed-favicon.favicon-loaded {
		opacity: 1;
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
		background: var(--color-warning, #ff9800);
		color: white;
		border-radius: 50%;
		font-size: 0.75rem;
		font-weight: bold;
		cursor: help;
	}

	.feed-error-icon.permanent {
		background: var(--color-error);
	}

	.error-popover-container {
		position: fixed;
		z-index: 1000;
	}

	.retry-btn {
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
	}

	.retry-btn.retrying {
		cursor: default;
		pointer-events: none;
	}

	.retry-spinner {
		width: 12px;
		height: 12px;
		border: 2px solid var(--color-border);
		border-top-color: var(--color-primary);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
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
