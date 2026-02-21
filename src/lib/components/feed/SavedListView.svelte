<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import SavedCard from './SavedCard.svelte';
  import SavedReader from './SavedReader.svelte';
  import InfiniteScrollSentinel from '$lib/components/common/InfiniteScrollSentinel.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { feedViewStore, type FeedDisplayItem } from '$lib/stores/feedView.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { ScopeUpgradeError } from '$lib/services/api';
  import type { ItemLabelType } from '$lib/types';

  interface Props {
    initialReaderKey?: string | null;
  }

  let { initialReaderKey = null }: Props = $props();

  let showScopeUpgrade = $state(false);

  let readerItem = $state<FeedDisplayItem | null>(null);
  // Track whether we pushed a history entry so closeReader knows whether to go back
  let pushedHistoryEntry = false;
  let savedScrollY = 0;
  let showUrlInput = $state(false);
  let urlInputValue = $state('');
  let urlInputEl = $state<HTMLInputElement | null>(null);
  let saveError = $state<string | null>(null);

  // Element refs for scroll management
  let articleElements = $state<HTMLElement[]>([]);

  function scrollToCenter(index?: number) {
    const targetIndex = index ?? feedViewStore.selectedIndex;
    const el = articleElements[targetIndex];
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const targetY = window.innerHeight / 4;
    const offset = rect.top - targetY;

    window.scrollBy({ top: offset, behavior: 'instant' });
  }

  function setReaderUrlParam(itemKey: string | null) {
    const url = new URL(window.location.href);
    if (itemKey) {
      url.searchParams.set('reader', itemKey);
    } else {
      url.searchParams.delete('reader');
    }
    return url.toString();
  }

  function openReader(item: FeedDisplayItem) {
    savedScrollY = window.scrollY;
    readerItem = item;
    const url = setReaderUrlParam(item.key);
    history.pushState({ ...history.state, readerItemKey: item.key }, '', url);
    pushedHistoryEntry = true;
  }

  function closeReader() {
    if (!readerItem) return;
    readerItem = null;
    requestAnimationFrame(() => {
      window.scrollTo(0, savedScrollY);
    });
    if (pushedHistoryEntry) {
      pushedHistoryEntry = false;
      history.back();
    }
  }

  function handlePopstate() {
    const readerKey = new URL(window.location.href).searchParams.get('reader');
    if (!readerKey && readerItem) {
      pushedHistoryEntry = false;
      readerItem = null;
      requestAnimationFrame(() => {
        window.scrollTo(0, savedScrollY);
      });
    } else if (readerKey && !readerItem) {
      const item = feedViewStore.currentItems.find((i) => i.key === readerKey);
      if (item) {
        readerItem = item;
        pushedHistoryEntry = true;
      }
    }
  }

  onMount(() => {
    window.addEventListener('popstate', handlePopstate);
  });

  onDestroy(() => {
    window.removeEventListener('popstate', handlePopstate);
  });

  // Restore reader from URL on initial load
  $effect(() => {
    if (initialReaderKey && !readerItem && feedViewStore.currentItems.length > 0) {
      const item = feedViewStore.currentItems.find((i) => i.key === initialReaderKey);
      if (item) {
        readerItem = item;
        const url = setReaderUrlParam(item.key);
        history.replaceState({ ...history.state, readerItemKey: item.key }, '', url);
        pushedHistoryEntry = true;
      }
    }
  });

  function getItemType(item: FeedDisplayItem): ItemLabelType {
    if (item.type === 'userShare') return 'userShare';
    return item.type;
  }

  function handleArchive(item: FeedDisplayItem) {
    itemLabelsStore.toggleArchive(item.key, getItemType(item));
    // For saved items where itemGuid differs from key, also toggle archive by itemGuid
    // to ensure consistent archive state regardless of which key is used for lookup
    if (item.type === 'saved' && item.item.itemGuid && item.item.itemGuid !== item.key) {
      itemLabelsStore.toggleArchive(item.item.itemGuid, 'saved');
    }
    if (readerItem?.key === item.key) {
      closeReader();
    }
  }

  function handleRemoveBookmark(item: FeedDisplayItem) {
    if (item.type === 'article') {
      itemLabelsStore.toggleSave(item.key, 'article', item.item.url, item.item.title, {
        type: 'article',
        guid: item.item.guid,
        url: item.item.url,
        title: item.item.title,
        author: item.item.author,
        summary: item.item.summary,
        imageUrl: item.item.imageUrl,
        publishedAt: item.item.publishedAt,
      });
    } else if (item.type === 'saved') {
      savesStore.remove(item.item.rkey);
    } else if (item.type === 'share') {
      itemLabelsStore.toggleSave(item.key, 'share', item.item.itemUrl, item.item.itemTitle, {
        type: 'share',
        recordUri: item.item.recordUri,
        itemUrl: item.item.itemUrl,
        itemTitle: item.item.itemTitle,
        itemAuthor: item.item.itemAuthor,
        itemDescription: item.item.itemDescription,
        itemImage: item.item.itemImage,
        itemPublishedAt: item.item.itemPublishedAt,
      });
    } else if (item.type === 'document') {
      itemLabelsStore.toggleSave(
        item.key,
        'document',
        item.item.canonicalUrl || item.item.path || '',
        item.item.title,
        {
          type: 'document',
          recordUri: item.item.recordUri,
          url: item.item.canonicalUrl || item.item.path || '',
          title: item.item.title,
          description: item.item.description,
          publishedAt: item.item.publishedAt,
        }
      );
    } else {
      // userShare — unsave by guid
      savesStore.unsaveByGuid(item.key);
    }
    if (readerItem?.key === item.key) {
      closeReader();
    }
  }

  function handleSelect(index: number) {
    feedViewStore.select(index);
  }

  export function toggleUrlInput() {
    showUrlInput = !showUrlInput;
    if (showUrlInput) {
      saveError = null;
      urlInputValue = '';
      // Focus the input after it renders
      requestAnimationFrame(() => urlInputEl?.focus());
    }
  }

  async function handleSaveUrl() {
    const url = urlInputValue.trim();
    if (!url) return;

    try {
      new URL(url);
    } catch {
      saveError = 'Please enter a valid URL';
      return;
    }

    saveError = null;
    try {
      await savesStore.saveFromUrl(url);
      urlInputValue = '';
      showUrlInput = false;
    } catch (err) {
      if (err instanceof ScopeUpgradeError) {
        showScopeUpgrade = true;
        showUrlInput = false;
      } else {
        saveError = err instanceof Error ? err.message : 'Failed to save article';
      }
    }
  }

  function handleUrlKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveUrl();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      showUrlInput = false;
    }
  }

  export function openSelectedReader() {
    const index = feedViewStore.selectedIndex;
    if (index < 0) return;
    const item = feedViewStore.currentItems[index];
    if (item) {
      openReader(item);
    }
  }

  export function getArticleElements(): HTMLElement[] {
    return articleElements;
  }

  export { scrollToCenter };
</script>

{#if readerItem}
  <SavedReader
    {readerItem}
    onClose={closeReader}
    onArchive={() => handleArchive(readerItem!)}
    onRemove={() => {
      handleRemoveBookmark(readerItem!);
      closeReader();
    }}
  />
{/if}

<div class="bookmark-list" class:hidden-behind-reader={readerItem !== null}>
  {#if showScopeUpgrade}
    <div class="scope-upgrade-banner">
      <p>Saving articles requires updated permissions. Please log in again to grant access.</p>
      <div class="scope-upgrade-actions">
        <a href="/auth/login" class="scope-upgrade-btn">Log in again</a>
        <button class="scope-upgrade-dismiss" onclick={() => (showScopeUpgrade = false)}
          >Dismiss</button
        >
      </div>
    </div>
  {/if}
  {#if showUrlInput}
    <div class="url-input-bar">
      <div class="url-input-wrapper">
        <input
          bind:this={urlInputEl}
          bind:value={urlInputValue}
          type="url"
          placeholder="Paste article URL..."
          class="url-input"
          onkeydown={handleUrlKeydown}
          disabled={savesStore.saving}
        />
        <button
          class="url-save-btn"
          onclick={handleSaveUrl}
          disabled={savesStore.saving || !urlInputValue.trim()}
        >
          {#if savesStore.saving}
            Saving...
          {:else}
            Save
          {/if}
        </button>
        <button
          class="url-cancel-btn"
          onclick={() => (showUrlInput = false)}
          disabled={savesStore.saving}
        >
          <Icon name="x" size={16} />
        </button>
      </div>
      {#if saveError}
        <p class="url-error">{saveError}</p>
      {/if}
    </div>
  {/if}

  {#each feedViewStore.currentItems as displayItem, index (displayItem.key)}
    <div bind:this={articleElements[index]}>
      <SavedCard
        {displayItem}
        selected={feedViewStore.selectedIndex === index}
        onOpen={() => openReader(displayItem)}
        onHover={() => handleSelect(index)}
        onArchive={() => handleArchive(displayItem)}
        onRemove={() => handleRemoveBookmark(displayItem)}
      />
    </div>
  {/each}

  {#if feedViewStore.currentItems.length === 0}
    {#if feedViewStore.savedView === 'inbox'}
      <EmptyState
        title="No saved items"
        description="Save articles, shares, or documents to save them for later"
      />
    {:else}
      <EmptyState title="No archived items" description="Archived items will appear here" />
    {/if}
  {/if}

  <InfiniteScrollSentinel
    hasMore={feedViewStore.hasMore}
    isLoading={feedViewStore.isLoadingMore}
    onLoadMore={() => feedViewStore.loadMore()}
  />
</div>

<style>
  .bookmark-list {
    display: flex;
    flex-direction: column;
  }

  .hidden-behind-reader {
    visibility: hidden;
    position: fixed;
    pointer-events: none;
  }

  .url-input-bar {
    padding: 0.5rem 1rem;
  }

  .url-input-wrapper {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .url-input {
    flex: 1;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-border, #ddd);
    border-radius: 6px;
    font-size: 0.875rem;
    background: var(--color-bg, #fff);
    color: var(--color-text);
    outline: none;
  }

  .url-input:focus {
    border-color: var(--color-primary, #2563eb);
    box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.1);
  }

  .url-input:disabled {
    opacity: 0.6;
  }

  .url-save-btn {
    padding: 0.5rem 1rem;
    background: var(--color-primary, #2563eb);
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
  }

  .url-save-btn:hover:not(:disabled) {
    opacity: 0.9;
  }

  .url-save-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .url-cancel-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.375rem;
    background: none;
    border: none;
    color: var(--color-text-secondary);
    cursor: pointer;
    border-radius: 4px;
  }

  .url-cancel-btn:hover {
    background: rgba(0, 0, 0, 0.05);
  }

  .url-error {
    margin: 0.375rem 0 0;
    font-size: 0.75rem;
    color: var(--color-error, #dc2626);
  }

  .scope-upgrade-banner {
    margin: 0.5rem 1rem;
    padding: 0.75rem 1rem;
    background: rgba(234, 179, 8, 0.08);
    border: 1px solid rgba(234, 179, 8, 0.3);
    border-radius: 8px;
    font-size: 0.8125rem;
    color: var(--color-text);
  }

  .scope-upgrade-banner p {
    margin: 0 0 0.5rem;
  }

  .scope-upgrade-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .scope-upgrade-btn {
    padding: 0.375rem 0.75rem;
    background: var(--color-primary, #2563eb);
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 0.8125rem;
    font-weight: 500;
    text-decoration: none;
    cursor: pointer;
  }

  .scope-upgrade-btn:hover {
    opacity: 0.9;
  }

  .scope-upgrade-dismiss {
    padding: 0.375rem 0.75rem;
    background: none;
    border: 1px solid var(--color-border, #ddd);
    border-radius: 6px;
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .scope-upgrade-dismiss:hover {
    background: rgba(0, 0, 0, 0.03);
  }
</style>
