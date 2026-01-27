<script lang="ts">
	import type { Article, FeedItem, SocialShare, GroupedShare, BlueskyProfile } from '$lib/types';
	import { formatRelativeDate } from '$lib/utils/date';
	import { getFaviconUrl } from '$lib/utils/favicon';
	import { profileService } from '$lib/services/profiles';
	import { sharesStore } from '$lib/stores/shares.svelte';
	import { auth } from '$lib/stores/auth.svelte';
	import DOMPurify from 'dompurify';

	let {
		share,
		groupedShare,
		localArticle,
		remoteArticle,
		isFetching = false,
		isRead = false,
		selected = false,
		expanded = false,
		onSelect,
		onExpand,
		onFetchContent,
	}: {
		share?: SocialShare;
		groupedShare?: GroupedShare;
		localArticle?: Article;
		remoteArticle?: FeedItem;
		isFetching?: boolean;
		isRead?: boolean;
		selected?: boolean;
		expanded?: boolean;
		onSelect?: () => void;
		onExpand?: () => void;
		onFetchContent?: () => void;
	} = $props();

	// Normalize data for both single share and grouped share modes
	let itemUrl = $derived(share?.itemUrl || groupedShare?.itemUrl || '');
	let itemTitle = $derived(share?.itemTitle || groupedShare?.itemTitle);
	let itemDescription = $derived(share?.itemDescription || groupedShare?.itemDescription);
	let itemPublishedAt = $derived(share?.itemPublishedAt || groupedShare?.itemPublishedAt);
	let itemGuid = $derived(share?.itemGuid || groupedShare?.itemGuid);
	let feedUrl = $derived(share?.feedUrl || groupedShare?.feedUrl);
	let displayContent = $derived(share?.content || groupedShare?.content);
	let displayDate = $derived(
		share?.itemPublishedAt || share?.createdAt || groupedShare?.latestShareAt || ''
	);

	// For grouped shares, get profile info for first few sharers
	let sharerProfiles = $state<Map<string, BlueskyProfile>>(new Map());
	let authorProfile = $state<BlueskyProfile | null>(null);

	// Single share mode - get author profile
	$effect(() => {
		if (share) {
			profileService.getProfile(share.authorDid).then((p) => {
				authorProfile = p;
			});
		}
	});

	// Grouped share mode - get profiles for sharers
	$effect(() => {
		if (groupedShare) {
			for (const sharer of groupedShare.sharers.slice(0, 3)) {
				profileService.getProfile(sharer.did).then((p) => {
					if (p) {
						sharerProfiles.set(sharer.did, p);
						sharerProfiles = new Map(sharerProfiles);
					}
				});
			}
		}
	});

	let authorHandle = $derived(authorProfile?.handle || share?.authorDid);

	// Build attribution text for grouped shares
	let groupedAttribution = $derived.by(() => {
		if (!groupedShare) return '';
		const sharers = groupedShare.sharers;
		if (sharers.length === 0) return '';

		const firstSharer = sharers[0];
		const firstHandle =
			sharerProfiles.get(firstSharer.did)?.handle || firstSharer.did.slice(0, 16) + '...';

		if (sharers.length === 1) {
			return `@${firstHandle}`;
		}
		if (sharers.length === 2) {
			const secondHandle =
				sharerProfiles.get(sharers[1].did)?.handle || sharers[1].did.slice(0, 16) + '...';
			return `@${firstHandle} and @${secondHandle}`;
		}

		const othersCount = sharers.length - 1;
		return `@${firstHandle} and ${othersCount} others`;
	});

	// Reshare functionality
	let isResharing = $state(false);
	let hasReshared = $derived.by(() => {
		const guid = itemGuid || itemUrl;
		return sharesStore.isShared(guid);
	});

	// Get reshare count - for single share or first sharer in grouped
	let reshareCount = $derived.by(() => {
		if (share?.reshareCount) return share.reshareCount;
		if (groupedShare?.sharers?.[0]?.reshareCount) return groupedShare.sharers[0].reshareCount;
		return 0;
	});

	async function handleReshare(e: MouseEvent) {
		e.stopPropagation();
		if (isResharing || hasReshared) return;
		if (!auth.user) return;

		isResharing = true;
		try {
			// Get the target share URI and author for reshare
			const targetUri = share?.recordUri || groupedShare?.firstSharer?.recordUri;
			const targetAuthorDid = share?.authorDid || groupedShare?.firstSharer?.did;

			if (!targetUri || !targetAuthorDid) return;

			await sharesStore.reshare(
				targetUri,
				targetAuthorDid,
				itemUrl,
				itemGuid,
				itemTitle,
				undefined, // articleAuthor
				itemDescription,
				displayContent,
				share?.itemImage || groupedShare?.itemImage,
				itemPublishedAt,
				feedUrl
			);
		} finally {
			isResharing = false;
		}
	}

	function handleHeaderClick() {
		const wasSelected = selected;
		onSelect?.();
		// Fetch article content if needed when selecting
		if (!wasSelected && onFetchContent) {
			onFetchContent();
		}
	}

	function handleExpandClick(e: MouseEvent) {
		e.stopPropagation();
		onExpand?.();
	}

	let isOpen = $derived(selected || expanded);
	let articleContent = $derived(
		displayContent ||
			localArticle?.content ||
			localArticle?.summary ||
			remoteArticle?.content ||
			remoteArticle?.summary
	);
	let sanitizedContent = $derived(articleContent ? DOMPurify.sanitize(articleContent) : '');
	let sanitizedDescription = $derived(itemDescription ? DOMPurify.sanitize(itemDescription) : '');
	let hasContent = $derived(Boolean(articleContent || itemDescription));

	let bodyEl = $state<HTMLElement | undefined>(undefined);
	let isTruncated = $state(false);

	$effect(() => {
		// Access articleContent to create dependency
		const content = articleContent;
		if (selected && !expanded && bodyEl) {
			// Use requestAnimationFrame to ensure DOM has rendered
			requestAnimationFrame(() => {
				if (bodyEl) {
					isTruncated = bodyEl.scrollHeight > bodyEl.clientHeight;
				}
			});
		}
	});
</script>

<div class="share-item" class:read={isRead} class:selected class:expanded>
	<div class="share-sticky-header">
		<div class="share-attribution">
			{#if groupedShare}
				shared by {groupedAttribution}
			{:else if share}
				shared by <a href="/?sharer={share.authorDid}" class="share-author-link">@{authorHandle}</a>
			{/if}
			{#if reshareCount > 0}
				<span class="reshare-count" title="{reshareCount} reshares">({reshareCount})</span>
			{/if}
		</div>
		<button class="share-header" onclick={handleHeaderClick}>
			<img src={getFaviconUrl(itemUrl)} alt="" class="favicon" />
			{#if isOpen}
				<a
					href={itemUrl}
					target="_blank"
					rel="noopener"
					class="share-title-link"
					onclick={(e) => e.stopPropagation()}
				>
					{itemTitle || itemUrl}
				</a>
			{:else}
				<span class="share-title">{itemTitle || itemUrl}</span>
			{/if}
			<span class="share-date">{formatRelativeDate(displayDate)}</span>
		</button>

		{#if isOpen}
			<div class="share-actions">
				<a
					href={itemUrl}
					target="_blank"
					rel="noopener"
					class="action-btn"
					onclick={(e) => e.stopPropagation()}
				>
					↗ Open
				</a>
				{#if auth.user}
					<button
						class="action-btn reshare-btn"
						class:reshared={hasReshared}
						onclick={handleReshare}
						disabled={isResharing || hasReshared}
						title={hasReshared ? 'Already reshared' : 'Reshare'}
					>
						{#if isResharing}
							...
						{:else if hasReshared}
							Reshared
						{:else}
							Reshare
						{/if}
					</button>
				{/if}
				{#if hasContent}
					<button class="action-btn expand-btn" onclick={handleExpandClick}>
						{expanded ? '↑ Collapse' : '↓ Expand'}
					</button>
				{/if}
			</div>
		{/if}
	</div>

	{#if isOpen}
		<div
			class="share-content"
			onclick={selected && !expanded && isTruncated ? handleExpandClick : undefined}
			role={selected && !expanded && isTruncated ? 'button' : undefined}
		>
			{#if articleContent}
				<div class="share-body-wrapper" class:has-fade={selected && !expanded && isTruncated}>
					<div bind:this={bodyEl} class="share-body" class:truncated={selected && !expanded}>
						{@html sanitizedContent}
					</div>
				</div>
				{#if selected && !expanded && isTruncated}
					<button class="show-more-btn" onclick={handleExpandClick}> Show more </button>
				{/if}
			{:else if isFetching}
				<p class="share-loading">Loading article content...</p>
			{:else if sanitizedDescription}
				<div class="share-body-wrapper" class:has-fade={selected && !expanded && isTruncated}>
					<div bind:this={bodyEl} class="share-body" class:truncated={selected && !expanded}>
						{@html sanitizedDescription}
					</div>
				</div>
				{#if selected && !expanded && isTruncated}
					<button class="show-more-btn" onclick={handleExpandClick}> Show more </button>
				{/if}
			{/if}
		</div>
	{/if}
</div>

<style>
	.share-item {
		transition:
			background-color 0.15s ease,
			opacity 0.15s ease;
	}

	.share-item.read:not(.selected):not(.expanded) {
		opacity: 0.6;
	}

	.share-item.read:not(.selected):not(.expanded):hover {
		opacity: 0.8;
	}

	.share-item:not(.selected):not(.expanded):hover {
		background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.03));
	}

	.share-attribution {
		font-size: 0.75rem;
		color: var(--color-text-secondary);
		padding: 0.5rem 0.5rem 0;
	}

	.share-author-link {
		color: var(--color-text-secondary);
		text-decoration: none;
	}

	.share-author-link:hover {
		color: var(--color-primary);
		text-decoration: underline;
	}

	.share-sticky-header {
		position: relative;
	}

	.share-item.expanded .share-sticky-header {
		position: sticky;
		top: 0;
		z-index: 10;
	}

	.share-item.expanded .share-sticky-header::before {
		content: '';
		position: absolute;
		top: 0;
		bottom: 0;
		left: -1rem;
		right: -1rem;
		background: var(--color-bg, #ffffff);
		z-index: -1;
	}

	@media (max-width: 768px) {
		.share-item.expanded .share-sticky-header {
			top: 3rem;
		}
	}

	@media (prefers-color-scheme: dark) {
		.share-item.expanded .share-sticky-header::before {
			background: var(--color-bg, #1a1a1a);
		}
	}

	.share-header {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		padding: 0.5rem 0.5rem 0.75rem;
		background: none;
		border: none;
		cursor: pointer;
		text-align: left;
		font: inherit;
	}

	.favicon {
		width: 16px;
		height: 16px;
		flex-shrink: 0;
	}

	.share-title {
		flex: 1;
		font-weight: 500;
		color: var(--color-text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.share-title-link {
		flex: 1;
		font-weight: 500;
		color: var(--color-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-decoration: none;
	}

	.share-title-link:hover {
		text-decoration: underline;
	}

	.share-item.selected .share-title-link,
	.share-item.expanded .share-title-link {
		white-space: normal;
		text-overflow: unset;
	}

	.share-date {
		flex-shrink: 0;
		font-size: 0.875rem;
		color: var(--color-text-secondary);
	}

	.share-content {
		padding: 0 0.5rem 1rem;
	}

	.share-content[role='button'] {
		cursor: pointer;
	}

	.share-actions {
		display: flex;
		gap: 1rem;
		padding: 0 0.5rem 0.5rem;
	}

	.action-btn {
		background: none;
		border: none;
		font-size: 0.875rem;
		color: var(--color-text-secondary);
		padding: 0;
		cursor: pointer;
		text-decoration: none;
	}

	.action-btn:hover {
		color: var(--color-primary);
	}

	.action-btn.expand-btn {
		margin-left: auto;
	}

	.action-btn.reshare-btn {
		color: var(--color-text-secondary);
	}

	.action-btn.reshare-btn:hover:not(:disabled) {
		color: var(--color-primary);
	}

	.action-btn.reshare-btn.reshared {
		color: var(--color-success, #22c55e);
	}

	.action-btn.reshare-btn:disabled {
		cursor: default;
		opacity: 0.7;
	}

	.reshare-count {
		font-size: 0.7rem;
		color: var(--color-text-secondary);
		margin-left: 0.25rem;
	}

	.share-body-wrapper {
		position: relative;
	}

	.share-body-wrapper.has-fade::after {
		content: '';
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		height: 4em;
		background: linear-gradient(to bottom, transparent, var(--color-bg, #ffffff));
		pointer-events: none;
	}

	@media (prefers-color-scheme: dark) {
		.share-body-wrapper.has-fade::after {
			background: linear-gradient(to bottom, transparent, var(--color-bg, #1a1a1a));
		}
	}

	.share-body {
		font-family: var(--article-font);
		font-size: var(--article-font-size);
		line-height: 1.7;
		color: var(--color-text);
		overflow-wrap: break-word;
	}

	.share-body.truncated {
		display: -webkit-box;
		-webkit-line-clamp: 8;
		line-clamp: 8;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.share-body :global(img) {
		max-width: 100%;
		height: auto;
		border-radius: 4px;
		margin: 0.75rem 0;
	}

	.share-body :global(a) {
		color: var(--color-primary);
	}

	.share-body :global(pre) {
		background: var(--color-bg-secondary);
		padding: 0.75rem;
		border-radius: 4px;
		overflow-x: auto;
		font-size: 0.8rem;
	}

	.share-body :global(blockquote) {
		border-left: 3px solid var(--color-border);
		margin: 0.75rem 0;
		padding-left: 1rem;
		color: var(--color-text-secondary);
	}

	.share-body :global(p) {
		margin: 0.75rem 0;
	}

	.share-body :global(p:first-child) {
		margin-top: 0;
	}

	.share-body :global(p:last-child) {
		margin-bottom: 0;
	}

	.share-body :global(ul),
	.share-body :global(ol) {
		margin: 0.75rem 0;
		padding-left: 0.5rem;
		list-style-position: inside;
	}

	.share-body :global(li ul),
	.share-body :global(li ol) {
		padding-left: 1.5rem;
	}

	.share-body :global(li) {
		margin: 0.25rem 0;
	}

	.share-loading {
		font-size: 0.875rem;
		color: var(--color-text-secondary);
		margin-top: 0.5rem;
		font-style: italic;
	}

	.show-more-btn {
		background: none;
		border: none;
		color: var(--color-primary);
		font-size: 0.875rem;
		padding: 0.5rem 0 0;
		cursor: pointer;
	}

	.show-more-btn:hover {
		text-decoration: underline;
	}

	@media (prefers-color-scheme: dark) {
		.share-item:not(.selected):not(.expanded):hover {
			background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
		}
	}
</style>
