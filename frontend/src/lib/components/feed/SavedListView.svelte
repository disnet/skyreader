<script lang="ts">
  import { pushState } from '$app/navigation';
  import { page } from '$app/state';
  import SavedCard from './SavedCard.svelte';
  import SavedReader from './SavedReader.svelte';
  import InfiniteScrollSentinel from '$lib/components/common/InfiniteScrollSentinel.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import { feedViewStore, type FeedDisplayItem } from '$lib/stores/feedView.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { sharesStore } from '$lib/stores/shares.svelte';
  import type { ItemLabelType } from '$lib/types';
  import {
    extractSembleMetadata,
    extractMarginMetadata,
    type SembleMetadata,
    type MarginMetadata,
  } from '$lib/utils/displayItem';

  interface Props {
    onReaderChange?: (open: boolean) => void;
    onSaveToSemble?: (data: SembleMetadata) => void;
    onSaveToMargin?: (data: MarginMetadata) => void;
  }

  let { onReaderChange, onSaveToSemble, onSaveToMargin }: Props = $props();

  let readerItem = $state<FeedDisplayItem | null>(null);
  let savedScrollY = 0;

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

  // Close reader when back button is pressed (page.state.readerOpen becomes falsy)
  $effect(() => {
    if (!page.state.readerOpen && readerItem) {
      readerItem = null;
      onReaderChange?.(false);
      requestAnimationFrame(() => {
        window.scrollTo(0, savedScrollY);
      });
    }
  });

  function openReader(item: FeedDisplayItem) {
    savedScrollY = window.scrollY;
    readerItem = item;
    pushState('', { readerOpen: true });
    onReaderChange?.(true);
  }

  function closeReader() {
    readerItem = null;
    onReaderChange?.(false);
    history.back();
    requestAnimationFrame(() => {
      window.scrollTo(0, savedScrollY);
    });
  }

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

  function isValidShareUrl(url: string | null | undefined): url is string {
    if (!url) return false;
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }

  function getDocumentShareUrl(item: FeedDisplayItem): string | null {
    if (item.type !== 'document') return null;
    if (isValidShareUrl(item.item.canonicalUrl)) return item.item.canonicalUrl;
    if (isValidShareUrl(item.item.path)) return item.item.path;
    return null;
  }

  function canShareItem(item: FeedDisplayItem): boolean {
    if (item.type === 'article') return isValidShareUrl(item.item.url);
    if (item.type === 'userShare') return isValidShareUrl(item.article.url);
    if (item.type === 'share') return isValidShareUrl(item.item.itemUrl);
    if (item.type === 'document') return getDocumentShareUrl(item) !== null;

    // Saved fallback rows for shares/documents do not include the original author DID,
    // so sharing them as plain links would lose reshare attribution and use the wrong key.
    if (item.item.source === 'share' || item.item.source === 'document') return false;
    if (item.item.contentType === 'share' || item.item.contentType === 'document') return false;
    return isValidShareUrl(item.item.url);
  }

  function getSharedKey(item: FeedDisplayItem): string | null {
    if (!canShareItem(item)) return null;
    if (item.type === 'article') return item.item.guid;
    if (item.type === 'userShare') return item.article.guid;
    if (item.type === 'share') return item.item.itemGuid || item.item.itemUrl;
    if (item.type === 'document') return item.item.recordUri;
    return item.item.itemGuid || item.item.url;
  }

  function isItemShared(item: FeedDisplayItem): boolean {
    const key = getSharedKey(item);
    return key ? sharesStore.isShared(key) : false;
  }

  async function handleShareItem(item: FeedDisplayItem) {
    const sharedKey = getSharedKey(item);
    if (!sharedKey) return;

    if (sharesStore.isShared(sharedKey)) {
      await sharesStore.unshare(sharedKey);
      return;
    }

    if (item.type === 'article') {
      const article = item.item;
      const sub = subscriptionsStore.subscriptions.find((s) => s.id === article.subscriptionId);
      await sharesStore.share(
        sub?.rkey || '',
        sub?.feedUrl || '',
        article.guid,
        article.url,
        article.title,
        article.author,
        article.content,
        article.summary,
        article.imageUrl,
        article.publishedAt
      );
    } else if (item.type === 'userShare') {
      const article = item.article;
      const sub = subscriptionsStore.subscriptions.find((s) => s.id === article.subscriptionId);
      await sharesStore.share(
        sub?.rkey || '',
        sub?.feedUrl || '',
        article.guid,
        article.url,
        article.title,
        article.author,
        article.content,
        article.summary,
        article.imageUrl,
        article.publishedAt
      );
    } else if (item.type === 'share') {
      const share = item.item;
      await sharesStore.reshare(
        share.recordUri,
        share.authorDid,
        share.itemUrl,
        share.itemGuid,
        share.itemTitle,
        share.itemAuthor,
        share.itemDescription,
        share.content,
        share.itemImage,
        share.itemPublishedAt,
        share.feedUrl
      );
    } else if (item.type === 'document') {
      const doc = item.item;
      const url = getDocumentShareUrl(item);
      if (!url) return;
      await sharesStore.reshare(
        doc.recordUri,
        doc.authorDid,
        url,
        doc.recordUri,
        doc.title,
        undefined,
        doc.description,
        doc.textContent,
        undefined,
        doc.publishedAt,
        doc.siteUri
      );
    } else {
      const saved = item.item;
      await sharesStore.share(
        '',
        '',
        saved.itemGuid || saved.url,
        saved.url,
        saved.title || undefined,
        saved.author || undefined,
        saved.content || undefined,
        saved.description || undefined,
        saved.image || undefined,
        saved.publishedAt || undefined
      );
    }
  }

  export function openSelectedReader() {
    const key = feedViewStore.selectedKey;
    if (key === null) return;
    const item = feedViewStore.currentItems.find((i) => i.key === key);
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
    onShare={canShareItem(readerItem) ? () => handleShareItem(readerItem!) : undefined}
    isShared={isItemShared(readerItem)}
    onSaveToSemble={onSaveToSemble
      ? () => onSaveToSemble(extractSembleMetadata(readerItem!))
      : undefined}
    onSaveToMargin={onSaveToMargin
      ? () => onSaveToMargin(extractMarginMetadata(readerItem!))
      : undefined}
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
        onShare={canShareItem(displayItem) ? () => handleShareItem(displayItem) : undefined}
        isShared={isItemShared(displayItem)}
        onSaveToSemble={onSaveToSemble
          ? () => onSaveToSemble(extractSembleMetadata(displayItem))
          : undefined}
        onSaveToMargin={onSaveToMargin
          ? () => onSaveToMargin(extractMarginMetadata(displayItem))
          : undefined}
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
</style>
