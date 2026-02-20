<script lang="ts">
  import { tick } from 'svelte';
  import ArticleCard from '$lib/components/ArticleCard.svelte';
  import InfiniteScrollSentinel from '$lib/components/common/InfiniteScrollSentinel.svelte';
  import { feedViewStore } from '$lib/stores/feedView.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { sharesStore } from '$lib/stores/shares.svelte';
  import { preferences } from '$lib/stores/preferences.svelte';
  import type { Article, SocialDocument } from '$lib/types';

  interface Props {
    onToggleSave: (article: Article) => void;
    onShare: (article: Article, sub: (typeof subscriptionsStore.subscriptions)[0]) => void;
    onUnshare: (guid: string) => void;
  }

  let { onToggleSave, onShare, onUnshare }: Props = $props();

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
    if (feedViewStore.expandedIndex === index) {
      feedViewStore.collapse();
    } else {
      feedViewStore.select(index);
      feedViewStore.expand(index);
    }
    await tick();
    scrollToCenter(index);
  }

  function handleSelect(index: number) {
    if (feedViewStore.selectedIndex === index) {
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

  export function getArticleElements(): HTMLElement[] {
    return articleElements;
  }

  export { scrollToCenter };
</script>

<div class="article-list">
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
          selected={preferences.expandAllItems || feedViewStore.selectedIndex === index}
          expanded={feedViewStore.expandedIndex === index}
          highlighted={feedViewStore.selectedIndex === index}
          onToggleSave={() => onToggleSave(article)}
          onToggleRead={() => handleToggleRead(article)}
          onShare={() => sub && onShare(article, sub)}
          onUnshare={() => onUnshare(article.guid)}
          onSelect={() => handleSelect(index)}
          onExpand={() => handleExpand(index)}
        />
      {:else if displayItem.type === 'share'}
        {@const share = displayItem.item}
        {@const localArticle = feedViewStore.getArticleForShare(share)}
        <ArticleCard
          {share}
          {localArticle}
          isRead={itemLabelsStore.isSocialRead(share.recordUri)}
          isSaved={itemLabelsStore.isSaved(share.recordUri)}
          selected={preferences.expandAllItems || feedViewStore.selectedIndex === index}
          expanded={feedViewStore.expandedIndex === index}
          highlighted={feedViewStore.selectedIndex === index}
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
          selected={preferences.expandAllItems || feedViewStore.selectedIndex === index}
          expanded={feedViewStore.expandedIndex === index}
          highlighted={feedViewStore.selectedIndex === index}
          onToggleSave={() => onToggleSave(article)}
          onToggleRead={() => handleToggleRead(article)}
          onUnshare={() => onUnshare(share.articleGuid)}
          onSelect={() => handleSelect(index)}
          onExpand={() => handleExpand(index)}
        />
      {:else if displayItem.type === 'document'}
        {@const doc = displayItem.item}
        <ArticleCard
          document={doc}
          isRead={itemLabelsStore.isSocialRead(doc.recordUri)}
          isSaved={itemLabelsStore.isSaved(doc.recordUri)}
          selected={preferences.expandAllItems || feedViewStore.selectedIndex === index}
          expanded={feedViewStore.expandedIndex === index}
          highlighted={feedViewStore.selectedIndex === index}
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
        />
      {/if}
    </div>
  {/each}

  <InfiniteScrollSentinel
    hasMore={feedViewStore.hasMore}
    isLoading={feedViewStore.isLoadingMore}
    onLoadMore={() => feedViewStore.loadMore()}
  />
</div>

<style>
  .article-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
</style>
