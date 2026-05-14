<script lang="ts">
  import { tick } from 'svelte';
  import { pushState } from '$app/navigation';
  import { page } from '$app/state';
  import ArticleCard from '$lib/components/ArticleCard.svelte';
  import SavedReader from '$lib/components/feed/SavedReader.svelte';
  import InfiniteScrollSentinel from '$lib/components/common/InfiniteScrollSentinel.svelte';
  import { feedViewStore, type FeedDisplayItem } from '$lib/stores/feedView.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { sharesStore } from '$lib/stores/shares.svelte';
  import { preferences } from '$lib/stores/preferences.svelte';
  import type { Article, SocialDocument } from '$lib/types';
  import {
    extractSembleMetadata,
    extractMarginMetadata,
    type SembleMetadata,
    type MarginMetadata,
  } from '$lib/utils/displayItem';

  interface Props {
    onToggleSave: (article: Article) => void;
    onShare: (article: Article, sub: (typeof subscriptionsStore.subscriptions)[0]) => void;
    onUnshare: (guid: string) => void;
    onReaderChange?: (open: boolean) => void;
    onSaveToSemble?: (data: SembleMetadata) => void;
    onSaveToMargin?: (data: MarginMetadata) => void;
  }

  let { onToggleSave, onShare, onUnshare, onReaderChange, onSaveToSemble, onSaveToMargin }: Props =
    $props();

  // Reader overlay state — readerItem holds the data, page.state.readerOpen drives history
  let readerItem = $state<FeedDisplayItem | null>(null);
  let savedScrollY = 0;

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

  export function openSelectedReader() {
    const key = feedViewStore.selectedKey;
    if (key === null) return;
    const item = feedViewStore.currentItems.find((i) => i.key === key);
    if (item) {
      openReader(item);
    }
  }

  // Element refs for scroll observation
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

  async function handleExpand(index: number) {
    const key = feedViewStore.currentItems[index]?.key ?? null;
    if (key !== null && feedViewStore.expandedKey === key) {
      feedViewStore.collapse();
    } else {
      feedViewStore.select(index);
      feedViewStore.expand(index);
    }
    await tick();
    scrollToCenter(index);
  }

  function handleSelect(index: number) {
    const key = feedViewStore.currentItems[index]?.key ?? null;
    if (key !== null && feedViewStore.selectedKey === key) {
      feedViewStore.deselect();
    } else {
      feedViewStore.select(index);
    }
  }

  function handleToggleRead(article: Article) {
    if (itemLabelsStore.isRead(article.guid)) {
      itemLabelsStore.markAsUnread(article.guid);
    } else {
      // Track item to keep it visible in unread filter for this session
      feedViewStore.trackSeenThisSession({ type: 'article', item: article, key: article.guid });
      const sub = subscriptionsStore.subscriptions.find((s) => s.id === article.subscriptionId);
      itemLabelsStore.markAsRead(sub?.rkey || '', article.guid, article.url, article.title);
    }
  }

  function handleToggleDocumentRead(doc: SocialDocument) {
    if (itemLabelsStore.isSocialRead(doc.recordUri)) {
      itemLabelsStore.markSocialAsUnread(doc.recordUri);
    } else {
      // Track item to keep it visible in unread filter for this session
      feedViewStore.trackSeenThisSession({ type: 'document', item: doc, key: doc.recordUri });
      itemLabelsStore.markSocialAsRead(
        'document',
        doc.recordUri,
        doc.authorDid,
        doc.canonicalUrl || '',
        doc.title
      );
    }
  }

  function handleReaderSave() {
    if (!readerItem) return;
    if (readerItem.type === 'article' || readerItem.type === 'userShare') {
      const article = readerItem.type === 'article' ? readerItem.item : readerItem.article;
      onToggleSave(article);
    } else if (readerItem.type === 'share') {
      const share = readerItem.item;
      itemLabelsStore.toggleSave(share.recordUri, 'share', share.itemUrl, share.itemTitle, {
        type: 'share',
        recordUri: share.recordUri,
        itemUrl: share.itemUrl,
        itemTitle: share.itemTitle,
        itemAuthor: share.itemAuthor,
        itemDescription: share.itemDescription,
        itemImage: share.itemImage,
        itemPublishedAt: share.itemPublishedAt,
      });
    } else if (readerItem.type === 'document') {
      const doc = readerItem.item;
      itemLabelsStore.toggleSave(
        doc.recordUri,
        'document',
        doc.canonicalUrl || doc.path || '',
        doc.title,
        {
          type: 'document',
          recordUri: doc.recordUri,
          url: doc.canonicalUrl || doc.path || '',
          title: doc.title,
          description: doc.description,
          publishedAt: doc.publishedAt,
        }
      );
    }
  }

  function handleReaderShare() {
    if (!readerItem) return;
    if (readerItem.type === 'article') {
      const article = readerItem.item;
      const sub = subscriptionsStore.subscriptions.find((s) => s.id === article.subscriptionId);
      if (sub) onShare(article, sub);
    } else if (readerItem.type === 'userShare') {
      const article = readerItem.article;
      const sub = subscriptionsStore.subscriptions.find((s) => s.id === article.subscriptionId);
      if (sub) onShare(article, sub);
    }
  }

  export function getArticleElements(): HTMLElement[] {
    return articleElements;
  }

  function handleReaderSemble() {
    if (!readerItem || !onSaveToSemble) return;
    onSaveToSemble(extractSembleMetadata(readerItem));
  }

  function handleReaderMargin() {
    if (!readerItem || !onSaveToMargin) return;
    onSaveToMargin(extractMarginMetadata(readerItem));
  }

  export { scrollToCenter };
</script>

{#if readerItem}
  <SavedReader
    {readerItem}
    onClose={closeReader}
    onToggleSave={handleReaderSave}
    onShare={readerItem.type === 'article' || readerItem.type === 'userShare'
      ? handleReaderShare
      : undefined}
    onSaveToSemble={onSaveToSemble ? handleReaderSemble : undefined}
    onSaveToMargin={onSaveToMargin ? handleReaderMargin : undefined}
  />
{/if}

<div class="article-list" class:hidden-behind-reader={readerItem !== null}>
  {#each feedViewStore.currentItems as displayItem, index (displayItem.key)}
    <div bind:this={articleElements[index]}>
      {#if displayItem.type === 'article'}
        {@const article = displayItem.item}
        {@const sub = subscriptionsStore.subscriptions.find((s) => s.id === article.subscriptionId)}
        <ArticleCard
          {article}
          siteUrl={sub?.siteUrl || sub?.feedUrl}
          feedTitle={sub?.customTitle || sub?.title}
          feedId={sub?.id}
          isRead={itemLabelsStore.isRead(article.guid)}
          isSaved={itemLabelsStore.isSaved(article.guid)}
          isShared={sharesStore.isShared(article.guid)}
          shareNote={sharesStore.getShareNote(article.guid)}
          selected={preferences.expandAllItems || feedViewStore.selectedKey === displayItem.key}
          expanded={feedViewStore.expandedKey === displayItem.key}
          highlighted={feedViewStore.selectedKey === displayItem.key}
          onToggleSave={() => onToggleSave(article)}
          onToggleRead={() => handleToggleRead(article)}
          onShare={() => sub && onShare(article, sub)}
          onUnshare={() => onUnshare(article.guid)}
          onSelect={() => handleSelect(index)}
          onExpand={() => handleExpand(index)}
          onOpenFullscreen={() => openReader(displayItem)}
          onSaveToSemble={onSaveToSemble
            ? () => onSaveToSemble(extractSembleMetadata(displayItem))
            : undefined}
          onSaveToMargin={onSaveToMargin
            ? () => onSaveToMargin(extractMarginMetadata(displayItem))
            : undefined}
        />
      {:else if displayItem.type === 'share'}
        {@const share = displayItem.item}
        {@const localArticle = feedViewStore.getArticleForShare(share)}
        <ArticleCard
          {share}
          {localArticle}
          isRead={itemLabelsStore.isSocialRead(share.recordUri)}
          isSaved={itemLabelsStore.isSaved(share.recordUri)}
          selected={preferences.expandAllItems || feedViewStore.selectedKey === displayItem.key}
          expanded={feedViewStore.expandedKey === displayItem.key}
          highlighted={feedViewStore.selectedKey === displayItem.key}
          onToggleSave={() =>
            itemLabelsStore.toggleSave(share.recordUri, 'share', share.itemUrl, share.itemTitle, {
              type: 'share',
              recordUri: share.recordUri,
              itemUrl: share.itemUrl,
              itemTitle: share.itemTitle,
              itemAuthor: share.itemAuthor,
              itemDescription: share.itemDescription,
              itemImage: share.itemImage,
              itemPublishedAt: share.itemPublishedAt,
            })}
          onToggleRead={() => {
            if (itemLabelsStore.isSocialRead(share.recordUri)) {
              itemLabelsStore.markSocialAsUnread(share.recordUri);
            } else {
              feedViewStore.trackSeenThisSession({
                type: 'share',
                item: share,
                key: share.recordUri,
              });
              itemLabelsStore.markSocialAsRead(
                'share',
                share.recordUri,
                share.authorDid,
                share.itemUrl,
                share.itemTitle
              );
            }
          }}
          onSelect={() => handleSelect(index)}
          onExpand={() => handleExpand(index)}
          onOpenFullscreen={() => openReader(displayItem)}
          onSaveToSemble={onSaveToSemble
            ? () => onSaveToSemble(extractSembleMetadata(displayItem))
            : undefined}
          onSaveToMargin={onSaveToMargin
            ? () => onSaveToMargin(extractMarginMetadata(displayItem))
            : undefined}
        />
      {:else if displayItem.type === 'userShare'}
        {@const share = displayItem.item}
        {@const article = displayItem.article}
        {@const sub = subscriptionsStore.subscriptions.find((s) => s.id === article.subscriptionId)}
        <ArticleCard
          {article}
          siteUrl={sub?.siteUrl || sub?.feedUrl}
          feedTitle={sub?.customTitle || sub?.title}
          feedId={sub?.id}
          isRead={itemLabelsStore.isRead(article.guid)}
          isSaved={itemLabelsStore.isSaved(article.guid)}
          isShared={true}
          shareNote={share.note}
          reshareCount={share.reshareCount || 0}
          selected={preferences.expandAllItems || feedViewStore.selectedKey === displayItem.key}
          expanded={feedViewStore.expandedKey === displayItem.key}
          highlighted={feedViewStore.selectedKey === displayItem.key}
          onToggleSave={() => onToggleSave(article)}
          onToggleRead={() => handleToggleRead(article)}
          onUnshare={() => onUnshare(share.articleGuid)}
          onSelect={() => handleSelect(index)}
          onExpand={() => handleExpand(index)}
          onOpenFullscreen={() => openReader(displayItem)}
          onSaveToSemble={onSaveToSemble
            ? () => onSaveToSemble(extractSembleMetadata(displayItem))
            : undefined}
          onSaveToMargin={onSaveToMargin
            ? () => onSaveToMargin(extractMarginMetadata(displayItem))
            : undefined}
        />
      {:else if displayItem.type === 'document'}
        {@const doc = displayItem.item}
        <ArticleCard
          document={doc}
          isRead={itemLabelsStore.isSocialRead(doc.recordUri)}
          isSaved={itemLabelsStore.isSaved(doc.recordUri)}
          selected={preferences.expandAllItems || feedViewStore.selectedKey === displayItem.key}
          expanded={feedViewStore.expandedKey === displayItem.key}
          highlighted={feedViewStore.selectedKey === displayItem.key}
          onToggleSave={() =>
            itemLabelsStore.toggleSave(
              doc.recordUri,
              'document',
              doc.canonicalUrl || doc.path || '',
              doc.title,
              {
                type: 'document',
                recordUri: doc.recordUri,
                url: doc.canonicalUrl || doc.path || '',
                title: doc.title,
                description: doc.description,
                publishedAt: doc.publishedAt,
              }
            )}
          onToggleRead={() => handleToggleDocumentRead(doc)}
          onSelect={() => handleSelect(index)}
          onExpand={() => handleExpand(index)}
          onOpenFullscreen={() => openReader(displayItem)}
          onSaveToSemble={onSaveToSemble
            ? () => onSaveToSemble(extractSembleMetadata(displayItem))
            : undefined}
          onSaveToMargin={onSaveToMargin
            ? () => onSaveToMargin(extractMarginMetadata(displayItem))
            : undefined}
        />
      {/if}
    </div>
  {/each}

  <InfiniteScrollSentinel
    hasMore={feedViewStore.hasMore}
    isLoading={feedViewStore.isLoadingMore}
    onLoadMore={() => feedViewStore.loadMore()}
  />

  {#if preferences.scrollToMarkAsRead && !feedViewStore.hasMore && feedViewStore.currentItems.length > 0}
    <div class="scroll-mark-overscroll"></div>
  {/if}
</div>

<style>
  .article-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .hidden-behind-reader {
    visibility: hidden;
    position: fixed;
    pointer-events: none;
  }

  .scroll-mark-overscroll {
    height: 100vh;
    pointer-events: none;
  }
</style>
