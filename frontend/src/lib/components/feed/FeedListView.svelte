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
  import { linkblogStore } from '$lib/stores/linkblog.svelte';
  import { linkPostContentStore } from '$lib/stores/linkPostContent.svelte';
  import { preferences } from '$lib/stores/preferences.svelte';
  import type { Article, SocialDocument } from '$lib/types';
  import {
    extractSembleMetadata,
    extractMarginMetadata,
    type SembleMetadata,
    type MarginMetadata,
  } from '$lib/utils/displayItem';
  import { getDocumentEffectiveUrl, getExternalArticleLink } from '$lib/utils/linkPost';

  interface Props {
    onToggleSave: (article: Article) => void;
    onShare: (
      article: Article,
      sub: (typeof subscriptionsStore.subscriptions)[0],
      note?: string
    ) => void;
    onUnshare: (guid: string) => void;
    onReaderChange?: (open: boolean) => void;
    onSaveToSemble?: (data: SembleMetadata) => void;
    onSaveToMargin?: (data: MarginMetadata) => void;
  }

  let { onToggleSave, onShare, onUnshare, onReaderChange, onSaveToSemble, onSaveToMargin }: Props =
    $props();

  // Resolve the atproto.documents subscription a document belongs to, so its
  // publication label can link and filter like an RSS feed title. Mirrors the
  // author + publication scoping in feedView.svelte.ts's document filter.
  function findDocumentSubscription(doc: SocialDocument) {
    const subs = subscriptionsStore.subscriptions.filter(
      (s) => s.sourceType === 'atproto.documents' && s.subjectDid === doc.authorDid
    );
    if (subs.length === 0) return undefined;
    // Prefer a publication-scoped sub whose publication URI matches the doc's site
    const scoped = subs.find((s) => s.feedUrl?.startsWith('at://') && s.feedUrl === doc.siteUri);
    if (scoped) return scoped;
    // Next, a freestanding sub when the doc isn't tied to a publication
    const freestanding = subs.find(
      (s) => s.feedUrl === '__freestanding__' && (!doc.siteUri || !doc.siteUri.startsWith('at://'))
    );
    if (freestanding) return freestanding;
    // Fall back to any author-level sub
    return subs[0];
  }

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
    if (readerItem.type === 'article') {
      onToggleSave(readerItem.item);
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

  function handleReaderShare(note?: string) {
    if (!readerItem) return;
    if (readerItem.type === 'article') {
      const article = readerItem.item;
      const sub = subscriptionsStore.subscriptions.find((s) => s.id === article.subscriptionId);
      if (sub) onShare(article, sub, note);
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
    onShare={readerItem.type === 'article' ? handleReaderShare : undefined}
    useNoteComposer={true}
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
          isShared={linkblogStore.isShared(article.url)}
          shareNote={linkblogStore.getNote(article.url)}
          selected={preferences.expandAllItems || feedViewStore.selectedKey === displayItem.key}
          expanded={feedViewStore.expandedKey === displayItem.key}
          highlighted={feedViewStore.selectedKey === displayItem.key}
          onToggleSave={() => onToggleSave(article)}
          onToggleRead={() => handleToggleRead(article)}
          onShare={(note) => sub && onShare(article, sub, note)}
          onUnshare={() => onUnshare(article.url)}
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
        {@const docSub = findDocumentSubscription(doc)}
        {@const docUrl = getDocumentEffectiveUrl(doc)}
        {@const linkUrl = getExternalArticleLink(doc)}
        <ArticleCard
          document={doc}
          feedId={docSub?.id}
          isRead={itemLabelsStore.isSocialRead(doc.recordUri)}
          isSaved={itemLabelsStore.isSaved(doc.recordUri)}
          selected={preferences.expandAllItems || feedViewStore.selectedKey === displayItem.key}
          expanded={feedViewStore.expandedKey === displayItem.key}
          highlighted={feedViewStore.selectedKey === displayItem.key}
          isFetching={linkUrl ? linkPostContentStore.isFetching(linkUrl) : false}
          onFetchContent={linkUrl ? () => linkPostContentStore.fetch(linkUrl) : undefined}
          onToggleSave={() =>
            itemLabelsStore.toggleSave(doc.recordUri, 'document', docUrl, doc.title, {
              type: 'document',
              recordUri: doc.recordUri,
              url: docUrl,
              title: doc.title,
              description: doc.description,
              publishedAt: doc.publishedAt,
            })}
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
