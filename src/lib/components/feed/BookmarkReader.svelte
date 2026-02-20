<script lang="ts">
  import type {
    Article,
    SocialShare,
    SocialDocument,
    LeafletContent,
    PcktBlogContent,
    OffprintContent,
    GreengaleContent,
  } from '$lib/types';
  import type { FeedDisplayItem } from '$lib/stores/feedView.svelte';
  import { sanitizeHtml } from '$lib/utils/sanitize';
  import { formatRelativeDate } from '$lib/utils/date';
  import { getFaviconUrl } from '$lib/utils/favicon';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { profileService } from '$lib/services/profiles';
  import { isLeafletContent, renderLeafletContent } from '$lib/utils/leaflet-renderer';
  import { isPcktBlogContent, renderPcktBlogContent } from '$lib/utils/pckt-blog-renderer';
  import { isOffprintContent, renderOffprintContent } from '$lib/utils/offprint-renderer';
  import { isGreengaleContent, renderGreengaleContent } from '$lib/utils/greengale-renderer';
  import { bskyEmbed } from '$lib/actions/bsky-embed';
  import Icon from '$lib/components/Icon.svelte';
  import TagMenu from '$lib/components/feed/TagMenu.svelte';
  import { preferences, type ArticleFont } from '$lib/stores/preferences.svelte';

  let {
    readerItem,
    onClose,
    onArchive,
  }: {
    readerItem: FeedDisplayItem;
    onClose: () => void;
    onArchive?: () => void;
  } = $props();

  let styleMenuOpen = $state(false);
  let tagMenuOpen = $state(false);
  let tagBtnRef = $state<HTMLButtonElement | null>(null);
  let controlsVisible = $state(true);
  let lastScrollY = $state(0);
  let overlayEl: HTMLElement | undefined = $state();

  let itemKey = $derived(readerItem.key);
  let itemTags = $derived(itemLabelsStore.getTagsForItem(itemKey));

  let labelItemType = $derived.by((): 'article' | 'share' | 'document' | 'userShare' => {
    if (readerItem.type === 'userShare') return 'userShare';
    return readerItem.type;
  });

  const fontOptions: { value: ArticleFont; label: string; family: string }[] = [
    { value: 'sans-serif', label: 'Sans', family: 'sans-serif' },
    { value: 'serif', label: 'Serif', family: 'serif' },
    { value: 'mono', label: 'Mono', family: 'monospace' },
  ];

  const sizeLabels: Record<string, string> = {
    xs: 'XS',
    sm: 'S',
    md: 'M',
    lg: 'L',
    xl: 'XL',
  };

  function handleScroll() {
    if (!overlayEl) return;
    const currentY = overlayEl.scrollTop;
    if (currentY > lastScrollY && currentY > 60) {
      controlsVisible = false;
      styleMenuOpen = false;
    } else {
      controlsVisible = true;
    }
    lastScrollY = currentY;
  }

  // Normalize data from different item types
  let title = $derived.by(() => {
    if (readerItem.type === 'article') return readerItem.item.title || readerItem.item.url;
    if (readerItem.type === 'share') return readerItem.item.itemTitle || readerItem.item.itemUrl;
    if (readerItem.type === 'document') return readerItem.item.title || readerItem.item.recordUri;
    return '';
  });

  let itemUrl = $derived.by(() => {
    if (readerItem.type === 'article') return readerItem.item.url;
    if (readerItem.type === 'share') return readerItem.item.itemUrl;
    if (readerItem.type === 'document')
      return readerItem.item.canonicalUrl || readerItem.item.path || '';
    return '';
  });

  let publishedAt = $derived.by(() => {
    if (readerItem.type === 'article') return readerItem.item.publishedAt;
    if (readerItem.type === 'share')
      return readerItem.item.itemPublishedAt || readerItem.item.createdAt;
    if (readerItem.type === 'document') return readerItem.item.publishedAt;
    return '';
  });

  // Feed info (articles only)
  let sub = $derived(
    readerItem.type === 'article'
      ? subscriptionsStore.subscriptions.find((s) => s.id === readerItem.item.subscriptionId)
      : undefined
  );
  let feedTitle = $derived(sub?.customTitle || sub?.title || '');

  // Author info (shares/documents)
  let authorProfile = $state<{ handle?: string } | null>(null);
  $effect(() => {
    if (readerItem.type === 'share') {
      profileService.getProfile(readerItem.item.authorDid).then((p) => {
        authorProfile = p;
      });
    } else if (readerItem.type === 'document') {
      profileService.getProfile(readerItem.item.authorDid).then((p) => {
        authorProfile = p;
      });
    } else {
      authorProfile = null;
    }
  });
  let authorLabel = $derived.by(() => {
    if (readerItem.type === 'article' && readerItem.item.author)
      return `by ${readerItem.item.author}`;
    if (readerItem.type === 'share') {
      const handle = authorProfile?.handle || readerItem.item.authorDid;
      return `shared by @${handle}`;
    }
    if (readerItem.type === 'document') {
      const handle = authorProfile?.handle || readerItem.item.authorDid;
      return `by @${handle}`;
    }
    return '';
  });

  let faviconUrl = $derived.by(() => {
    if (readerItem.type === 'article') {
      return getFaviconUrl(sub?.siteUrl || sub?.feedUrl || readerItem.item.url);
    }
    if (readerItem.type === 'document' && readerItem.item.siteIcon) return readerItem.item.siteIcon;
    if (readerItem.type === 'document' && readerItem.item.canonicalUrl)
      return getFaviconUrl(readerItem.item.canonicalUrl);
    if (readerItem.type === 'share') return getFaviconUrl(readerItem.item.itemUrl);
    return itemUrl ? getFaviconUrl(itemUrl) : '';
  });

  let isArchived = $derived(itemLabelsStore.isArchived(itemKey));

  let displayContent = $derived.by(() => {
    if (readerItem.type === 'article') {
      return readerItem.item.content || readerItem.item.summary || '';
    }
    if (readerItem.type === 'share') {
      return readerItem.item.content || readerItem.item.itemDescription || '';
    }
    if (readerItem.type === 'document') {
      const doc = readerItem.item;
      if (doc.content && isLeafletContent(doc.content)) {
        return renderLeafletContent(doc.content as LeafletContent, doc.authorDid);
      }
      if (doc.content && isPcktBlogContent(doc.content)) {
        return renderPcktBlogContent(doc.content as PcktBlogContent, doc.authorDid);
      }
      if (doc.content && isOffprintContent(doc.content)) {
        return renderOffprintContent(doc.content as OffprintContent, doc.authorDid);
      }
      if (doc.content && isGreengaleContent(doc.content)) {
        return renderGreengaleContent(doc.content as GreengaleContent, doc.authorDid);
      }
      return doc.textContent || doc.description || '';
    }
    return '';
  });

  let sanitizedContent = $derived(sanitizeHtml(displayContent, itemUrl));

  let readTimeMinutes = $derived.by(() => {
    const text = displayContent.replace(/<[^>]*>/g, '');
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(wordCount / 200));
  });

  function handleKeydown(e: KeyboardEvent) {
    if (tagMenuOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'e' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      onArchive?.();
    } else if (e.key === 't' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      tagMenuOpen = !tagMenuOpen;
    }
  }

  function handleOpenUrl() {
    if (itemUrl) window.open(itemUrl, '_blank', 'noopener');
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="reader-overlay" bind:this={overlayEl} onscroll={handleScroll}>
  <div class="reader-container">
    <header class="reader-header" class:hidden={!controlsVisible}>
      <div class="reader-actions-left">
        <button class="action-btn" onclick={onClose} title="Back (Escape)">
          <Icon name="arrow-left" size={18} />
          <span class="action-label">Back</span>
        </button>
      </div>

      <div class="reader-actions-right">
        <button
          class="action-btn"
          class:active={styleMenuOpen}
          onclick={() => (styleMenuOpen = !styleMenuOpen)}
          title="Style"
        >
          <Icon name="type" size={18} />
          <span class="action-label">Style</span>
        </button>

        <button
          class="action-btn"
          class:active={tagMenuOpen}
          class:tagged={itemTags.length > 0}
          onclick={() => (tagMenuOpen = !tagMenuOpen)}
          bind:this={tagBtnRef}
          title="Tag (t)"
        >
          <Icon name="tag" size={18} />
          <span class="action-label"
            >Tag{#if itemTags.length > 0}<span class="tag-count">({itemTags.length})</span
              >{/if}</span
          >
        </button>

        <span class="action-separator"></span>

        <button
          class="action-btn"
          onclick={() => onArchive?.()}
          title={isArchived ? 'Move to inbox' : 'Archive (e)'}
        >
          <Icon name={isArchived ? 'inbox' : 'archive'} size={18} />
          <span class="action-label">{isArchived ? 'Inbox' : 'Archive'}</span>
        </button>

        <button class="action-btn" onclick={handleOpenUrl} title="Open in new tab">
          <Icon name="external-link" size={18} />
          <span class="action-label">Open</span>
        </button>
      </div>

      {#if tagMenuOpen}
        <TagMenu
          {itemKey}
          itemType={labelItemType}
          anchorEl={tagBtnRef}
          onClose={() => (tagMenuOpen = false)}
        />
      {/if}
    </header>

    {#if styleMenuOpen}
      <div class="style-toolbar-fixed">
        <div class="style-toolbar-inner">
          <div class="style-toolbar">
            <div class="toolbar-group">
              <span class="group-label">Font</span>
              <div class="segment-group" role="group" aria-label="Font style">
                {#each fontOptions as option}
                  <button
                    class="segment-btn"
                    class:active={preferences.articleFont === option.value}
                    onclick={() => preferences.setArticleFont(option.value)}
                    title={option.label}
                  >
                    <span class="font-preview" style:font-family={option.family}>Aa</span>
                  </button>
                {/each}
              </div>
            </div>

            <span class="toolbar-divider"></span>

            <div class="toolbar-group">
              <span class="group-label">Size</span>
              <div class="size-controls" role="group" aria-label="Font size">
                <button
                  class="size-btn"
                  onclick={() => preferences.decreaseFontSize()}
                  disabled={preferences.articleFontSize === 'xs'}
                  title="Decrease font size"
                >
                  <Icon name="minus" size={14} />
                </button>
                <span class="size-label">{sizeLabels[preferences.articleFontSize]}</span>
                <button
                  class="size-btn"
                  onclick={() => preferences.increaseFontSize()}
                  disabled={preferences.articleFontSize === 'xl'}
                  title="Increase font size"
                >
                  <Icon name="plus" size={14} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    {/if}

    <article class="reader-article">
      <div class="reader-article-header">
        <h1 class="reader-title">{title}</h1>
        <div class="reader-meta">
          {#if faviconUrl}
            <img src={faviconUrl} alt="" class="reader-favicon" />
          {/if}
          {#if feedTitle}
            <a href="/?feed={sub?.id}" class="reader-feed">{feedTitle}</a>
          {/if}
          {#if authorLabel}
            <span class="reader-author">{authorLabel}</span>
          {/if}
          <span class="reader-date">{formatRelativeDate(publishedAt)}</span>
          <span class="reader-read-time">
            <Icon name="clock" size={12} />
            {readTimeMinutes} min read
          </span>
        </div>
        {#if itemTags.length > 0}
          <div class="reader-tags">
            {#each itemTags as tag}
              <span class="reader-tag-chip">{tag}</span>
            {/each}
          </div>
        {/if}
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
    justify-content: space-between;
    align-items: flex-start;
    padding: 0.75rem 0;
    position: sticky;
    top: 0;
    z-index: 10;
    margin-bottom: 1.5rem;
    transition:
      transform 0.25s ease,
      opacity 0.25s ease;
  }

  .reader-header.hidden {
    transform: translateY(-100%);
    opacity: 0;
    pointer-events: none;
  }

  .reader-actions-left,
  .reader-actions-right {
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

  .action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: var(--color-text-secondary);
    font-size: 1rem;
  }

  .action-label {
    font-size: 0.8125rem;
    font-weight: 500;
  }

  .action-btn:hover,
  .action-btn.active {
    color: var(--color-primary, #0066cc);
  }

  .action-btn.tagged {
    color: var(--color-primary, #2563eb);
  }

  .tag-count {
    margin-left: 0.125rem;
    font-size: 0.75rem;
  }

  .action-separator {
    width: 1px;
    background: var(--color-border, #e5e7eb);
    align-self: stretch;
    margin: -0.25rem 0;
  }

  .style-toolbar-fixed {
    position: fixed;
    top: 4rem;
    left: 0;
    right: 0;
    z-index: 11;
    display: flex;
    justify-content: center;
    pointer-events: none;
  }

  .style-toolbar-inner {
    display: flex;
    justify-content: flex-end;
    width: 100%;
    max-width: 720px;
    padding: 0 1.5rem;
  }

  .style-toolbar {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    padding: 0.25rem;
    background: rgba(255, 255, 255, 0.85);
    backdrop-filter: blur(8px);
    border-radius: 999px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    pointer-events: auto;
  }

  .toolbar-group {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .group-label {
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.03em;
    padding-left: 0.375rem;
    white-space: nowrap;
  }

  .toolbar-divider {
    width: 1px;
    height: 1rem;
    background: var(--color-border, #e0e0e0);
    margin: 0 0.25rem;
    opacity: 0.5;
  }

  .segment-group {
    display: flex;
    gap: 1px;
    border-radius: 999px;
  }

  .segment-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    padding: 0.35rem 0.5rem;
    cursor: pointer;
    color: var(--color-text-secondary);
    font-size: 0.8125rem;
    font-weight: 500;
    border-radius: 999px;
    transition: all 0.2s ease;
  }

  .segment-btn.active {
    background: var(--color-bg-secondary, #f5f5f5);
    color: var(--color-text);
  }

  .segment-btn:hover:not(.active) {
    color: var(--color-text);
  }

  .font-preview {
    font-size: 0.875rem;
    line-height: 1;
  }

  .size-controls {
    display: flex;
    align-items: center;
    gap: 0.125rem;
  }

  .size-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    padding: 0.3rem;
    border-radius: 999px;
    cursor: pointer;
    color: var(--color-text-secondary);
    transition: all 0.2s ease;
  }

  .size-btn:hover:not(:disabled) {
    color: var(--color-text);
    background: var(--color-bg-secondary, #f5f5f5);
  }

  .size-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .size-label {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--color-text);
    min-width: 1.25rem;
    text-align: center;
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
    color: var(--color-text-secondary);
    text-decoration: none;
  }

  .reader-feed:hover {
    color: var(--color-primary, #0066cc);
  }

  .reader-read-time {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
  }

  .reader-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-top: 0.5rem;
  }

  .reader-tag-chip {
    display: inline-flex;
    align-items: center;
    padding: 0.125rem 0.5rem;
    font-size: 0.75rem;
    font-weight: 500;
    background: rgba(37, 99, 235, 0.08);
    color: var(--color-primary, #2563eb);
    border-radius: 999px;
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
    .reader-actions-left,
    .reader-actions-right {
      background: rgba(40, 40, 40, 0.95);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
    }

    .style-toolbar {
      background: rgba(40, 40, 40, 0.95);
    }

    .toolbar-divider {
      background: rgba(255, 255, 255, 0.2);
    }

    .segment-btn.active {
      background: rgba(255, 255, 255, 0.15);
    }

    .size-btn:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.1);
    }
  }

  @media (max-width: 900px) {
    .action-label {
      display: none;
    }
  }

  @media (max-width: 640px) {
    .reader-container {
      padding: 0 1rem 3rem;
    }

    .style-toolbar-inner {
      padding: 0 1rem;
    }

    .reader-title {
      font-size: 1.375rem;
    }
  }
</style>
