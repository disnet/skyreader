<script lang="ts">
  import BookmarkCard from './BookmarkCard.svelte';
  import BookmarkReader from './BookmarkReader.svelte';
  import InfiniteScrollSentinel from '$lib/components/common/InfiniteScrollSentinel.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import { feedViewStore, type FeedDisplayItem } from '$lib/stores/feedView.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import type { ItemLabelType } from '$lib/types';

  let readerItem = $state<FeedDisplayItem | null>(null);

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

  function openReader(item: FeedDisplayItem) {
    readerItem = item;
  }

  function closeReader() {
    readerItem = null;
  }

  function getItemType(item: FeedDisplayItem): ItemLabelType {
    if (item.type === 'userShare') return 'userShare';
    return item.type;
  }

  function handleArchive(item: FeedDisplayItem) {
    itemLabelsStore.toggleArchive(item.key, getItemType(item));
    if (readerItem?.key === item.key) {
      closeReader();
    }
  }

  function handleRemoveBookmark(item: FeedDisplayItem) {
    itemLabelsStore.toggleStar(item.key, getItemType(item));
    if (readerItem?.key === item.key) {
      closeReader();
    }
  }

  function handleSelect(index: number) {
    feedViewStore.select(index);
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
  <BookmarkReader {readerItem} onClose={closeReader} onArchive={() => handleArchive(readerItem!)} />
{:else}
  <div class="bookmark-list">
    {#each feedViewStore.currentItems as displayItem, index (displayItem.key)}
      <div bind:this={articleElements[index]}>
        <BookmarkCard
          {displayItem}
          selected={feedViewStore.selectedIndex === index}
          onOpen={() => openReader(displayItem)}
          onHover={() => handleSelect(index)}
          onArchive={() => handleArchive(displayItem)}
        />
      </div>
    {/each}

    {#if feedViewStore.currentItems.length === 0}
      {#if feedViewStore.bookmarksView === 'inbox'}
        <EmptyState
          title="No bookmarked items"
          description="Bookmark articles, shares, or documents to save them for later"
        />
      {:else}
        <EmptyState
          title="No archived bookmarks"
          description="Archived bookmarks will appear here"
        />
      {/if}
    {/if}

    <InfiniteScrollSentinel
      hasMore={feedViewStore.hasMore}
      isLoading={feedViewStore.isLoadingMore}
      onLoadMore={() => feedViewStore.loadMore()}
    />
  </div>
{/if}

<style>
  .bookmark-list {
    display: flex;
    flex-direction: column;
  }
</style>
