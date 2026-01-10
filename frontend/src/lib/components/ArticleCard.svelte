<script lang="ts">
  import type { Article } from '$lib/types';

  let {
    article,
    isRead = false,
    isStarred = false,
    onRead,
    onToggleStar,
  }: {
    article: Article;
    isRead?: boolean;
    isStarred?: boolean;
    onRead?: () => void;
    onToggleStar?: () => void;
  } = $props();

  let expanded = $state(false);

  function toggleExpanded(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    expanded = !expanded;
    if (!isRead && onRead) {
      onRead();
    }
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

  function handleClick() {
    if (!isRead && onRead) {
      onRead();
    }
  }
</script>

<article class="article-card" class:read={isRead}>
  <a href={article.url} target="_blank" rel="noopener" onclick={handleClick} class="article-link">
    {#if article.imageUrl}
      <img src={article.imageUrl} alt="" class="article-image" />
    {/if}
    <div class="article-content">
      <h3 class="article-title">{article.title}</h3>
      {#if expanded && (article.content || article.summary)}
        <div class="article-body">{@html article.content || article.summary}</div>
      {:else if article.summary}
        <p class="article-summary">{@html article.summary.slice(0, 200)}{article.summary.length > 200 ? '...' : ''}</p>
      {/if}
      <div class="article-meta">
        {#if article.author}
          <span class="author">{article.author}</span>
        {/if}
        <span class="date">{formatDate(article.publishedAt)}</span>
        {#if article.content || (article.summary && article.summary.length > 200)}
          <button class="expand-btn" onclick={toggleExpanded}>
            {expanded ? 'Show less' : 'Show more'}
          </button>
        {/if}
      </div>
    </div>
  </a>
  <div class="article-actions">
    <button
      class="star-btn"
      class:starred={isStarred}
      onclick={(e) => { e.preventDefault(); onToggleStar?.(); }}
      title={isStarred ? 'Remove star' : 'Add star'}
    >
      {isStarred ? '★' : '☆'}
    </button>
  </div>
</article>

<style>
  .article-card {
    display: flex;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    overflow: hidden;
    transition: box-shadow 0.2s;
  }

  .article-card:hover {
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  }

  .article-card.read {
    opacity: 0.7;
  }

  .article-link {
    flex: 1;
    display: flex;
    text-decoration: none;
    color: inherit;
    gap: 1rem;
    padding: 1rem;
  }

  .article-image {
    width: 120px;
    height: 80px;
    object-fit: cover;
    border-radius: 4px;
    flex-shrink: 0;
  }

  .article-content {
    flex: 1;
    min-width: 0;
  }

  .article-title {
    font-size: 1rem;
    font-weight: 600;
    margin-bottom: 0.5rem;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .article-summary {
    font-size: 0.875rem;
    color: var(--color-text-secondary);
    margin-bottom: 0.5rem;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .article-meta {
    font-size: 0.75rem;
    color: var(--color-text-secondary);
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .expand-btn {
    background: none;
    border: none;
    color: var(--color-primary, #3b82f6);
    cursor: pointer;
    font-size: 0.75rem;
    padding: 0;
    margin-left: auto;
  }

  .expand-btn:hover {
    text-decoration: underline;
  }

  .article-body {
    font-size: 0.875rem;
    line-height: 1.6;
    color: var(--color-text);
    margin-bottom: 0.75rem;
    overflow-wrap: break-word;
  }

  .article-body :global(img) {
    max-width: 100%;
    height: auto;
    border-radius: 4px;
    margin: 0.5rem 0;
  }

  .article-body :global(a) {
    color: var(--color-primary, #3b82f6);
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
    margin: 0.5rem 0;
    padding-left: 1rem;
    color: var(--color-text-secondary);
  }

  .article-actions {
    display: flex;
    flex-direction: column;
    padding: 0.5rem;
  }

  .star-btn {
    background: none;
    border: none;
    font-size: 1.25rem;
    color: var(--color-text-secondary);
    padding: 0.25rem;
    cursor: pointer;
  }

  .star-btn.starred {
    color: #ffc107;
  }

  .star-btn:hover {
    color: #ffc107;
  }

  @media (max-width: 480px) {
    .article-link {
      flex-direction: column;
    }

    .article-image {
      width: 100%;
      height: 150px;
    }
  }
</style>
