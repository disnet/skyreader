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
    selected = false,
    expanded = false,
    onToggleStar,
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
    selected?: boolean;
    expanded?: boolean;
    onToggleStar?: () => void;
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

<article class="article-item" class:read={isRead} class:selected class:expanded>
  <div class="article-sticky-header">
    <button class="article-header" onclick={handleHeaderClick}>
      {#if siteUrl}
        <img src={getFaviconUrl(siteUrl)} alt="" class="favicon" />
      {/if}
      {#if isOpen}
        <a href={article.url} target="_blank" rel="noopener" class="article-title-link" onclick={(e) => e.stopPropagation()}>
          {article.title}
        </a>
      {:else}
        <span class="article-title">{article.title}</span>
      {/if}
      <span class="article-date">{formatRelativeDate(article.publishedAt)}</span>
    </button>

    {#if isOpen}
      <div class="article-actions">
        <a href={article.url} target="_blank" rel="noopener" class="action-btn" onclick={(e) => e.stopPropagation()}>
          ↗ Open
        </a>
        <button
          class="action-btn"
          class:starred={isStarred}
          onclick={handleStarClick}
        >
          {isStarred ? '★ Starred' : '☆ Star'}
        </button>
        {#if isShared}
          <button class="action-btn shared" onclick={handleUnshare}>
            ↑ Shared
          </button>
        {:else}
          <button class="action-btn" onclick={handleShare}>
            ↑ Share
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
    <div class="article-content" onclick={selected && !expanded && isTruncated ? handleExpandClick : undefined} role={selected && !expanded && isTruncated ? "button" : undefined}>
      {#if hasContent}
        <div class="article-body-wrapper" class:has-fade={selected && !expanded && isTruncated}>
          <div bind:this={bodyEl} class="article-body" class:truncated={selected && !expanded}>
            {@html sanitizedContent}
          </div>
        </div>
        {#if selected && !expanded && isTruncated}
          <button class="show-more-btn" onclick={handleExpandClick}>
            Show more
          </button>
        {/if}
      {/if}
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

  .article-item.expanded .article-sticky-header {
    position: sticky;
    top: 0;
    z-index: 10;
  }

  .article-item.expanded .article-sticky-header::before {
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
    .article-item.expanded .article-sticky-header {
      top: 3rem;
    }
  }

  @media (prefers-color-scheme: dark) {
    .article-item.expanded .article-sticky-header::before {
      background: var(--color-bg, #1a1a1a);
    }
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

  .article-date {
    flex-shrink: 0;
    font-size: 0.875rem;
    color: var(--color-text-secondary);
  }

  .article-content {
    padding: 0 0.5rem 1rem;
  }

  .article-content[role="button"] {
    cursor: pointer;
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

  .article-actions {
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
    color: var(--color-primary, #0066cc);
  }

  .action-btn.starred {
    color: #ffc107;
  }

  .action-btn.starred:hover {
    color: #ffc107;
  }

  .action-btn.shared {
    color: var(--color-primary, #0066cc);
  }

  .action-btn.expand-btn {
    margin-left: auto;
  }

  .show-more-btn {
    background: none;
    border: none;
    color: var(--color-primary, #0066cc);
    font-size: 0.875rem;
    padding: 0.5rem 0 0;
    cursor: pointer;
  }

  .show-more-btn:hover {
    text-decoration: underline;
  }

  @media (prefers-color-scheme: dark) {
    .article-item:not(.selected):not(.expanded):hover {
      background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
    }
  }
</style>
