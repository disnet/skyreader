<script lang="ts">
  import type { Article } from '$lib/types';

  let {
    article,
    siteUrl,
    isRead = false,
    isStarred = false,
    selected = false,
    expanded = false,
    onRead,
    onToggleStar,
    onSelect,
    onExpand,
  }: {
    article: Article;
    siteUrl?: string;
    isRead?: boolean;
    isStarred?: boolean;
    selected?: boolean;
    expanded?: boolean;
    onRead?: () => void;
    onToggleStar?: () => void;
    onSelect?: () => void;
    onExpand?: () => void;
  } = $props();

  function getFaviconUrl(url: string): string {
    try {
      const domain = new URL(url).hostname;
      return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
    } catch {
      return '';
    }
  }

  function handleHeaderClick() {
    onSelect?.();
    if (!isRead && onRead) {
      onRead();
    }
  }

  function handleExpandClick(e: MouseEvent) {
    e.stopPropagation();
    onExpand?.();
  }

  function formatDate(dateString: string): string {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

    if (diffHours < 1) {
      const diffMinutes = Math.floor(diffMs / (1000 * 60));
      return `${diffMinutes}m ago`;
    }
    if (diffHours < 24) {
      return `${diffHours}h ago`;
    }
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) {
      return `${diffDays}d ago`;
    }
    return date.toLocaleDateString();
  }

  function handleStarClick(e: MouseEvent) {
    e.stopPropagation();
    onToggleStar?.();
  }

  let isOpen = $derived(selected || expanded);
  let hasContent = $derived(Boolean(article.content || article.summary));
</script>

<article class="article-item" class:read={isRead} class:selected class:expanded>
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
    <span class="article-date">{formatDate(article.publishedAt)}</span>
  </button>

  {#if isOpen}
    <div class="article-content">
      <div class="article-actions">
        <button
          class="star-btn"
          class:starred={isStarred}
          onclick={handleStarClick}
        >
          {isStarred ? '★ Starred' : '☆ Star'}
        </button>
      </div>
      {#if hasContent}
        <div class="article-body" class:truncated={selected && !expanded}>
          {@html article.content || article.summary}
        </div>
        {#if selected && !expanded}
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

  .article-item:hover {
    background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.03));
  }

  .article-item.read {
    opacity: 0.6;
  }

  .article-item.read:hover {
    opacity: 0.8;
  }

  .article-item.selected,
  .article-item.expanded {
    opacity: 1;
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

  .article-body {
    font-size: 0.9375rem;
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

  .article-actions {
    display: flex;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .star-btn {
    background: none;
    border: none;
    font-size: 0.875rem;
    color: var(--color-text-secondary);
    padding: 0;
    cursor: pointer;
  }

  .star-btn.starred {
    color: #ffc107;
  }

  .star-btn:hover {
    color: #ffc107;
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
    .article-item:hover {
      background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
    }
  }
</style>
