<script lang="ts">
  import type { Article, SocialShare, SocialDocument } from '$lib/types';
  import type { FeedDisplayItem } from '$lib/stores/feedView.svelte';
  import { normalizeDisplayItem, getAuthorLabel } from '$lib/utils/displayItem';
  import { sanitizeHtml } from '$lib/utils/sanitize';
  import { formatRelativeDate } from '$lib/utils/date';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { profileService } from '$lib/services/profiles';
  import { bskyEmbed } from '$lib/actions/bsky-embed';
  import Icon from '$lib/components/Icon.svelte';
  import PopoverMenu from '$lib/components/PopoverMenu.svelte';
  import TagMenu from '$lib/components/feed/TagMenu.svelte';
  import LinkContextMenu from '$lib/components/feed/LinkContextMenu.svelte';
  import BottomSheet from '$lib/components/common/BottomSheet.svelte';
  import AppearanceToolbar from '$lib/components/feed/AppearanceToolbar.svelte';
  import { useParagraphTracking } from '$lib/hooks/useParagraphTracking.svelte';
  import { useLinkInterception } from '$lib/hooks/useLinkInterception.svelte';
  import { useHighlights } from '$lib/hooks/useHighlights.svelte';
  import HighlightPopover from '$lib/components/feed/HighlightPopover.svelte';
  import { preferences, type ArticleFont } from '$lib/stores/preferences.svelte';
  import { mobileStore } from '$lib/stores/mediaQuery.svelte';
  import { tick, onMount, onDestroy } from 'svelte';

  let {
    readerItem,
    onClose,
    onArchive,
    onRemove,
    onToggleSave,
    onShare,
    isShared = false,
    onSaveToSemble,
    onSaveToMargin,
  }: {
    readerItem: FeedDisplayItem;
    onClose: () => void;
    onArchive?: () => void;
    onRemove?: () => void;
    onToggleSave?: () => void;
    onShare?: () => void;
    isShared?: boolean;
    onSaveToSemble?: () => void;
    onSaveToMargin?: () => void;
  } = $props();

  let styleMenuOpen = $state(false);
  let styleSheetOpen = $state(false);
  let tagMenuOpen = $state(false);
  let overflowRef = $state<HTMLDivElement | null>(null);
  let tagBtnRef = $state<HTMLButtonElement | null>(null);
  let controlsVisible = $state(true);
  let lastScrollY = $state(0);
  let suppressScrollHide = $state(false);
  let overlayEl: HTMLElement | undefined = $state();
  let readerBodyEl: HTMLElement | undefined = $state();

  let itemKey = $derived(readerItem.key);
  let itemTags = $derived(itemLabelsStore.getTagsForItem(itemKey));

  let labelItemType = $derived.by((): 'article' | 'share' | 'document' | 'userShare' | 'saved' => {
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
    if (suppressScrollHide) return;
    const currentY = overlayEl.scrollTop;
    const delta = currentY - lastScrollY;
    // Ignore tiny fluctuations (momentum settling on mobile)
    if (Math.abs(delta) < 3) return;
    if (delta > 0 && currentY > 60) {
      controlsVisible = false;
      styleMenuOpen = false;
    } else if (delta < -10) {
      // Require meaningful upward scroll to show controls
      controlsVisible = true;
    }
    lastScrollY = currentY;
  }

  // Feed info (articles only)
  let sub = $derived(
    readerItem.type === 'article'
      ? subscriptionsStore.subscriptions.find((s) => s.id === readerItem.item.subscriptionId)
      : undefined
  );
  let feedTitle = $derived(sub?.customTitle || sub?.title || '');

  // Normalize data from different item types using shared utility
  let normalized = $derived(normalizeDisplayItem(readerItem, sub));
  let title = $derived(normalized.title);
  let itemUrl = $derived(normalized.url);
  let publishedAt = $derived(normalized.publishedAt);
  let displayContent = $derived(normalized.displayContent);
  let faviconUrl = $derived(normalized.faviconUrl);

  // Author info (shares/documents)
  let authorProfile = $state<{ handle?: string } | null>(null);
  $effect(() => {
    const did = normalized.authorDid;
    if (did) {
      profileService.getProfile(did).then((p) => {
        authorProfile = p;
      });
    } else {
      authorProfile = null;
    }
  });
  let authorLabel = $derived(getAuthorLabel(readerItem, authorProfile));

  let isArchived = $derived(itemLabelsStore.isArchived(itemKey));
  let isSaved = $derived(itemLabelsStore.isSaved(itemKey));
  let shareLabel = $derived(
    isShared ? (readerItem.type === 'share' ? 'Reshared' : 'Shared') : 'Share'
  );

  let sanitizedContent = $derived(sanitizeHtml(displayContent, itemUrl));

  let readTimeMinutes = $derived.by(() => {
    const text = displayContent.replace(/<[^>]*>/g, '');
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(wordCount / 200));
  });

  let overflowItems = $derived.by(() => {
    const items: {
      label: string;
      icon?: string;
      variant?: 'default' | 'danger';
      active?: boolean;
      keepOpen?: boolean;
      onclick: () => void;
    }[] = [];

    items.push({
      label: `Tag${itemTags.length > 0 ? ` (${itemTags.length})` : ''}`,
      icon: 'tag',
      onclick: () => {
        tagMenuOpen = true;
      },
    });

    if (onToggleSave) {
      items.push({
        label: isSaved ? 'Unsave' : 'Save',
        icon: 'bookmark',
        onclick: () => onToggleSave!(),
      });
    }

    if (onShare) {
      items.push({
        label: shareLabel,
        icon: 'share',
        active: isShared,
        onclick: () => onShare!(),
      });
    }

    if (onSaveToSemble) {
      items.push({
        label: 'Save to Semble',
        icon: 'semble',
        onclick: () => onSaveToSemble!(),
      });
    }

    if (onSaveToMargin) {
      items.push({
        label: 'Save to Margin',
        icon: 'margin',
        onclick: () => onSaveToMargin!(),
      });
    }

    if (onRemove) {
      items.push({
        label: deleteConfirming ? 'Confirm delete?' : 'Delete',
        icon: 'trash',
        variant: deleteConfirming ? 'danger' : 'default',
        keepOpen: !deleteConfirming,
        onclick: handleDeleteClick,
      });
    }

    items.push({
      label: 'Open in browser',
      icon: 'external-link',
      onclick: handleOpenUrl,
    });

    return items;
  });

  function handleKeydown(e: KeyboardEvent) {
    if (tagMenuOpen) {
      e.stopPropagation();
      return;
    }
    const noMod = !e.metaKey && !e.ctrlKey && !e.altKey;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'e' && noMod && onArchive) {
      e.preventDefault();
      e.stopPropagation();
      onArchive();
    } else if (e.key === 's' && noMod && onToggleSave) {
      e.preventDefault();
      e.stopPropagation();
      onToggleSave();
    } else if (e.key === 't' && noMod) {
      e.preventDefault();
      e.stopPropagation();
      tagMenuOpen = !tagMenuOpen;
    } else if (e.key === 'ArrowDown' && noMod) {
      e.preventDefault();
      e.stopPropagation();
      paragraphTracking.nextParagraph();
    } else if (e.key === 'ArrowUp' && noMod) {
      e.preventDefault();
      e.stopPropagation();
      paragraphTracking.prevParagraph();
    } else if (e.key === 'h' && noMod) {
      e.preventDefault();
      e.stopPropagation();
      highlightsHook.toggleParagraphHighlight(paragraphTracking.currentParagraphIndex);
    }
  }

  // Lock body scroll and prevent touch events from bubbling to PullToRefresh
  // while the reader overlay is open.
  function stopTouchPropagation(e: TouchEvent) {
    e.stopPropagation();
  }

  onMount(() => {
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleKeydown, true);
    // The reader is a DOM child of PullToRefresh, so touch events bubble up
    // and trigger pull-to-refresh even though the reader is a fixed overlay.
    overlayEl?.addEventListener('touchstart', stopTouchPropagation, { passive: true });
    overlayEl?.addEventListener('touchmove', stopTouchPropagation, { passive: true });
    overlayEl?.addEventListener('touchend', stopTouchPropagation, { passive: true });
  });
  onDestroy(() => {
    document.body.style.overflow = '';
    document.removeEventListener('keydown', handleKeydown, true);
    overlayEl?.removeEventListener('touchstart', stopTouchPropagation);
    overlayEl?.removeEventListener('touchmove', stopTouchPropagation);
    overlayEl?.removeEventListener('touchend', stopTouchPropagation);
  });

  // Paragraph tracking for read progress
  const paragraphTracking = useParagraphTracking({
    contentEl: () => readerBodyEl,
    scrollRoot: () => overlayEl,
    itemKey: () => itemKey,
    itemType: () => labelItemType,
    enabled: () => true,
  });

  // Link interception for showing context menu on link clicks
  const linkInterception = useLinkInterception({
    contentEl: () => readerBodyEl,
    enabled: () => true,
  });

  // Highlights hook
  const highlightsHook = useHighlights({
    contentEl: () => readerBodyEl,
    itemKey: () => itemKey,
    itemType: () => labelItemType,
    enabled: () => true,
  });

  // Set up observer when reader body is mounted
  $effect(() => {
    if (readerBodyEl && overlayEl) {
      tick().then(() => {
        paragraphTracking.setupObserver();
        linkInterception.attach();
        highlightsHook.attach();
        setTimeout(() => {
          suppressScrollHide = true;
          const restored = paragraphTracking.restorePosition();
          if (restored) {
            // Wait for smooth scroll to finish before re-enabling header hide
            setTimeout(() => {
              if (overlayEl) lastScrollY = overlayEl.scrollTop;
              suppressScrollHide = false;
            }, 600);
          } else {
            suppressScrollHide = false;
          }
        }, 100);
      });
    }
    return () => {
      paragraphTracking.cleanup();
      linkInterception.detach();
      highlightsHook.detach();
    };
  });

  let deleteConfirming = $state(false);
  let deleteTimer: ReturnType<typeof setTimeout> | undefined;

  function handleDeleteClick() {
    if (deleteConfirming) {
      clearTimeout(deleteTimer);
      deleteConfirming = false;
      onRemove?.();
    } else {
      deleteConfirming = true;
      deleteTimer = setTimeout(() => {
        deleteConfirming = false;
      }, 3000);
    }
  }

  function handleOpenUrl() {
    if (itemUrl) window.open(itemUrl, '_blank', 'noopener');
  }
</script>

<div class="reader-overlay" bind:this={overlayEl} onscroll={handleScroll}>
  <div class="reader-container">
    <!-- Desktop: top header -->
    <header class="reader-header desktop-only" class:hidden={!controlsVisible}>
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

        <span class="action-separator"></span>

        {#if onArchive}
          <button
            class="action-btn"
            onclick={() => onArchive()}
            title={isArchived ? 'Move to inbox' : 'Archive (e)'}
          >
            <Icon name={isArchived ? 'inbox' : 'archive'} size={18} />
            <span class="action-label">{isArchived ? 'Inbox' : 'Archive'}</span>
          </button>
        {/if}

        {#if onToggleSave}
          <button
            class="action-btn"
            class:active={isSaved}
            onclick={() => onToggleSave!()}
            title={isSaved ? 'Unsave' : 'Save (s)'}
          >
            <Icon name="bookmark" size={18} />
            <span class="action-label">{isSaved ? 'Unsave' : 'Save'}</span>
          </button>
        {/if}

        {#if onShare}
          <button
            class="action-btn"
            class:active={isShared}
            onclick={() => onShare!()}
            title={shareLabel}
          >
            <Icon name="share" size={18} />
            <span class="action-label">{shareLabel}</span>
          </button>
        {/if}

        <button
          class="action-btn"
          class:active={tagMenuOpen}
          bind:this={tagBtnRef}
          onclick={() => (tagMenuOpen = !tagMenuOpen)}
          title="Tag (t)"
        >
          <Icon name="tag" size={18} />
          <span class="action-label">Tag{itemTags.length > 0 ? ` (${itemTags.length})` : ''}</span>
        </button>

        <div class="overflow-menu-wrapper" bind:this={overflowRef}>
          <PopoverMenu items={overflowItems} />
        </div>
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

    <!-- Mobile: bottom bar -->
    <div class="reader-bottom-bar mobile-only" class:hidden={!controlsVisible}>
      <button class="bottom-btn" onclick={onClose} title="Back (Escape)">
        <Icon name="arrow-left" size={20} />
      </button>

      <div class="bottom-bar-right">
        {#if onArchive}
          <button
            class="bottom-btn"
            onclick={() => onArchive()}
            title={isArchived ? 'Move to inbox' : 'Archive (e)'}
          >
            <Icon name={isArchived ? 'inbox' : 'archive'} size={20} />
          </button>
          <span class="bottom-separator"></span>
        {/if}
        {#if onToggleSave}
          <button
            class="bottom-btn"
            class:active={isSaved}
            onclick={() => onToggleSave!()}
            title={isSaved ? 'Unsave' : 'Save (s)'}
          >
            <Icon name="bookmark" size={20} />
          </button>
        {/if}
        {#if onShare}
          <button
            class="bottom-btn"
            class:active={isShared}
            onclick={() => onShare!()}
            title={shareLabel}
          >
            <Icon name="share" size={20} />
          </button>
        {/if}
        <button
          class="bottom-btn"
          class:active={tagMenuOpen}
          bind:this={tagBtnRef}
          onclick={() => (tagMenuOpen = !tagMenuOpen)}
          title="Tag (t)"
        >
          <Icon name="tag" size={20} />
        </button>
        <span class="bottom-separator"></span>
        <button
          class="bottom-btn"
          class:active={styleSheetOpen}
          onclick={() => (styleSheetOpen = true)}
          title="Style & Actions"
        >
          <Icon name="sliders" size={20} />
        </button>
      </div>
    </div>

    <!-- Mobile: style & actions bottom sheet -->
    {#if mobileStore.isMobile}
      <BottomSheet
        open={styleSheetOpen}
        onclose={() => (styleSheetOpen = false)}
        title="Style & Actions"
      >
        <div class="style-sheet-content">
          <div class="style-sheet-section">
            <div class="style-sheet-label">Appearance</div>
            <div class="toolbar-wrapper">
              <AppearanceToolbar />
            </div>
          </div>

          <div class="style-sheet-section">
            <div class="style-sheet-label">Actions</div>
            <div class="style-sheet-actions">
              <button
                class="sheet-action-btn"
                onclick={() => {
                  styleSheetOpen = false;
                  tagMenuOpen = true;
                }}
              >
                <Icon name="tag" size={18} />
                <span>Tag{itemTags.length > 0 ? ` (${itemTags.length})` : ''}</span>
              </button>
              {#if onToggleSave}
                <button
                  class="sheet-action-btn"
                  onclick={() => {
                    onToggleSave!();
                    styleSheetOpen = false;
                  }}
                >
                  <Icon name="bookmark" size={18} />
                  <span>{isSaved ? 'Unsave' : 'Save'}</span>
                </button>
              {/if}
              {#if onShare}
                <button
                  class="sheet-action-btn"
                  class:active={isShared}
                  onclick={() => {
                    onShare!();
                    styleSheetOpen = false;
                  }}
                >
                  <Icon name="share" size={18} />
                  <span>{shareLabel}</span>
                </button>
              {/if}
              {#if onSaveToSemble}
                <button
                  class="sheet-action-btn"
                  onclick={() => {
                    onSaveToSemble!();
                    styleSheetOpen = false;
                  }}
                >
                  <Icon name="semble" size={18} />
                  <span>Save to Semble</span>
                </button>
              {/if}
              {#if onSaveToMargin}
                <button
                  class="sheet-action-btn"
                  onclick={() => {
                    onSaveToMargin!();
                    styleSheetOpen = false;
                  }}
                >
                  <Icon name="margin" size={18} />
                  <span>Save to Margin</span>
                </button>
              {/if}
              <button
                class="sheet-action-btn"
                onclick={() => {
                  handleOpenUrl();
                  styleSheetOpen = false;
                }}
              >
                <Icon name="external-link" size={18} />
                <span>Open in browser</span>
              </button>
              {#if onRemove}
                <button
                  class="sheet-action-btn danger"
                  onclick={() => {
                    if (deleteConfirming) {
                      clearTimeout(deleteTimer);
                      deleteConfirming = false;
                      onRemove!();
                      styleSheetOpen = false;
                    } else {
                      deleteConfirming = true;
                      deleteTimer = setTimeout(() => (deleteConfirming = false), 3000);
                    }
                  }}
                >
                  <Icon name="trash" size={18} />
                  <span>{deleteConfirming ? 'Confirm delete?' : 'Delete'}</span>
                </button>
              {/if}
            </div>
          </div>
        </div>
      </BottomSheet>

      {#if tagMenuOpen}
        <TagMenu
          {itemKey}
          itemType={labelItemType}
          anchorEl={tagBtnRef}
          onClose={() => (tagMenuOpen = false)}
        />
      {/if}
    {/if}

    {#if linkInterception.menuState}
      {#key linkInterception.menuState.url + linkInterception.menuState.anchorRect.top}
        <LinkContextMenu
          url={linkInterception.menuState.url}
          linkText={linkInterception.menuState.linkText}
          anchorRect={linkInterception.menuState.anchorRect}
          onClose={linkInterception.closeMenu}
        />
      {/key}
    {/if}

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

      <div class="reader-body-wrapper">
        <div class="reader-body" bind:this={readerBodyEl} use:bskyEmbed>
          {@html sanitizedContent}
        </div>
      </div>
    </article>
  </div>
</div>

{#if highlightsHook.popoverState}
  <HighlightPopover
    mode={highlightsHook.popoverState.mode}
    anchorRect={highlightsHook.popoverState.anchorRect}
    onHighlight={highlightsHook.createHighlightFromPopover}
    onRemove={highlightsHook.removeHighlightFromPopover}
    onClose={highlightsHook.closePopover}
  />
{/if}

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
    overscroll-behavior: contain;
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

  .overflow-menu-wrapper {
    display: flex;
    align-items: center;
  }

  .overflow-menu-wrapper :global(.menu-trigger) {
    width: auto;
    height: auto;
    padding: 0;
    border-radius: 0;
    background: none;
    color: var(--color-text-secondary);
  }

  .overflow-menu-wrapper :global(.menu-trigger:hover) {
    background: none;
    color: var(--color-primary, #0066cc);
  }

  .action-separator {
    width: 1px;
    background: var(--color-border, #e5e7eb);
    align-self: stretch;
    margin: -0.25rem 0;
  }

  /* Mobile bottom bar */
  .reader-bottom-bar {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem 1rem;
    padding-bottom: calc(0.75rem + env(safe-area-inset-bottom, 0px));
    z-index: 10;
    pointer-events: none;
    transition:
      transform 0.25s ease,
      opacity 0.25s ease;
  }

  .reader-bottom-bar.hidden {
    transform: translateY(100%);
    opacity: 0;
    pointer-events: none;
  }

  .bottom-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.85);
    backdrop-filter: blur(8px);
    border: none;
    padding: 0.7rem;
    border-radius: 999px;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
    color: var(--color-text-secondary);
    pointer-events: auto;
    cursor: pointer;
    transition: color 0.15s;
  }

  .bottom-btn:active,
  .bottom-btn.active {
    color: var(--color-primary, #0066cc);
  }

  .bottom-bar-right {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    background: rgba(255, 255, 255, 0.85);
    backdrop-filter: blur(8px);
    border-radius: 999px;
    padding: 0.25rem 0.5rem;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
    pointer-events: auto;
  }

  .bottom-bar-right .bottom-btn {
    background: none;
    backdrop-filter: none;
    box-shadow: none;
    padding: 0.6rem;
  }

  .bottom-separator {
    width: 1px;
    height: 1.25rem;
    background: var(--color-border, #e0e0e0);
    opacity: 0.5;
  }

  /* Desktop/mobile visibility */
  .mobile-only {
    display: none;
  }

  .desktop-only {
    display: flex;
  }

  @media (max-width: 1000px) {
    .mobile-only {
      display: flex;
    }

    .desktop-only {
      display: none !important;
    }

    /* Hide floating style toolbar on mobile (uses BottomSheet instead) */
    .style-toolbar-fixed {
      display: none;
    }
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

  .reader-body-wrapper {
    position: relative;
  }

  .reader-body {
    position: relative;
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

  .reader-body :global(video) {
    max-width: 100%;
    height: auto;
    border-radius: 6px;
    margin: 1rem 0;
    cursor: auto;
  }

  .reader-body :global(iframe) {
    display: block;
    width: 100%;
    max-width: 100%;
    aspect-ratio: 16 / 9;
    height: auto;
    border: 0;
    border-radius: 6px;
    margin: 1rem 0;
    cursor: auto;
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
    padding-left: 2rem;
  }

  .reader-body :global(li) {
    margin: 0.25rem 0;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }

  .reader-body :global(mark.highlight) {
    background-color: color-mix(in srgb, #f5c518 25%, transparent);
    border-radius: 1px;
    cursor: pointer;
    transition: background-color 0.2s ease;
  }

  .reader-body :global(mark.highlight:hover) {
    background-color: color-mix(in srgb, #f5c518 40%, transparent);
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

  /* Style bottom sheet content */
  .style-sheet-content {
    padding: 0.5rem 1.25rem 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .style-sheet-section {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  .style-sheet-label {
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding-left: 0.25rem;
  }

  .style-sheet-content .toolbar-wrapper {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .style-sheet-content .toolbar-wrapper :global(.appearance-toolbar) {
    background: none;
    box-shadow: none;
    backdrop-filter: none;
    padding: 0;
    border-radius: 0;
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  .style-sheet-content .toolbar-wrapper :global(.segment-btn) {
    padding: 0.6rem 0.75rem;
  }

  .style-sheet-content .toolbar-wrapper :global(.font-preview) {
    font-size: 1.125rem;
  }

  .style-sheet-content .toolbar-wrapper :global(.size-btn) {
    padding: 0.6rem;
  }

  .style-sheet-content .toolbar-wrapper :global(.size-btn .icon) {
    width: 18px;
    height: 18px;
  }

  .style-sheet-content .toolbar-wrapper :global(.size-label) {
    font-size: 0.9375rem;
    min-width: 1.75rem;
  }

  .style-sheet-content .toolbar-wrapper :global(.group-label) {
    display: block;
    font-size: 0.75rem;
  }

  .style-sheet-actions {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--color-border);
    border-radius: 10px;
    overflow: hidden;
  }

  .sheet-action-btn {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    background: none;
    border: none;
    border-bottom: 1px solid var(--color-border);
    color: var(--color-text);
    font-size: 0.9375rem;
    text-align: left;
    width: 100%;
    transition: background 0.1s;
  }

  .sheet-action-btn:last-child {
    border-bottom: none;
  }

  .sheet-action-btn:active {
    background: var(--color-bg-secondary, #f5f5f5);
  }

  .sheet-action-btn.active,
  .sheet-action-btn.active :global(.icon) {
    color: var(--color-primary, #0066cc);
  }

  .sheet-action-btn :global(.icon) {
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }

  .sheet-action-btn.danger {
    color: var(--color-error, #dc2626);
  }

  .sheet-action-btn.danger :global(.icon) {
    color: var(--color-error, #dc2626);
  }

  @media (max-width: 1000px) {
    .reader-container {
      padding: 1rem 1rem calc(5rem + env(safe-area-inset-bottom, 0px));
    }
  }

  @media (max-width: 640px) {
    .reader-container {
      padding: 1rem 1rem calc(5rem + env(safe-area-inset-bottom, 0px));
    }

    .reader-title {
      font-size: 1.375rem;
    }
  }

  @media (prefers-color-scheme: dark) {
    .bottom-btn {
      background: rgba(40, 40, 40, 0.95);
    }

    .bottom-bar-right {
      background: rgba(40, 40, 40, 0.95);
    }

    .bottom-bar-right .bottom-btn {
      background: none;
    }

    .sheet-action-btn:active {
      background: rgba(255, 255, 255, 0.1);
    }
  }
</style>
