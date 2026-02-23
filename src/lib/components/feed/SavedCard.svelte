<script lang="ts">
  import type { Article, SocialShare, SocialDocument } from '$lib/types';
  import type { FeedDisplayItem } from '$lib/stores/feedView.svelte';
  import { formatRelativeDate } from '$lib/utils/date';
  import { getFaviconUrl } from '$lib/utils/favicon';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { feedViewStore } from '$lib/stores/feedView.svelte';
  import { profileService } from '$lib/services/profiles';
  import Icon from '$lib/components/Icon.svelte';
  import PopoverMenu from '$lib/components/PopoverMenu.svelte';
  import TagMenu from '$lib/components/feed/TagMenu.svelte';

  let {
    displayItem,
    selected = false,
    onOpen,
    onArchive,
    onRemove,
    onHover,
  }: {
    displayItem: FeedDisplayItem;
    selected?: boolean;
    onOpen?: () => void;
    onArchive?: () => void;
    onRemove?: () => void;
    onHover?: () => void;
  } = $props();

  // Normalize data across item types
  let itemKey = $derived(displayItem.key);
  let itemType = $derived(displayItem.type);

  let title = $derived.by(() => {
    if (displayItem.type === 'article') return displayItem.item.title || displayItem.item.url;
    if (displayItem.type === 'share') return displayItem.item.itemTitle || displayItem.item.itemUrl;
    if (displayItem.type === 'document')
      return displayItem.item.title || displayItem.item.recordUri;
    if (displayItem.type === 'saved') return displayItem.item.title || displayItem.item.url;
    return '';
  });

  let url = $derived.by(() => {
    if (displayItem.type === 'article') return displayItem.item.url;
    if (displayItem.type === 'share') return displayItem.item.itemUrl;
    if (displayItem.type === 'document')
      return displayItem.item.canonicalUrl || displayItem.item.path || '';
    if (displayItem.type === 'saved') return displayItem.item.url;
    return '';
  });

  let publishedAt = $derived.by(() => {
    if (displayItem.type === 'article') return displayItem.item.publishedAt;
    if (displayItem.type === 'share')
      return displayItem.item.itemPublishedAt || displayItem.item.createdAt;
    if (displayItem.type === 'document') return displayItem.item.publishedAt;
    if (displayItem.type === 'saved') return displayItem.item.savedAt;
    return '';
  });

  // Feed info (for articles only)
  let sub = $derived(
    displayItem.type === 'article'
      ? subscriptionsStore.subscriptions.find((s) => s.id === displayItem.item.subscriptionId)
      : undefined
  );
  let feedTitle = $derived(sub?.customTitle || sub?.title || '');

  // Author info (for shares/documents)
  let authorProfile = $state<{ handle?: string } | null>(null);
  $effect(() => {
    if (displayItem.type === 'share') {
      profileService.getProfile(displayItem.item.authorDid).then((p) => {
        authorProfile = p;
      });
    } else if (displayItem.type === 'document') {
      profileService.getProfile(displayItem.item.authorDid).then((p) => {
        authorProfile = p;
      });
    } else {
      authorProfile = null;
    }
  });
  let authorHandle = $derived.by(() => {
    if (displayItem.type === 'share') return authorProfile?.handle || displayItem.item.authorDid;
    if (displayItem.type === 'document') return authorProfile?.handle || displayItem.item.authorDid;
    return '';
  });

  let faviconUrl = $derived.by(() => {
    if (displayItem.type === 'article') {
      return getFaviconUrl(sub?.siteUrl || sub?.feedUrl || displayItem.item.url);
    }
    if (displayItem.type === 'document' && displayItem.item.siteIcon) {
      return displayItem.item.siteIcon;
    }
    if (displayItem.type === 'document' && displayItem.item.canonicalUrl) {
      return getFaviconUrl(displayItem.item.canonicalUrl);
    }
    if (displayItem.type === 'share') {
      return getFaviconUrl(displayItem.item.itemUrl);
    }
    if (displayItem.type === 'saved') {
      return getFaviconUrl(displayItem.item.url);
    }
    return url ? getFaviconUrl(url) : '';
  });

  let isArchived = $derived(itemLabelsStore.isArchived(itemKey));
  let tags = $derived(itemLabelsStore.getTagsForItem(itemKey));

  // Estimate read time from content (~200 words/min)
  let readTimeMinutes = $derived.by(() => {
    let content = '';
    if (displayItem.type === 'article') {
      content = displayItem.item.content || displayItem.item.summary || '';
    } else if (displayItem.type === 'share') {
      content = displayItem.item.content || displayItem.item.itemDescription || '';
    } else if (displayItem.type === 'document') {
      content = displayItem.item.textContent || displayItem.item.description || '';
    } else if (displayItem.type === 'saved') {
      if (displayItem.item.wordCount)
        return Math.max(1, Math.round(displayItem.item.wordCount / 200));
      content = displayItem.item.content || displayItem.item.description || '';
    }
    const text = content.replace(/<[^>]*>/g, '');
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(wordCount / 200));
  });

  // Strip HTML for summary display
  let summaryText = $derived.by(() => {
    let raw = '';
    if (displayItem.type === 'article') {
      raw = displayItem.item.summary || displayItem.item.content || '';
    } else if (displayItem.type === 'share') {
      raw = displayItem.item.itemDescription || displayItem.item.content || '';
    } else if (displayItem.type === 'document') {
      raw = displayItem.item.description || displayItem.item.textContent || '';
    } else if (displayItem.type === 'saved') {
      raw = displayItem.item.description || displayItem.item.content || '';
    }
    const text = raw.replace(/<[^>]*>/g, '').trim();
    return text.length > 200 ? text.slice(0, 200) + '...' : text;
  });

  // Type badge
  let typeBadge = $derived.by(() => {
    if (displayItem.type === 'share') return `Shared by @${authorHandle}`;
    if (displayItem.type === 'document') return `By @${authorHandle}`;
    if (displayItem.type === 'saved') return displayItem.item.domain || 'Saved';
    return '';
  });

  let tagMenuOpenLocal = $state(false);
  let tagMenuAnchorRef = $state<HTMLElement | null>(null);
  let tagMenuOpen = $derived(tagMenuOpenLocal || feedViewStore.tagMenuItemKey === itemKey);

  let labelItemType = $derived.by((): 'article' | 'share' | 'document' | 'userShare' | 'saved' => {
    if (displayItem.type === 'userShare') return 'userShare';
    return displayItem.type;
  });

  let popoverMenuItems = $derived.by(() => {
    const items: {
      label: string;
      icon?: string;
      variant?: 'default' | 'danger';
      onclick: () => void;
    }[] = [
      {
        label: isArchived ? 'Move to inbox' : 'Archive',
        icon: isArchived ? 'inbox' : 'archive',
        onclick: () => {
          onArchive?.();
        },
      },
      {
        label: 'Tag',
        icon: 'tag',
        onclick: () => {
          tagMenuOpenLocal = true;
        },
      },
    ];
    if (onRemove) {
      items.push({
        label: 'Delete',
        icon: 'trash',
        variant: 'danger',
        onclick: () => {
          onRemove();
        },
      });
    }
    return items;
  });
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
  <div class="bookmark-content">
    <h3 class="bookmark-title">{title}</h3>
    {#if summaryText}
      <p class="bookmark-summary">{summaryText}</p>
    {/if}
    <div class="bookmark-meta">
      <span class="meta-icon">
        {#if faviconUrl}
          <img src={faviconUrl} alt="" class="favicon" />
        {:else}
          <Icon name="rss" size={14} />
        {/if}
      </span>
      {#if typeBadge}
        <span class="meta-type-badge">{typeBadge}</span>
      {:else if feedTitle}
        <span class="meta-feed">{feedTitle}</span>
      {/if}
      {#if displayItem.type === 'article' && displayItem.item.author}
        <span class="meta-author">{displayItem.item.author}</span>
      {/if}
      <span class="meta-read-time">
        <Icon name="clock" size={12} />
        {readTimeMinutes} min
      </span>
      <span class="meta-date">{formatRelativeDate(publishedAt)}</span>
      {#each tags as tag, i}
        {#if i === 0}<span class="meta-dot" aria-hidden="true">·</span>{/if}
        <span class="tag-chip">{tag}</span>
      {/each}
    </div>
  </div>

  <div class="card-actions" bind:this={tagMenuAnchorRef}>
    <PopoverMenu items={popoverMenuItems} />
  </div>

  {#if tagMenuOpen}
    <TagMenu
      {itemKey}
      itemType={labelItemType}
      anchorEl={tagMenuAnchorRef}
      onClose={() => {
        tagMenuOpenLocal = false;
        feedViewStore.closeTagMenu();
      }}
    />
  {/if}
</article>

<style>
  .bookmark-card {
    position: relative;
    padding: 0.75rem 1rem;
    cursor: pointer;
    border-radius: 8px;
    transition: background-color 0.15s;
  }

  .bookmark-card.selected {
    background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.03));
  }

  .meta-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  .meta-icon::before {
    content: none;
    margin-right: 0;
  }

  .favicon {
    width: 16px;
    height: 16px;
    border-radius: 3px;
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
    padding-right: 2rem;
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

  .bookmark-meta > .meta-icon + :not(:first-child)::before {
    content: none;
    margin-right: 0;
  }

  .meta-feed {
    font-weight: 500;
  }

  .meta-type-badge {
    font-weight: 500;
    color: var(--color-primary, #2563eb);
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
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  @media (prefers-color-scheme: dark) {
    .bookmark-card:hover {
      background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
    }
  }
</style>
