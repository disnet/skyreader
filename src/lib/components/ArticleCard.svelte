<script lang="ts">
	import type { Article } from '$lib/types';
	import { formatRelativeDate } from '$lib/utils/date';
	import { getFaviconUrl } from '$lib/utils/favicon';
	import DOMPurify from 'dompurify';

	let {
		article,
		siteUrl,
		isRead = false,
		isStarred = false,
		isShared = false,
		shareNote,
		reshareCount = 0,
		selected = false,
		expanded = false,
		onToggleStar,
		onToggleRead,
		onShare,
		onUnshare,
		onSelect,
		onExpand,
	}: {
		article: Article;
		siteUrl?: string;
		isRead?: boolean;
		isStarred?: boolean;
		isShared?: boolean;
		shareNote?: string;
		reshareCount?: number;
		selected?: boolean;
		expanded?: boolean;
		onToggleStar?: () => void;
		onToggleRead?: () => void;
		onShare?: () => void;
		onUnshare?: () => void;
		onSelect?: () => void;
		onExpand?: () => void;
	} = $props();

	function handleHeaderClick() {
		onSelect?.();
		// Note: onRead is NOT called here - selectArticle in +page.svelte handles marking as read
	}

	function handleExpandClick(e: MouseEvent) {
		e.stopPropagation();
		onExpand?.();
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

	let isOpen = $derived(selected || expanded);
	let hasContent = $derived(Boolean(article.content || article.summary));
	let sanitizedContent = $derived(DOMPurify.sanitize(article.content || article.summary || ''));

	let bodyEl = $state<HTMLElement | undefined>(undefined);
	let isTruncated = $state(false);

	$effect(() => {
		if (selected && !expanded && bodyEl) {
			// Check if content overflows the line clamp
			isTruncated = bodyEl.scrollHeight > bodyEl.clientHeight;
		}
	});
</script>

<article class="article-item" class:read={isRead} class:selected class:expanded class:open={isOpen}>
	<div class="article-sticky-header">
		<button class="article-header" onclick={handleHeaderClick}>
			{#if siteUrl}
				<img src={getFaviconUrl(siteUrl)} alt="" class="favicon" />
			{/if}
			{#if isOpen}
				<a
					href={article.url}
					target="_blank"
					rel="noopener"
					class="article-title-link"
					onclick={(e) => e.stopPropagation()}
				>
					{article.title}
				</a>
			{:else}
				<span class="article-title">{article.title}</span>
			{/if}
			<span class="article-date">{formatRelativeDate(article.publishedAt)}</span>
		</button>
	</div>

	{#if isOpen}
		<div
			class="article-content"
			onclick={selected && !expanded && isTruncated ? handleExpandClick : undefined}
			role={selected && !expanded && isTruncated ? 'button' : undefined}
		>
			{#if hasContent}
				<div class="article-body-wrapper" class:has-fade={selected && !expanded && isTruncated}>
					<div bind:this={bodyEl} class="article-body" class:truncated={selected && !expanded}>
						{@html sanitizedContent}
					</div>
				</div>
			{/if}
		</div>

		<div class="article-actions-container">
			<div class="article-actions">
				<button class="action-btn" class:unread={!isRead} onclick={handleToggleRead}>
					{isRead ? '○' : '●'}<span class="action-label">{isRead ? 'Read' : 'Unread'}</span>
				</button>
				<button class="action-btn" class:starred={isStarred} onclick={handleStarClick}>
					{isStarred ? '★' : '☆'}<span class="action-label">{isStarred ? ' Starred' : 'Star'}</span>
				</button>
				{#if isShared}
					<button class="action-btn shared" onclick={handleUnshare}>
						⤴<span class="action-label"> Shared</span>{#if reshareCount > 0}<span
								class="reshare-count">({reshareCount})</span
							>{/if}
					</button>
				{:else}
					<button class="action-btn" onclick={handleShare}
						>⤴<span class="action-label"> Share</span></button
					>
				{/if}
				<a
					href={article.url}
					target="_blank"
					rel="noopener"
					class="action-btn"
					onclick={(e) => e.stopPropagation()}
				>
					↗<span class="action-label"> Open</span>
				</a>
				{#if selected && !expanded && isTruncated}
					<span class="action-separator"></span>
					<button class="action-btn show-more-btn" onclick={handleExpandClick}
						>↓<span class="action-label"> More</span></button
					>
				{:else if expanded}
					<span class="action-separator"></span>
					<button class="action-btn show-less-btn" onclick={handleExpandClick}
						>↑<span class="action-label"> Less</span></button
					>
				{/if}
			</div>
		</div>
	{/if}
</article>

<style>
	.article-item {
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

	.article-sticky-header {
		position: relative;
	}

	.article-header {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		padding: 0.75rem 0.5rem;
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
		padding: 0 0.5rem;
	}

	.article-content[role='button'] {
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
		background: linear-gradient(to bottom, transparent, var(--color-bg, #ffffff));
		pointer-events: none;
	}

	@media (prefers-color-scheme: dark) {
		.article-body-wrapper.has-fade::after {
			background: linear-gradient(to bottom, transparent, var(--color-bg, #1a1a1a));
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

	@media (prefers-color-scheme: dark) {
		.action-separator {
			background: var(--color-border, #404040);
		}
	}

	@media (prefers-color-scheme: dark) {
		.article-item:not(.selected):not(.expanded):hover {
			background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
		}
	}

	.action-label {
		margin-left: 0.25rem;
	}

	/* Stage 2: Stack icon above text */
	@container (max-width: 420px) {
		.action-btn {
			flex-direction: column;
			gap: 0.125rem;
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
		.action-btn {
			font-size: 1.125rem;
		}
	}
</style>
