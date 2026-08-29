<script lang="ts">
  import { appScrollBy, appViewportRect } from '$lib/utils/appScroll';
  import SavedCard from './SavedCard.svelte';
  import SavedReader from './SavedReader.svelte';
  import InfiniteScrollSentinel from '$lib/components/common/InfiniteScrollSentinel.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import { feedViewStore, type FeedDisplayItem } from '$lib/stores/feedView.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { savedSearchStore } from '$lib/stores/savedSearch.svelte';
  import { useReaderStack } from '$lib/hooks/useReaderStack.svelte';
  import type { ItemLabelType } from '$lib/types';

  interface Props {
    onReaderChange?: (open: boolean) => void;
  }

  let { onReaderChange }: Props = $props();

  // Shared reader stack (same as the feed): curated Collection pieces open in-app
  // on top of the edition, with Back returning to it.
  const reader = useReaderStack({ onReaderChange: (open) => onReaderChange?.(open) });
  let readerItem = $derived(reader.readerItem);
  const openReader = reader.openReader;
  const closeReader = reader.closeReader;

  // Element refs for scroll management
  let articleElements = $state<HTMLElement[]>([]);

  function scrollToCenter(index?: number) {
    const targetIndex = index ?? feedViewStore.selectedIndex;
    const el = articleElements[targetIndex];
    if (!el) return;

    // A quarter of the way down the *scroll viewport*, which on desktop is the
    // framed content card — inset from the window by the toolbar strip.
    const rect = el.getBoundingClientRect();
    const viewport = appViewportRect();
    const offset = rect.top - (viewport.top + viewport.height / 4);

    appScrollBy({ top: offset, behavior: 'instant' });
  }

  // When a URL is added, open its reader as soon as the new item lands in the
  // list (savesStore signals which key to open after the save + navigation).
  $effect(() => {
    const key = savesStore.pendingOpenKey;
    if (!key) return;
    const item = feedViewStore.currentItems.find((i) => i.key === key);
    if (item) {
      savesStore.pendingOpenKey = null;
      if (readerItem?.key !== key) openReader(item);
    }
  });

  // Cross-view search hint: matches sitting in the tab the user isn't looking at.
  let otherViewCount = $derived(feedViewStore.savedSearchOtherViewCount);
  let otherViewLabel = $derived(feedViewStore.savedView === 'inbox' ? 'Archive' : 'Inbox');

  function getItemType(item: FeedDisplayItem): ItemLabelType {
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
    }
    if (readerItem?.key === item.key) {
      closeReader();
    }
  }

  function handleSelect(index: number) {
    feedViewStore.select(index);
  }

  export function openSelectedReader() {
    reader.openSelectedReader();
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
    onRemove={() => handleRemoveBookmark(readerItem!)}
  />
{/if}

<div class="bookmark-list" class:hidden-behind-reader={readerItem !== null}>
  {#each feedViewStore.currentItems as displayItem, index (displayItem.key)}
    <div bind:this={articleElements[index]}>
      <SavedCard
        {displayItem}
        selected={feedViewStore.selectedKey === displayItem.key}
        onOpen={() => openReader(displayItem)}
        onHover={() => handleSelect(index)}
        onArchive={() => handleArchive(displayItem)}
        onRemove={() => handleRemoveBookmark(displayItem)}
      />
    </div>
  {/each}

  {#if feedViewStore.currentItems.length === 0}
    {#if savedSearchStore.active}
      <!-- Search is scoped to the current sub-view like every other filter, so
           point at the other one when that's where the match actually is. -->
      <EmptyState
        title={`No matches for “${savedSearchStore.appliedQuery}”`}
        description={otherViewCount > 0
          ? `Nothing here matches. ${otherViewLabel} has ${otherViewCount} match${otherViewCount === 1 ? '' : 'es'}.`
          : 'Try fewer or different words.'}
        actionText={otherViewCount > 0
          ? `${otherViewCount} match${otherViewCount === 1 ? '' : 'es'} in ${otherViewLabel}`
          : undefined}
        onAction={otherViewCount > 0
          ? () =>
              feedViewStore.setSavedView(feedViewStore.savedView === 'inbox' ? 'archive' : 'inbox')
          : undefined}
      />
    {:else if feedViewStore.savedView === 'inbox'}
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
</style>
