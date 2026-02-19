<script lang="ts">
  import type { Article } from '$lib/types';
  import { sanitizeHtml } from '$lib/utils/sanitize';
  import { formatRelativeDate } from '$lib/utils/date';
  import { getFaviconUrl } from '$lib/utils/favicon';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { readingStore } from '$lib/stores/reading.svelte';
  import { isLeafletContent, renderLeafletContent } from '$lib/utils/leaflet-renderer';
  import { isPcktBlogContent, renderPcktBlogContent } from '$lib/utils/pckt-blog-renderer';
  import { isOffprintContent, renderOffprintContent } from '$lib/utils/offprint-renderer';
  import { isGreengaleContent, renderGreengaleContent } from '$lib/utils/greengale-renderer';
  import { bskyEmbed } from '$lib/actions/bsky-embed';
  import Icon from '$lib/components/Icon.svelte';

  let {
    article,
    onClose,
    onArchive,
    onRemoveBookmark,
  }: {
    article: Article;
    onClose: () => void;
    onArchive?: () => void;
    onRemoveBookmark?: () => void;
  } = $props();

  let sub = $derived(subscriptionsStore.subscriptions.find((s) => s.id === article.subscriptionId));
  let feedTitle = $derived(sub?.customTitle || sub?.title || '');
  let faviconUrl = $derived(getFaviconUrl(sub?.siteUrl || sub?.feedUrl || article.url));
  let isArchived = $derived(readingStore.isArchived(article.guid));

  let displayContent = $derived(article.content || article.summary || '');
  let sanitizedContent = $derived(sanitizeHtml(displayContent, article.url));

  // Read time estimate
  let readTimeMinutes = $derived.by(() => {
    const text = displayContent.replace(/<[^>]*>/g, '');
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(wordCount / 200));
  });

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'e' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      onArchive?.();
    }
  }

  function handleOpenUrl() {
    window.open(article.url, '_blank', 'noopener');
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="reader-overlay">
  <div class="reader-container">
    <header class="reader-header">
      <button class="reader-btn" onclick={onClose} title="Back (Escape)">
        <Icon name="arrow-left" size={20} />
      </button>

      <div class="reader-header-spacer"></div>

      <button
        class="reader-btn"
        onclick={() => onArchive?.()}
        title={isArchived ? 'Move to inbox' : 'Archive (e)'}
      >
        <Icon name={isArchived ? 'inbox' : 'archive'} size={20} />
      </button>

      <button class="reader-btn" onclick={() => onRemoveBookmark?.()} title="Remove bookmark">
        <Icon name="bookmark" size={20} />
      </button>

      <button class="reader-btn" onclick={handleOpenUrl} title="Open in new tab">
        <Icon name="external-link" size={20} />
      </button>
    </header>

    <article class="reader-article">
      <div class="reader-article-header">
        <h1 class="reader-title">{article.title || article.url}</h1>
        <div class="reader-meta">
          {#if faviconUrl}
            <img src={faviconUrl} alt="" class="reader-favicon" />
          {/if}
          {#if feedTitle}
            <span class="reader-feed">{feedTitle}</span>
          {/if}
          {#if article.author}
            <span class="reader-author">by {article.author}</span>
          {/if}
          <span class="reader-date">{formatRelativeDate(article.publishedAt)}</span>
          <span class="reader-read-time">
            <Icon name="clock" size={12} />
            {readTimeMinutes} min read
          </span>
        </div>
      </div>

      <div class="reader-body" use:bskyEmbed>
        {@html sanitizedContent}
      </div>
    </article>
  </div>
</div>

<style>
  .reader-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 100;
    background: var(--color-bg, #ffffff);
    overflow-y: auto;
  }

  .reader-container {
    max-width: 720px;
    margin: 0 auto;
    padding: 0 1.5rem 4rem;
  }

  .reader-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 0;
    position: sticky;
    top: 0;
    background: var(--color-bg, #ffffff);
    z-index: 10;
    border-bottom: 1px solid var(--color-border, #e5e7eb);
    margin-bottom: 1.5rem;
  }

  .reader-header-spacer {
    flex: 1;
  }

  .reader-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    padding: 0.5rem;
    cursor: pointer;
    color: var(--color-text-secondary);
    border-radius: 6px;
  }

  .reader-btn:hover {
    color: var(--color-primary, #0066cc);
    background: rgba(0, 0, 0, 0.05);
  }

  .reader-article-header {
    margin-bottom: 2rem;
  }

  .reader-title {
    font-size: 1.75rem;
    font-weight: 700;
    line-height: 1.3;
    color: var(--color-text);
    margin: 0 0 0.75rem;
  }

  .reader-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
  }

  .reader-favicon {
    width: 16px;
    height: 16px;
    border-radius: 3px;
  }

  .reader-feed {
    font-weight: 500;
  }

  .reader-read-time {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
  }

  .reader-body {
    font-family: var(--article-font, Georgia, 'Times New Roman', serif);
    font-size: var(--article-font-size, 1.0625rem);
    line-height: 1.8;
    color: var(--color-text);
    overflow-wrap: break-word;
  }

  .reader-body :global(img) {
    max-width: 100%;
    height: auto;
    border-radius: 4px;
    margin: 1rem 0;
  }

  .reader-body :global(a) {
    color: var(--color-primary, #0066cc);
  }

  .reader-body :global(pre) {
    background: var(--color-bg-secondary, #f3f4f6);
    padding: 1rem;
    border-radius: 6px;
    overflow-x: auto;
    font-size: 0.85rem;
  }

  .reader-body :global(blockquote) {
    border-left: 3px solid var(--color-border);
    margin: 1rem 0;
    padding-left: 1rem;
    color: var(--color-text-secondary);
  }

  .reader-body :global(p) {
    margin: 1rem 0;
  }

  .reader-body :global(p:first-child) {
    margin-top: 0;
  }

  .reader-body :global(h1),
  .reader-body :global(h2),
  .reader-body :global(h3),
  .reader-body :global(h4) {
    margin: 1.5rem 0 0.75rem;
    line-height: 1.3;
  }

  .reader-body :global(ul),
  .reader-body :global(ol) {
    margin: 1rem 0;
    padding-left: 1.5rem;
  }

  .reader-body :global(li) {
    margin: 0.25rem 0;
  }

  @media (prefers-color-scheme: dark) {
    .reader-btn:hover {
      background: rgba(255, 255, 255, 0.1);
    }
  }

  @media (max-width: 640px) {
    .reader-container {
      padding: 0 1rem 3rem;
    }

    .reader-title {
      font-size: 1.375rem;
    }
  }
</style>
