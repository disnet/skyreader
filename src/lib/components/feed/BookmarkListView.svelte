<script lang="ts">
  import BookmarkCard from './BookmarkCard.svelte';
  import BookmarkReader from './BookmarkReader.svelte';
  import InfiniteScrollSentinel from '$lib/components/common/InfiniteScrollSentinel.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import { feedViewStore } from '$lib/stores/feedView.svelte';
  import { readingStore } from '$lib/stores/reading.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import type { Article } from '$lib/types';

  // Track whether we collapsed the sidebar for reader mode
  let sidebarWasCollapsed = $state(false);
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
    sidebarWasCollapsed = sidebarStore.isCollapsed;
    if (!sidebarStore.isCollapsed) {
      sidebarStore.toggle();
    }
    readerArticle = article;
  }

  function closeReader() {
    if (!sidebarWasCollapsed && sidebarStore.isCollapsed) {
      sidebarStore.toggle();
    }
    readerArticle = null;
  }

  function handleArchive(articleGuid: string) {
    readingStore.toggleArchive(articleGuid);
  }

  function handleRemoveBookmark(articleGuid: string) {
    readingStore.toggleStar(articleGuid);
    if (readerArticle?.guid === articleGuid) {
      closeReader();
    }
  }

  function handleSelect(index: number) {
    if (feedViewStore.selectedIndex === index) {
      feedViewStore.deselect();
    } else {
      feedViewStore.select(index);
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
    onRemoveBookmark={() => handleRemoveBookmark(readerArticle!.guid)}
  />
{:else}
  <div class="bookmark-list">
    {#each feedViewStore.currentItems as displayItem, index (displayItem.key)}
      {#if displayItem.type === 'article'}
        <div bind:this={articleElements[index]}>
          <BookmarkCard
            article={displayItem.item}
            selected={feedViewStore.selectedIndex === index}
            onOpen={() => {
              handleSelect(index);
              openReader(displayItem.item);
            }}
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
