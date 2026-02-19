<script lang="ts">
  import BookmarkCard from './BookmarkCard.svelte';
  import BookmarkReader from './BookmarkReader.svelte';
  import InfiniteScrollSentinel from '$lib/components/common/InfiniteScrollSentinel.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import { feedViewStore } from '$lib/stores/feedView.svelte';
  import { readingStore } from '$lib/stores/reading.svelte';
  import type { Article } from '$lib/types';

  let readerArticle = $state<Article | null>(null);

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

  function openReader(article: Article) {
    readerArticle = article;
  }

  function closeReader() {
    readerArticle = null;
  }

  function handleArchive(articleGuid: string) {
    readingStore.toggleArchive(articleGuid);
    if (readerArticle?.guid === articleGuid) {
      closeReader();
    }
  }

  function handleRemoveBookmark(articleGuid: string) {
    readingStore.toggleStar(articleGuid);
    if (readerArticle?.guid === articleGuid) {
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
    if (item?.type === 'article') {
      openReader(item.item);
    }
  }

  export function getArticleElements(): HTMLElement[] {
    return articleElements;
  }

  export { scrollToCenter };
</script>

{#if readerArticle}
  <BookmarkReader
    article={readerArticle}
    onClose={closeReader}
    onArchive={() => handleArchive(readerArticle!.guid)}
  />
{:else}
  <div class="bookmark-list">
    {#each feedViewStore.currentItems as displayItem, index (displayItem.key)}
      {#if displayItem.type === 'article'}
        <div bind:this={articleElements[index]}>
          <BookmarkCard
            article={displayItem.item}
            selected={feedViewStore.selectedIndex === index}
            onOpen={() => openReader(displayItem.item)}
            onHover={() => handleSelect(index)}
            onArchive={() => handleArchive(displayItem.item.guid)}
          />
        </div>
      {/if}
    {/each}

    {#if feedViewStore.currentItems.length === 0}
      {#if feedViewStore.bookmarksView === 'inbox'}
        <EmptyState
          title="No bookmarked articles"
          description="Bookmark articles to save them for later"
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
