<script lang="ts">
  import type { Article } from '$lib/types';
  import { formatRelativeDate } from '$lib/utils/date';
  import { getFaviconUrl } from '$lib/utils/favicon';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { feedViewStore } from '$lib/stores/feedView.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import TagMenu from '$lib/components/feed/TagMenu.svelte';

  let {
    article,
    selected = false,
    onOpen,
    onArchive,
    onHover,
  }: {
    article: Article;
    selected?: boolean;
    onOpen?: () => void;
    onArchive?: () => void;
    onHover?: () => void;
  } = $props();

  let sub = $derived(subscriptionsStore.subscriptions.find((s) => s.id === article.subscriptionId));
  let faviconUrl = $derived(getFaviconUrl(sub?.siteUrl || sub?.feedUrl || article.url));
  let feedTitle = $derived(sub?.customTitle || sub?.title || '');
  let isArchived = $derived(itemLabelsStore.isArchived(article.guid));
  let tags = $derived(itemLabelsStore.getTagsForItem(article.guid));

  // Estimate read time from content (~200 words/min)
  let readTimeMinutes = $derived.by(() => {
    const text = (article.content || article.summary || '').replace(/<[^>]*>/g, '');
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(wordCount / 200));
  });

  // Strip HTML for summary display
  let summaryText = $derived.by(() => {
    const raw = article.summary || article.content || '';
    const text = raw.replace(/<[^>]*>/g, '').trim();
    return text.length > 200 ? text.slice(0, 200) + '...' : text;
  });

  let tagMenuOpenLocal = $state(false);
  let tagBtnRef = $state<HTMLButtonElement | null>(null);
  let tagMenuOpen = $derived(tagMenuOpenLocal || feedViewStore.tagMenuItemKey === article.guid);

  function handleArchiveClick(e: MouseEvent) {
    e.stopPropagation();
    onArchive?.();
  }

  function handleTagClick(e: MouseEvent) {
    e.stopPropagation();
    tagMenuOpenLocal = !tagMenuOpenLocal;
    if (feedViewStore.tagMenuItemKey === article.guid) {
      feedViewStore.closeTagMenu();
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
<article
  class="bookmark-card"
  class:selected
  role="button"
  tabindex="0"
  onclick={() => onOpen?.()}
  onmouseenter={() => onHover?.()}
  onkeydown={(e) => {
    if (e.key === 'Enter') onOpen?.();
  }}
>
  <div class="bookmark-icon">
    {#if faviconUrl}
      <img src={faviconUrl} alt="" class="favicon" />
    {:else}
      <Icon name="rss" size={28} />
    {/if}
  </div>

  <div class="bookmark-content">
    <h3 class="bookmark-title">{article.title || article.url}</h3>
    {#if summaryText}
      <p class="bookmark-summary">{summaryText}</p>
    {/if}
    <div class="bookmark-meta">
      {#if feedTitle}
        <span class="meta-feed">{feedTitle}</span>
      {/if}
      {#if article.author}
        <span class="meta-author">{article.author}</span>
      {/if}
      <span class="meta-read-time">
        <Icon name="clock" size={12} />
        {readTimeMinutes} min
      </span>
      <span class="meta-date">{formatRelativeDate(article.publishedAt)}</span>
      {#each tags as tag, i}
        {#if i === 0}<span class="meta-dot" aria-hidden="true">·</span>{/if}
        <span class="tag-chip">{tag}</span>
      {/each}
    </div>
  </div>

  <div class="card-actions">
    <button
      class="card-action-btn"
      class:tagged={tags.length > 0}
      onclick={handleTagClick}
      bind:this={tagBtnRef}
      title="Tag"
    >
      <Icon name="tag" size={18} />
    </button>
    <button
      class="card-action-btn"
      onclick={handleArchiveClick}
      title={isArchived ? 'Move to inbox' : 'Archive'}
    >
      <Icon name={isArchived ? 'inbox' : 'archive'} size={18} />
    </button>
  </div>

  {#if tagMenuOpen}
    <TagMenu
      itemKey={article.guid}
      itemType="article"
      anchorEl={tagBtnRef}
      onClose={() => {
        tagMenuOpenLocal = false;
        feedViewStore.closeTagMenu();
      }}
    />
  {/if}
</article>

<style>
  .bookmark-card {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    cursor: pointer;
    border-radius: 8px;
    transition: background-color 0.15s;
  }

  .bookmark-card.selected {
    background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.03));
  }

  .bookmark-icon {
    flex-shrink: 0;
    width: 40px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    align-self: center;
    color: var(--color-text-secondary);
    background: var(--color-bg-secondary, #f5f5f5);
    border-radius: 8px;
  }

  .favicon {
    width: 28px;
    height: 28px;
    border-radius: 6px;
  }

  .bookmark-content {
    flex: 1;
    min-width: 0;
  }

  .bookmark-title {
    font-size: 0.9375rem;
    font-weight: 500;
    color: var(--color-text);
    margin: 0;
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .bookmark-summary {
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
    margin: 0.25rem 0 0;
    line-height: 1.5;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .bookmark-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
    margin-top: 0.375rem;
    font-size: 0.75rem;
    color: var(--color-text-secondary);
  }

  .bookmark-meta > :not(:first-child)::before {
    content: '·';
    margin-right: 0.375rem;
    opacity: 0.5;
  }

  .meta-feed {
    font-weight: 500;
  }

  .meta-read-time {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
  }

  .tag-chip {
    display: inline-flex;
    align-items: center;
    padding: 0.0625rem 0.375rem;
    font-size: 0.6875rem;
    font-weight: 500;
    background: rgba(37, 99, 235, 0.08);
    color: var(--color-primary, #2563eb);
    border-radius: 999px;
  }

  .bookmark-meta > .meta-dot,
  .bookmark-meta > .tag-chip {
    margin-right: 0;
  }

  .bookmark-meta > .meta-dot::before,
  .bookmark-meta > .tag-chip::before {
    content: none;
    margin-right: 0;
  }

  .meta-dot {
    opacity: 0.5;
  }

  .card-actions {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.25rem;
  }

  .card-action-btn {
    background: none;
    border: none;
    padding: 0.375rem;
    cursor: pointer;
    color: var(--color-text-secondary);
    border-radius: 4px;
  }

  .card-action-btn:hover {
    color: var(--color-primary, #0066cc);
    background: rgba(0, 0, 0, 0.05);
  }

  .card-action-btn.tagged {
    color: var(--color-primary, #2563eb);
  }

  @media (prefers-color-scheme: dark) {
    .bookmark-card:hover {
      background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
    }

    .card-action-btn:hover {
      background: rgba(255, 255, 255, 0.1);
    }
  }
</style>
