<script lang="ts">
  import type { ItemLabelType } from '$lib/types';
  import { preferences } from '$lib/stores/preferences.svelte';
  import { mobileStore } from '$lib/stores/mediaQuery.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import PopoverMenu from '$lib/components/PopoverMenu.svelte';
  import BottomSheet from '$lib/components/common/BottomSheet.svelte';
  import AppearanceToolbar from './AppearanceToolbar.svelte';
  import ReaderBottomBar from './ReaderBottomBar.svelte';
  import ReadingModeToggle from './ReadingModeToggle.svelte';
  import TagMenu from './TagMenu.svelte';

  let {
    itemKey,
    itemType,
    itemTags = [],
    showTag = true,
    isArchived = false,
    isSaved = false,
    controlsVisible = true,
    readingProgress = 0,
    progressVisible = false,
    barTitle = '',
    barSource = '',
    barTitleVisible = false,
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
    /** When false, hide all tagging affordances (e.g. the magazine reader, whose
     *  chrome acts on the issue, not the article being read). */
    showTag?: boolean;
    isArchived?: boolean;
    isSaved?: boolean;
    controlsVisible?: boolean;
    /** 0–1. Drives both drawings of the rail: the bar's bottom edge and the
     *  detached hairline that replaces it once the bar slides away. In paged mode
     *  the host feeds page position here so the edge means the same thing. */
    readingProgress?: number;
    progressVisible?: boolean;
    /** What the bar says once the piece's own heading has scrolled away. */
    barTitle?: string;
    barSource?: string;
    barTitleVisible?: boolean;
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
  let paged = $derived(preferences.readerViewMode === 'paged');

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
    // Contents isn't added here: it already has its own always-visible header
    // button (same `onContents` gate), so listing it in the overflow is redundant.
    if (showTag) {
      items.push({
        label: `Tag${itemTags.length ? ` (${itemTags.length})` : ''}`,
        icon: 'tag',
        onclick: () => (tagMenuOpen = true),
      });
    }
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
    else if (event.key === 't' && noMod && showTag) action = () => (tagMenuOpen = !tagMenuOpen);
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

<!-- Detached progress hairline: the rail's understudy, drawing the same value
     while the bar it belongs to is off-screen. It crossfades in as the bar slides
     away and pins to whichever edge that bar occupies — the top on desktop, the
     bottom (clear of the home indicator) on mobile. -->
<div
  class="reading-progress"
  class:visible={progressVisible}
  class:detached={headerHidden}
  class:bar-hidden={!controlsVisible}
  role="progressbar"
  aria-label="Reading progress"
  aria-valuemin={0}
  aria-valuemax={100}
  aria-valuenow={Math.round(readingProgress * 100)}
>
  <div class="reading-progress-fill" style:transform={`scaleX(${readingProgress})`}></div>
</div>

<!-- Desktop: a full-bleed bar framing the viewport rather than tracking the
     reading column, so it sits identically in scroll and paged mode. -->
<header class="reader-header desktop-only" class:hidden={headerHidden} bind:this={headerRef}>
  <div class="reader-header-bar">
    <button class="action-btn" onclick={onClose} title="Back (Escape)">
      <Icon name="arrow-left" size={16} />
      <span class="action-label">Back</span>
    </button>
    <!-- Takes over once the issue's own masthead has scrolled away. Decorative:
         the heading itself is the accessible name. -->
    <div class="reader-bar-title" class:visible={barTitleVisible} aria-hidden="true">
      <span class="reader-bar-title-text">{barTitle}</span>
      {#if barSource}
        <span class="reader-bar-title-source">{barSource}</span>
      {/if}
    </div>
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
      <button
        class="action-btn"
        class:active={paged}
        onclick={() => preferences.toggleReaderViewMode()}
        title={paged ? 'Switch to scroll view' : 'Switch to paged view'}
      >
        <Icon name={paged ? 'align-justify' : 'book-open'} size={16} />
        <span class="action-label">{paged ? 'Scroll' : 'Pages'}</span>
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
      {#if showTag}
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
      {/if}
      <button class="action-btn" onclick={onOpenUrl} title="Open in browser">
        <Icon name="external-link" size={16} />
        <span class="action-label">Open</span>
      </button>
      {#if overflowItems.length}
        <div class="overflow-menu-wrapper">
          <PopoverMenu items={overflowItems} bind:open={overflowMenuOpen} />
        </div>
      {/if}
    </div>
  </div>

  {#if styleMenuOpen}
    <div class="reader-style-row">
      <AppearanceToolbar />
    </div>
  {/if}
  {#if showTag && tagMenuOpen && !mobileStore.isMobile}
    <TagMenu {itemKey} {itemType} anchorEl={desktopTagRef} onClose={() => (tagMenuOpen = false)} />
  {/if}

  <!-- The bar's bottom edge *is* the progress rail: one element doing the job of
       the divider and the progress bar, so the bar reads as a definite edge. -->
  <div class="reader-rail" aria-hidden="true">
    <div class="reader-rail-fill" style:transform={`scaleX(${readingProgress})`}></div>
  </div>
</header>

<ReaderBottomBar
  progress={readingProgress}
  visible={controlsVisible}
  onBack={onClose}
  {onContents}
  {onArchive}
  {isArchived}
  {onToggleSave}
  {isSaved}
  onTag={showTag ? () => (tagMenuOpen = !tagMenuOpen) : undefined}
  tagCount={itemTags.length}
  tagActive={tagMenuOpen}
  bind:tagButtonEl={mobileTagRef}
  onMore={() => (styleSheetOpen = true)}
  moreActive={styleSheetOpen}
/>

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
        <ReadingModeToggle />
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
          {#if showTag}
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
          {/if}
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
  {#if showTag && tagMenuOpen}
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
  /* Only while the bar that owns the rail is off-screen — otherwise two lines
     would draw the same value. */
  @media (min-width: 1001px) {
    .reading-progress.visible.detached {
      opacity: 1;
    }
  }
  .reading-progress-fill {
    height: 100%;
    background: var(--color-primary, #0066cc);
    transform-origin: left;
    will-change: transform;
  }
  /* Full-bleed bar: it frames the viewport rather than the reading column, which
     is the one geometry that's right in both scroll (800px) and paged (1200px)
     mode. Flat-by-default — the rail below is the only edge it needs. */
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
  /* The rail: bottom edge and progress indicator in one. Solid 2px Divider track
     so the edge is unmistakable, One Blue fill driven by the same 0–1 value. */
  .reader-rail {
    position: relative;
    flex-shrink: 0;
    height: 2px;
    overflow: hidden;
    background: var(--color-border);
  }
  .reader-rail-fill {
    height: 100%;
    background: var(--color-primary, #0066cc);
    transform-origin: left;
    will-change: transform;
  }
  .reader-header-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    width: 100%;
    padding: 0.625rem clamp(0.75rem, 1.5vw, 1.5rem);
  }
  .reader-actions-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }
  /* Centers in the space left between Back and the actions, so it can never slide
     under either group however long the title runs. */
  .reader-bar-title {
    display: flex;
    align-items: baseline;
    justify-content: center;
    gap: 0.5rem;
    flex: 1 1 auto;
    min-width: 0;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.25s ease;
  }
  .reader-bar-title.visible {
    opacity: 1;
  }
  .reader-bar-title-text {
    overflow: hidden;
    color: var(--color-text);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .reader-bar-title-source {
    flex-shrink: 0;
    max-width: 14ch;
    overflow: hidden;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--color-text-secondary);
    cursor: pointer;
    gap: 0.35rem;
    padding: 0.4rem 0.6rem;
  }
  .action-btn:hover,
  .action-btn.active {
    color: var(--color-text);
    background: var(--color-bg-secondary, #f5f5f5);
  }
  .action-label {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }
  .action-separator {
    width: 1px;
    height: 1rem;
    background: var(--color-border);
    opacity: 0.5;
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
    padding: 0 clamp(0.75rem, 1.5vw, 1.5rem) 0.625rem;
  }
  .style-sheet-label {
    color: var(--color-text-secondary);
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
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
  /* The toolbar is a floating pill in the header's style row; inside the sheet it
     is already on an opaque surface, so it drops the pill and lays out flat. */
  .style-sheet-content .toolbar-wrapper :global(.appearance-toolbar) {
    padding: 0;
    border-radius: 0;
    background: none;
    box-shadow: none;
    backdrop-filter: none;
    flex-wrap: wrap;
    gap: 0.375rem;
  }
  .style-sheet-content .toolbar-wrapper :global(.size-btn) {
    padding: 0.6rem;
  }
  .style-sheet-content .toolbar-wrapper :global(.size-value) {
    min-width: 1.75rem;
    font-size: var(--text-lg);
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
    .desktop-only {
      display: none !important;
    }
    /* The rail lives at the bottom here, so its understudy does too — above the
       home indicator, and only once the bar has slid away. */
    .reading-progress {
      top: auto;
      bottom: env(safe-area-inset-bottom, 0px);
    }
    .reading-progress.visible.bar-hidden {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .reading-progress,
    .reader-header,
    .reader-bar-title {
      transition: none;
    }
  }
</style>
