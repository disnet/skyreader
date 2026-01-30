<script lang="ts">
	import type { Article, SocialShare, BlueskyProfile } from '$lib/types';
	import { formatRelativeDate } from '$lib/utils/date';
	import { getFaviconUrl } from '$lib/utils/favicon';
	import { sanitizeHtml } from '$lib/utils/sanitize';
	import { profileService } from '$lib/services/profiles';
	import { sharesStore } from '$lib/stores/shares.svelte';
	import { auth } from '$lib/stores/auth.svelte';
	import Icon from './Icon.svelte';

	let {
		article,
		share,
		localArticle,
		siteUrl,
		isRead = false,
		isStarred = false,
		isShared = false,
		shareNote,
		reshareCount = 0,
		isFetching = false,
		selected = false,
		expanded = false,
		highlighted = false,
		onToggleStar,
		onToggleRead,
		onShare,
		onUnshare,
		onReshare,
		onSelect,
		onExpand,
		onFetchContent,
	}: {
		article?: Article;
		share?: SocialShare;
		localArticle?: Article;
		siteUrl?: string;
		isRead?: boolean;
		isStarred?: boolean;
		isShared?: boolean;
		shareNote?: string;
		reshareCount?: number;
		isFetching?: boolean;
		selected?: boolean;
		expanded?: boolean;
		highlighted?: boolean;
		onToggleStar?: () => void;
		onToggleRead?: () => void;
		onShare?: () => void;
		onUnshare?: () => void;
		onReshare?: () => void;
		onSelect?: () => void;
		onExpand?: () => void;
		onFetchContent?: () => void;
	} = $props();

	// Determine if we're in share mode (showing someone else's share)
	let isShareMode = $derived(Boolean(share && !article));

	// Normalize data for both article and share modes
	let itemUrl = $derived(article?.url || share?.itemUrl || '');
	let itemTitle = $derived(article?.title || share?.itemTitle || itemUrl);
	let itemPublishedAt = $derived(
		article?.publishedAt || share?.itemPublishedAt || share?.createdAt || ''
	);
	let itemGuid = $derived(article?.guid || share?.itemGuid || itemUrl);
	let displaySiteUrl = $derived(siteUrl || share?.feedUrl || itemUrl);

	// Content handling - article has priority, then share content, then localArticle
	let displayContent = $derived(
		article?.content ||
			article?.summary ||
			share?.content ||
			localArticle?.content ||
			localArticle?.summary ||
			share?.itemDescription ||
			''
	);

	// Profile fetching for share mode
	let authorProfile = $state<BlueskyProfile | null>(null);
	$effect(() => {
		if (share) {
			profileService.getProfile(share.authorDid).then((p) => {
				authorProfile = p;
			});
		}
	});
	let authorHandle = $derived(authorProfile?.handle || share?.authorDid);

	// Reshare state for share mode
	let isResharing = $state(false);
	let hasReshared = $derived.by(() => {
		if (!isShareMode) return false;
		const guid = itemGuid;
		return sharesStore.isShared(guid);
	});

	// Get reshare count from share if in share mode
	let displayReshareCount = $derived(share?.reshareCount || reshareCount);

	async function handleReshare(e: MouseEvent) {
		e.stopPropagation();
		if (isResharing || hasReshared || !share) return;
		if (!auth.user) return;

		isResharing = true;
		try {
			await sharesStore.reshare(
				share.recordUri,
				share.authorDid,
				share.itemUrl,
				share.itemGuid,
				share.itemTitle,
				undefined,
				share.itemDescription,
				share.content,
				share.itemImage,
				share.itemPublishedAt,
				share.feedUrl
			);
		} finally {
			isResharing = false;
		}
	}

	function handleHeaderClick() {
		const wasSelected = selected;
		onSelect?.();
		// Note: onRead is NOT called here - selectArticle in +page.svelte handles marking as read
		// For shares, fetch content when first selecting
		if (isShareMode && !wasSelected && onFetchContent) {
			onFetchContent();
		}
	}

	function handleExpandClick(e: MouseEvent) {
		e.stopPropagation();
		onExpand?.();
	}

	function handleContentClick(e: MouseEvent) {
		// Don't interfere with link clicks
		if ((e.target as HTMLElement).closest('a')) return;
		e.stopPropagation();

		if (selected && !expanded && isTruncated) {
			// Content is truncated, expand it (this also selects)
			onExpand?.();
		} else {
			// Not truncated or already expanded, just select
			onSelect?.();
		}
	}

	function handleStarClick(e: MouseEvent) {
		e.stopPropagation();
		onToggleStar?.();
	}

	function handleShare(e: MouseEvent) {
		e.stopPropagation();
		onShare?.();
	}

	function handleUnshare(e: MouseEvent) {
		e.stopPropagation();
		onUnshare?.();
	}

	function handleToggleRead(e: MouseEvent) {
		e.stopPropagation();
		onToggleRead?.();
	}

	function handleOpenUrl(e: MouseEvent) {
		e.stopPropagation();
		window.open(itemUrl, '_blank', 'noopener');
	}

	let isOpen = $derived(selected || expanded);
	let hasContent = $derived(Boolean(displayContent));
	let sanitizedContent = $derived(sanitizeHtml(displayContent, itemUrl));

	let bodyEl = $state<HTMLElement | undefined>(undefined);
	let isTruncated = $state(false);

	$effect(() => {
		if (selected && !expanded && bodyEl) {
			// Check if content overflows the line clamp
			isTruncated = bodyEl.scrollHeight > bodyEl.clientHeight;
		}
	});
</script>

<article
	class="article-item"
	class:read={isRead}
	class:selected
	class:expanded
	class:open={isOpen}
	class:highlighted
>
	<div class="article-sticky-header">
		{#if isShareMode && share}
			<div class="share-attribution">
				shared by <a
					href="/?sharer={share.authorDid}"
					class="share-author-link"
					onclick={(e) => e.stopPropagation()}>@{authorHandle}</a
				>
				{#if displayReshareCount > 0}
					<span class="attribution-reshare-count" title="{displayReshareCount} reshares"
						>({displayReshareCount})</span
					>
				{/if}
			</div>
		{/if}
		<button class="article-header" onclick={handleHeaderClick}>
			{#if displaySiteUrl}
				<img src={getFaviconUrl(displaySiteUrl)} alt="" class="favicon" />
			{/if}
			{#if isOpen}
				<a
					href={itemUrl}
					target="_blank"
					rel="noopener"
					class="article-title-link"
					onclick={(e) => e.stopPropagation()}
				>
					{itemTitle}
				</a>
			{:else}
				<span class="article-title">{itemTitle}</span>
			{/if}
			<span class="article-date">{formatRelativeDate(itemPublishedAt)}</span>
		</button>
	</div>

	{#if isOpen}
		<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
		<div class="article-content" onclick={handleContentClick}>
			{#if isFetching}
				<p class="article-loading">Loading article content...</p>
			{:else if hasContent}
				<div class="article-body-wrapper" class:has-fade={selected && !expanded && isTruncated}>
					<div bind:this={bodyEl} class="article-body" class:truncated={selected && !expanded}>
						{@html sanitizedContent}
					</div>
				</div>
			{/if}
		</div>

		<div class="article-actions-container">
			<div class="article-actions">
				{#if isShareMode}
					<!-- Share mode: read, reshare, and open -->
					<button class="action-btn" class:unread={!isRead} onclick={handleToggleRead}>
						<span class="action-icon">
							{#if isRead}
								<Icon name="circle" size={16} />
							{:else}
								<Icon name="circle-dot" size={16} />
							{/if}
						</span><span class="action-label">Read</span>
					</button>
					{#if auth.user}
						<button
							class="action-btn"
							class:reshared={hasReshared}
							onclick={handleReshare}
							disabled={isResharing || hasReshared}
						>
							<span class="action-icon"><Icon name="share" size={16} /></span><span
								class="action-label"
								>{#if isResharing}...{:else if hasReshared}Reshared{:else}Reshare{/if}</span
							>
						</button>
					{/if}
					<button class="action-btn" onclick={handleOpenUrl}>
						<span class="action-icon"><Icon name="external-link" size={16} /></span><span
							class="action-label">Open</span
						>
					</button>
				{:else}
					<!-- Article mode: full controls -->
					<button class="action-btn" class:unread={!isRead} onclick={handleToggleRead}>
						<span class="action-icon">
							{#if isRead}
								<Icon name="circle" size={16} />
							{:else}
								<Icon name="circle-dot" size={16} />
							{/if}
						</span><span class="action-label">Read</span>
					</button>
					<button class="action-btn" class:starred={isStarred} onclick={handleStarClick}>
						<span class="action-icon"><Icon name="star" size={16} /></span><span
							class="action-label">Later</span
						>
					</button>
					{#if isShared}
						<button class="action-btn shared" onclick={handleUnshare}>
							<span class="action-icon"><Icon name="share" size={16} /></span><span
								class="action-label">Share</span
							>{#if displayReshareCount > 0}<span class="reshare-count"
									>({displayReshareCount})</span
								>{/if}
						</button>
					{:else}
						<button class="action-btn" onclick={handleShare}
							><span class="action-icon"><Icon name="share" size={16} /></span><span
								class="action-label">Share</span
							></button
						>
					{/if}
					<button class="action-btn" onclick={handleOpenUrl}>
						<span class="action-icon"><Icon name="external-link" size={16} /></span><span
							class="action-label">Open</span
						>
					</button>
				{/if}
				<span class="action-separator"></span>
				{#if expanded}
					<button class="action-btn show-less-btn" onclick={handleExpandClick}
						><span class="action-icon"><Icon name="chevron-up" size={16} /></span><span
							class="action-label">Less</span
						></button
					>
				{:else}
					<button
						class="action-btn show-more-btn"
						class:disabled={!isTruncated}
						onclick={isTruncated ? handleExpandClick : undefined}
						><span class="action-icon"><Icon name="chevron-down" size={16} /></span><span
							class="action-label">More</span
						></button
					>
				{/if}
			</div>
		</div>
	{/if}
</article>

<style>
	.article-item {
		padding: 0 1rem;
		transition: background-color 0.15s ease;
	}

	.article-item:not(.selected):not(.expanded):hover {
		background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.03));
	}

	.article-item.read:not(.selected):not(.expanded) {
		opacity: 0.6;
	}

	.article-item.read:not(.selected):not(.expanded):hover {
		opacity: 0.8;
	}

	.article-item.highlighted {
		background-color: rgba(96, 165, 250, 0.05);
		border-radius: 8px;
	}

	.article-item:hover {
		background-color: rgba(128, 128, 128, 0.05);
		border-radius: 8px;
		--fade-bg: #f9f9f9;
	}

	.article-item.highlighted:hover {
		background-color: rgba(96, 165, 250, 0.08);
		--fade-bg: #f2f8ff;
	}

	.article-item.highlighted {
		--fade-bg: #f7fbff;
	}

	.article-sticky-header {
		position: relative;
	}

	.share-attribution {
		font-size: 0.75rem;
		color: var(--color-text-secondary);
		padding: 0.25rem 0 0;
	}

	.share-author-link {
		color: var(--color-text-secondary);
		text-decoration: none;
	}

	.share-author-link:hover {
		color: var(--color-primary);
		text-decoration: underline;
	}

	.attribution-reshare-count {
		font-size: 0.7rem;
		color: var(--color-text-secondary);
		margin-left: 0.25rem;
	}

	.article-header {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		padding: 0.5rem 0;
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

	.article-title {
		flex: 1;
		font-weight: 500;
		color: var(--color-text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.article-title-link {
		flex: 1;
		font-weight: 500;
		color: var(--color-primary, #0066cc);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-decoration: none;
	}

	.article-title-link:hover {
		text-decoration: underline;
	}

	.article-item.selected .article-title-link,
	.article-item.expanded .article-title-link {
		white-space: normal;
		text-overflow: unset;
	}

	.article-date {
		flex-shrink: 0;
		font-size: 0.875rem;
		color: var(--color-text-secondary);
	}

	.article-content {
		padding: 0;
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
		touch-action: manipulation;
	}

	.article-body-wrapper {
		position: relative;
	}

	.article-body-wrapper.has-fade::after {
		content: '';
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		height: 4em;
		background: linear-gradient(to bottom, transparent, var(--fade-bg, var(--color-bg, #ffffff)));
		pointer-events: none;
	}

	@media (prefers-color-scheme: dark) {
		.article-body-wrapper.has-fade::after {
			background: linear-gradient(to bottom, transparent, var(--fade-bg, var(--color-bg, #1a1a1a)));
		}
	}

	.article-body {
		font-family: var(--article-font);
		font-size: var(--article-font-size);
		line-height: 1.7;
		color: var(--color-text);
		overflow-wrap: break-word;
	}

	.article-body.truncated {
		display: -webkit-box;
		-webkit-line-clamp: 8;
		line-clamp: 8;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.article-body :global(img) {
		max-width: 100%;
		height: auto;
		border-radius: 4px;
		margin: 0.75rem 0;
	}

	.article-body :global(a) {
		color: var(--color-primary, #0066cc);
	}

	.article-body :global(pre) {
		background: var(--color-bg-secondary, #f3f4f6);
		padding: 0.75rem;
		border-radius: 4px;
		overflow-x: auto;
		font-size: 0.8rem;
	}

	.article-body :global(blockquote) {
		border-left: 3px solid var(--color-border);
		margin: 0.75rem 0;
		padding-left: 1rem;
		color: var(--color-text-secondary);
	}

	.article-body :global(p) {
		margin: 0.75rem 0;
	}

	.article-body :global(p:first-child) {
		margin-top: 0;
	}

	.article-body :global(p:last-child) {
		margin-bottom: 0;
	}

	.article-body :global(ul),
	.article-body :global(ol) {
		margin: 0.75rem 0;
		padding-left: 0.5rem;
		list-style-position: inside;
	}

	.article-body :global(li ul),
	.article-body :global(li ol) {
		padding-left: 1.5rem;
	}

	.article-body :global(li) {
		margin: 0.25rem 0;
	}

	.article-loading {
		font-size: 0.875rem;
		color: var(--color-text-secondary);
		margin-top: 0.5rem;
		font-style: italic;
	}

	.article-actions-container {
		position: sticky;
		bottom: 0;
		display: flex;
		justify-content: center;
		container-type: inline-size;
		padding: 1rem 0;
	}

	.article-actions {
		display: flex;
		flex-wrap: nowrap;
		align-items: center;
		gap: 0.875rem;
		padding: 0.5rem 1rem;
		background: rgba(255, 255, 255, 0.85);
		backdrop-filter: blur(8px);
		border-radius: 9999px;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
	}

	@media (prefers-color-scheme: dark) {
		.article-actions {
			background: rgba(40, 40, 40, 0.95);
			box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
		}
	}

	.action-btn {
		display: flex;
		align-items: center;
		white-space: nowrap;
		background: none;
		border: none;
		font-size: 1rem;
		color: var(--color-text-secondary);
		padding: 0;
		cursor: pointer;
		text-decoration: none;
	}

	.action-btn:hover {
		color: var(--color-primary, #0066cc);
	}

	.action-btn.starred {
		color: #ffc107;
	}

	.action-btn.starred:hover {
		color: #ffc107;
	}

	.action-btn.unread {
		color: var(--color-primary, #0066cc);
	}

	.action-btn.unread:hover {
		color: var(--color-primary, #0066cc);
	}

	.action-btn.shared {
		color: var(--color-primary, #0066cc);
	}

	.action-btn.reshared {
		color: var(--color-success, #22c55e);
	}

	.action-btn:disabled {
		cursor: default;
		opacity: 0.7;
	}

	.reshare-count {
		font-size: 0.75rem;
		margin-left: 0.25rem;
	}

	.action-separator {
		width: 1px;
		background: var(--color-border, #e5e7eb);
		align-self: stretch;
		margin: -0.25rem 0;
	}

	.action-btn.show-more-btn,
	.action-btn.show-less-btn {
		color: var(--color-primary, #0066cc);
	}

	.action-btn.disabled {
		color: var(--color-text-secondary);
		opacity: 0.4;
		cursor: default;
	}

	@media (prefers-color-scheme: dark) {
		.action-separator {
			background: var(--color-border, #404040);
		}
	}

	@media (prefers-color-scheme: dark) {
		.article-item:not(.selected):not(.expanded):hover {
			background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
		}

		.article-item:hover {
			--fade-bg: #1f1f1f;
		}

		.article-item.highlighted {
			--fade-bg: #1e2125;
		}

		.article-item.highlighted:hover {
			--fade-bg: #20252c;
		}
	}

	.action-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.action-btn.starred .action-icon :global(.icon) {
		fill: currentColor;
	}

	.action-label {
		margin-left: 0.25rem;
		font-size: 0.875rem;
	}

	/* Stage 2: Stack icon above text */
	@container (max-width: 420px) {
		.article-actions {
			padding: 0.375rem 1rem;
		}
		.action-btn {
			flex-direction: column;
			align-items: center;
			justify-content: center;
			gap: 0.125rem;
			text-align: center;
		}
		.action-label {
			margin-left: 0;
			font-size: 0.75rem;
		}
	}

	/* Stage 3: Icons only */
	@container (max-width: 320px) {
		.action-label {
			display: none;
		}
	}
</style>
