<script lang="ts">
  import type { ItemLabelType } from '$lib/types';
  import type { ArticleFont } from '$lib/stores/preferences.svelte';
  import { preferences } from '$lib/stores/preferences.svelte';
  import { mobileStore } from '$lib/stores/mediaQuery.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import PopoverMenu from '$lib/components/PopoverMenu.svelte';
  import BottomSheet from '$lib/components/common/BottomSheet.svelte';
  import AppearanceToolbar from './AppearanceToolbar.svelte';
  import TagMenu from './TagMenu.svelte';

  let {
    itemKey,
    itemType,
    itemTags = [],
    isArchived = false,
    isSaved = false,
    controlsVisible = true,
    scrolled = false,
    readingProgress = 0,
    progressVisible = false,
    onClose,
    onArchive,
    onToggleSave,
    onSaveToSemble,
    onSaveToMargin,
    onRemove,
    onOpenUrl,
    onContents,
    onNextParagraph,
    onPreviousParagraph,
    onHighlightParagraph,
  }: {
    itemKey: string;
    itemType: ItemLabelType;
    itemTags?: string[];
    isArchived?: boolean;
    isSaved?: boolean;
    controlsVisible?: boolean;
    scrolled?: boolean;
    readingProgress?: number;
    progressVisible?: boolean;
    onClose: () => void;
    onArchive?: () => void;
    onToggleSave?: () => void;
    onSaveToSemble?: () => void;
    onSaveToMargin?: () => void;
    onRemove?: () => void;
    onOpenUrl: () => void;
    onContents?: () => void;
    onNextParagraph?: () => void;
    onPreviousParagraph?: () => void;
    onHighlightParagraph?: () => void;
  } = $props();

  let styleMenuOpen = $state(false);
  let styleSheetOpen = $state(false);
  let tagMenuOpen = $state(false);
  let overflowMenuOpen = $state(false);
  let desktopTagRef = $state<HTMLButtonElement | null>(null);
  let mobileTagRef = $state<HTMLButtonElement | null>(null);
  let headerRef = $state<HTMLElement | null>(null);
  let deleteConfirming = $state(false);
  let deleteTimer: ReturnType<typeof setTimeout> | undefined;
  let headerHidden = $derived(
    !controlsVisible && !styleMenuOpen && !tagMenuOpen && !overflowMenuOpen
  );

  const fontOptions: { value: ArticleFont; label: string; family: string }[] = [
    { value: 'sans-serif', label: 'Sans', family: 'sans-serif' },
    { value: 'serif', label: 'Serif', family: 'serif' },
    { value: 'mono', label: 'Mono', family: 'monospace' },
    { value: 'literata', label: 'Literata', family: 'Literata, serif' },
  ];
  const sizeLabels: Record<string, string> = { xs: 'XS', sm: 'S', md: 'M', lg: 'L', xl: 'XL' };

  function handleDelete() {
    if (deleteConfirming) {
      clearTimeout(deleteTimer);
      deleteConfirming = false;
      onRemove?.();
      return;
    }
    deleteConfirming = true;
    deleteTimer = setTimeout(() => (deleteConfirming = false), 3000);
  }

  let overflowItems = $derived.by(() => {
    const items: {
      label: string;
      icon?: string;
      variant?: 'default' | 'danger';
      keepOpen?: boolean;
      onclick: () => void;
    }[] = [];
    if (onContents) items.push({ label: 'Contents', icon: 'list', onclick: onContents });
    items.push({
      label: `Tag${itemTags.length ? ` (${itemTags.length})` : ''}`,
      icon: 'tag',
      onclick: () => (tagMenuOpen = true),
    });
    if (onToggleSave) {
      items.push({ label: isSaved ? 'Unsave' : 'Save', icon: 'bookmark', onclick: onToggleSave });
    }
    if (onSaveToSemble) {
      items.push({ label: 'Save to Semble', icon: 'semble', onclick: onSaveToSemble });
    }
    if (onSaveToMargin) {
      items.push({ label: 'Save to Margin', icon: 'margin', onclick: onSaveToMargin });
    }
    if (onRemove) {
      items.push({
        label: deleteConfirming ? 'Confirm delete?' : 'Delete',
        icon: 'trash',
        variant: deleteConfirming ? 'danger' : 'default',
        keepOpen: !deleteConfirming,
        onclick: handleDelete,
      });
    }
    items.push({ label: 'Open in browser', icon: 'external-link', onclick: onOpenUrl });
    return items;
  });

  function handleKeydown(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.isContentEditable ||
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT')
    ) {
      return;
    }
    if (tagMenuOpen) {
      event.stopPropagation();
      return;
    }
    const noMod = !event.metaKey && !event.ctrlKey && !event.altKey;
    let action: (() => void) | undefined;
    if (event.key === 'Escape') action = onClose;
    else if (event.key === 'e' && noMod) action = onArchive;
    else if (event.key === 's' && noMod) action = onToggleSave;
    else if (event.key === 't' && noMod) action = () => (tagMenuOpen = !tagMenuOpen);
    else if (event.key === 'ArrowDown' && noMod) action = onNextParagraph;
    else if (event.key === 'ArrowUp' && noMod) action = onPreviousParagraph;
    else if (event.key === 'h' && noMod) action = onHighlightParagraph;
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    action();
  }

  function clickOutside(event: MouseEvent) {
    if (styleMenuOpen && headerRef && !headerRef.contains(event.target as Node)) {
      styleMenuOpen = false;
    }
  }

  $effect(() => {
    document.addEventListener('keydown', handleKeydown, true);
    document.addEventListener('click', clickOutside);
    return () => {
      document.removeEventListener('keydown', handleKeydown, true);
      document.removeEventListener('click', clickOutside);
      clearTimeout(deleteTimer);
    };
  });
</script>

<div
  class="reading-progress"
  class:visible={progressVisible}
  role="progressbar"
  aria-label="Reading progress"
  aria-valuemin={0}
  aria-valuemax={100}
  aria-valuenow={Math.round(readingProgress * 100)}
>
  <div class="reading-progress-fill" style:transform={`scaleX(${readingProgress})`}></div>
</div>

<header
  class="reader-header desktop-only"
  class:scrolled
  class:hidden={headerHidden}
  bind:this={headerRef}
>
  <div class="reader-header-bar">
    <button class="action-btn" onclick={onClose} title="Back (Escape)">
      <Icon name="arrow-left" size={16} />
      <span class="action-label">Back</span>
    </button>
    <div class="reader-actions-right">
      {#if onContents}
        <button class="action-btn" onclick={onContents} title="Contents">
          <Icon name="list" size={16} />
          <span class="action-label">Contents</span>
        </button>
      {/if}
      <button
        class="action-btn"
        class:active={styleMenuOpen}
        onclick={() => (styleMenuOpen = !styleMenuOpen)}
        title="Style"
      >
        <Icon name="type" size={16} />
        <span class="action-label">Style</span>
      </button>
      <span class="action-separator"></span>
      {#if onArchive}
        <button
          class="action-btn"
          onclick={onArchive}
          title={isArchived ? 'Move to inbox' : 'Archive (e)'}
        >
          <Icon name={isArchived ? 'inbox' : 'archive'} size={16} />
          <span class="action-label">{isArchived ? 'Inbox' : 'Archive'}</span>
        </button>
      {/if}
      {#if onToggleSave}
        <button
          class="action-btn"
          class:active={isSaved}
          onclick={onToggleSave}
          title={isSaved ? 'Unsave' : 'Save (s)'}
        >
          <Icon name="bookmark" size={16} />
          <span class="action-label">{isSaved ? 'Unsave' : 'Save'}</span>
        </button>
      {/if}
      <button
        class="action-btn"
        class:active={tagMenuOpen}
        bind:this={desktopTagRef}
        onclick={() => (tagMenuOpen = !tagMenuOpen)}
        title="Tag (t)"
      >
        <Icon name="tag" size={16} />
        <span class="action-label">Tag{itemTags.length ? ` (${itemTags.length})` : ''}</span>
      </button>
      <div class="overflow-menu-wrapper">
        <PopoverMenu items={overflowItems} bind:open={overflowMenuOpen} />
      </div>
    </div>
  </div>

  {#if styleMenuOpen}
    <div class="reader-style-row">
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
              title="Decrease font size"><Icon name="minus" size={14} /></button
            >
            <span class="size-label">{sizeLabels[preferences.articleFontSize]}</span>
            <button
              class="size-btn"
              onclick={() => preferences.increaseFontSize()}
              disabled={preferences.articleFontSize === 'xl'}
              title="Increase font size"><Icon name="plus" size={14} /></button
            >
          </div>
        </div>
      </div>
    </div>
  {/if}
  {#if tagMenuOpen && !mobileStore.isMobile}
    <TagMenu {itemKey} {itemType} anchorEl={desktopTagRef} onClose={() => (tagMenuOpen = false)} />
  {/if}
</header>

<div class="reader-bottom-bar mobile-only" class:hidden={!controlsVisible}>
  <button class="bottom-btn" onclick={onClose} title="Back (Escape)">
    <Icon name="arrow-left" size={20} />
  </button>
  <div class="bottom-bar-right">
    {#if onContents}
      <button class="bottom-btn" onclick={onContents} title="Contents">
        <Icon name="list" size={20} />
      </button>
    {/if}
    {#if onArchive}
      <button
        class="bottom-btn"
        onclick={onArchive}
        title={isArchived ? 'Move to inbox' : 'Archive (e)'}
      >
        <Icon name={isArchived ? 'inbox' : 'archive'} size={20} />
      </button>
      <span class="bottom-separator"></span>
    {/if}
    {#if onToggleSave}
      <button class="bottom-btn" class:active={isSaved} onclick={onToggleSave} title="Save (s)">
        <Icon name="bookmark" size={20} />
      </button>
    {/if}
    <button
      class="bottom-btn"
      class:active={tagMenuOpen}
      bind:this={mobileTagRef}
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

{#if mobileStore.isMobile}
  <BottomSheet
    open={styleSheetOpen}
    onclose={() => (styleSheetOpen = false)}
    title="Style & Actions"
  >
    <div class="style-sheet-content">
      <div class="style-sheet-section">
        <div class="style-sheet-label">Appearance</div>
        <div class="toolbar-wrapper"><AppearanceToolbar /></div>
      </div>
      <div class="style-sheet-section">
        <div class="style-sheet-label">Actions</div>
        <div class="style-sheet-actions">
          {#if onContents}
            <button
              class="sheet-action-btn"
              onclick={() => {
                onContents();
                styleSheetOpen = false;
              }}
            >
              <Icon name="list" size={18} /><span>Contents</span>
            </button>
          {/if}
          <button
            class="sheet-action-btn"
            onclick={() => {
              styleSheetOpen = false;
              tagMenuOpen = true;
            }}
          >
            <Icon name="tag" size={18} /><span
              >Tag{itemTags.length ? ` (${itemTags.length})` : ''}</span
            >
          </button>
          {#if onToggleSave}
            <button
              class="sheet-action-btn"
              onclick={() => {
                onToggleSave();
                styleSheetOpen = false;
              }}
            >
              <Icon name="bookmark" size={18} /><span>{isSaved ? 'Unsave' : 'Save'}</span>
            </button>
          {/if}
          {#if onSaveToSemble}
            <button
              class="sheet-action-btn"
              onclick={() => {
                onSaveToSemble();
                styleSheetOpen = false;
              }}
            >
              <Icon name="semble" size={18} /><span>Save to Semble</span>
            </button>
          {/if}
          {#if onSaveToMargin}
            <button
              class="sheet-action-btn"
              onclick={() => {
                onSaveToMargin();
                styleSheetOpen = false;
              }}
            >
              <Icon name="margin" size={18} /><span>Save to Margin</span>
            </button>
          {/if}
          <button
            class="sheet-action-btn"
            onclick={() => {
              onOpenUrl();
              styleSheetOpen = false;
            }}
          >
            <Icon name="external-link" size={18} /><span>Open in browser</span>
          </button>
          {#if onRemove}
            <button class="sheet-action-btn danger" onclick={handleDelete}>
              <Icon name="trash" size={18} /><span
                >{deleteConfirming ? 'Confirm delete?' : 'Delete'}</span
              >
            </button>
          {/if}
        </div>
      </div>
    </div>
  </BottomSheet>
  {#if tagMenuOpen}
    <TagMenu {itemKey} {itemType} anchorEl={mobileTagRef} onClose={() => (tagMenuOpen = false)} />
  {/if}
{/if}

<style>
  .reading-progress {
    position: fixed;
    top: env(safe-area-inset-top, 0px);
    left: 0;
    right: 0;
    z-index: 200;
    height: 2px;
    overflow: hidden;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s ease;
  }
  .reading-progress.visible {
    opacity: 1;
  }
  .reading-progress-fill {
    height: 100%;
    background: var(--color-primary, #0066cc);
    transform-origin: left;
    will-change: transform;
  }
  .reader-header {
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    flex-direction: column;
    margin-bottom: 0.5rem;
    background: var(--color-bg, #fff);
    transition: transform 0.25s ease;
  }
  .reader-header.hidden {
    transform: translateY(-100%);
  }
  .reader-header::after {
    content: '';
    position: absolute;
    inset-inline: 0;
    bottom: 0;
    max-width: 800px;
    height: 1px;
    margin-inline: auto;
    background: var(--color-border);
    opacity: 0;
    transition: opacity 0.2s ease;
  }
  .reader-header.scrolled::after {
    opacity: 1;
  }
  .reader-header-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    width: 100%;
    max-width: 800px;
    margin: 0 auto;
    padding: 0.625rem 1rem;
  }
  .reader-actions-right,
  .style-toolbar,
  .toolbar-group,
  .segment-group,
  .size-controls {
    display: flex;
    align-items: center;
  }
  .reader-actions-right {
    gap: 0.5rem;
  }
  .action-btn,
  .segment-btn,
  .size-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--color-text-secondary);
    cursor: pointer;
  }
  .action-btn {
    gap: 0.35rem;
    padding: 0.4rem 0.6rem;
  }
  .action-btn:hover,
  .action-btn.active,
  .segment-btn.active {
    color: var(--color-text);
    background: var(--color-bg-secondary, #f5f5f5);
  }
  .action-label {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }
  .action-separator,
  .toolbar-divider,
  .bottom-separator {
    width: 1px;
    background: var(--color-border);
    opacity: 0.5;
  }
  .action-separator,
  .toolbar-divider {
    height: 1rem;
  }
  .overflow-menu-wrapper :global(.menu-trigger) {
    width: auto;
    height: auto;
    padding: 0.4rem;
    border-radius: 6px;
    background: none;
    color: var(--color-text-secondary);
  }
  .reader-style-row {
    display: flex;
    justify-content: flex-end;
    width: 100%;
    max-width: 800px;
    margin: 0 auto;
    padding: 0 1rem 0.625rem;
  }
  .style-toolbar {
    gap: 0.125rem;
  }
  .toolbar-group {
    gap: 0.375rem;
  }
  .group-label,
  .style-sheet-label {
    color: var(--color-text-secondary);
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
  }
  .segment-group {
    gap: 1px;
  }
  .segment-btn {
    padding: 0.35rem 0.5rem;
  }
  .font-preview {
    font-size: var(--text-md);
    line-height: var(--leading-none);
    font-size-adjust: 0.52;
  }
  .size-btn {
    padding: 0.3rem;
  }
  .size-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }
  .size-label {
    min-width: 1.25rem;
    color: var(--color-text);
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    text-align: center;
  }
  .reader-bottom-bar {
    position: fixed;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem calc(0.75rem + env(safe-area-inset-bottom, 0px));
    pointer-events: none;
    transition:
      transform 0.25s ease,
      opacity 0.25s ease;
  }
  .reader-bottom-bar.hidden {
    transform: translateY(100%);
    opacity: 0;
  }
  .bottom-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.7rem;
    border: 0;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.9);
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
    color: var(--color-text-secondary);
    pointer-events: auto;
  }
  .bottom-btn.active,
  .bottom-btn:active {
    color: var(--color-primary, #0066cc);
  }
  .bottom-bar-right {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    padding: 0.25rem 0.5rem;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.9);
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
    pointer-events: auto;
  }
  .bottom-bar-right .bottom-btn {
    padding: 0.6rem;
    background: none;
    box-shadow: none;
  }
  .bottom-separator {
    height: 1.25rem;
  }
  .mobile-only {
    display: none;
  }
  .desktop-only {
    display: flex;
  }
  .style-sheet-content {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    padding: 0.5rem 1.25rem 1.5rem;
  }
  .style-sheet-section {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }
  .style-sheet-actions {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--color-border);
    border-radius: 10px;
  }
  .sheet-action-btn {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.75rem 1rem;
    border: 0;
    border-bottom: 1px solid var(--color-border);
    background: none;
    color: var(--color-text);
    font-size: var(--text-lg);
    text-align: left;
  }
  .sheet-action-btn:last-child {
    border-bottom: 0;
  }
  .sheet-action-btn.danger {
    color: var(--color-error, #f44336);
  }
  @media (max-width: 1100px) {
    .action-label {
      display: none;
    }
    .action-btn {
      padding: 0.4rem;
    }
  }
  @media (max-width: 1000px) {
    .mobile-only {
      display: flex;
    }
    .desktop-only {
      display: none !important;
    }
  }
  @media (prefers-color-scheme: dark) {
    .bottom-btn,
    .bottom-bar-right {
      background: rgba(40, 40, 40, 0.95);
    }
    .bottom-bar-right .bottom-btn {
      background: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .reading-progress,
    .reader-header,
    .reader-header::after,
    .reader-bottom-bar {
      transition: none;
    }
  }
</style>
