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
  import { preferences } from '$lib/stores/preferences.svelte';
  import type { Article, SocialDocument } from '$lib/types';
  import {
    extractSembleMetadata,
    extractMarginMetadata,
    type SembleMetadata,
    type MarginMetadata,
  } from '$lib/utils/displayItem';
  import { getDocumentEffectiveUrl } from '$lib/utils/linkPost';

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
      // Collapsing a long body removes a lot of height; if the card's top had
      // scrolled above the viewport, that vanished height would strand you far
      // down the feed. Re-anchor the now-collapsed card to the top so you land
      // back on what you were reading. Only when it had scrolled off the top —
      // a card still in view stays put.
      //
      // Measure BEFORE collapsing, then use scrollIntoView (not a relative
      // scrollBy) so the browser computes the final position atomically: on
      // mobile a relative scroll races the body shrink and the URL-bar resize
      // and can overshoot all the way to the page top. scroll-margin-top on the
      // wrapper keeps it clear of the (desktop) fixed header.
      const wasAboveViewport = (articleElements[index]?.getBoundingClientRect().top ?? 0) < 0;
      feedViewStore.collapse();
      await tick();
      if (wasAboveViewport) {
        articleElements[index]?.scrollIntoView({ block: 'start' });
      }
    } else {
      feedViewStore.select(index);
      feedViewStore.expand(index);
      // No scroll on expand: the body grows downward, so the card's top stays put.
      // (Keyboard nav still calls the exported scrollToCenter explicitly.)
    }
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
      feedViewStore.trackSeenThisSession({
        type: 'article',
        item: article,
        key: article.guid,
      });
      const sub = subscriptionsStore.subscriptions.find((s) => s.id === article.subscriptionId);
      itemLabelsStore.markAsRead(sub?.rkey || '', article.guid, article.url, article.title);
    }
  }

  function handleToggleDocumentRead(doc: SocialDocument) {
    if (itemLabelsStore.isSocialRead(doc.recordUri)) {
      itemLabelsStore.markSocialAsUnread(doc.recordUri);
    } else {
      // Track item to keep it visible in unread filter for this session
      feedViewStore.trackSeenThisSession({
        type: 'document',
        item: doc,
        key: doc.recordUri,
      });
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
    onSaveToSemble={onSaveToSemble ? handleReaderSemble : undefined}
    onSaveToMargin={onSaveToMargin ? handleReaderMargin : undefined}
  />
{/if}

<div class="article-list" class:hidden-behind-reader={readerItem !== null}>
  {#each feedViewStore.currentItems as displayItem, index (displayItem.key)}
    <div class="article-item-anchor" bind:this={articleElements[index]}>
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
        <ArticleCard
          document={doc}
          feedId={docSub?.id}
          isRead={itemLabelsStore.isSocialRead(doc.recordUri)}
          isSaved={itemLabelsStore.isSaved(doc.recordUri)}
          selected={preferences.expandAllItems || feedViewStore.selectedKey === displayItem.key}
          expanded={feedViewStore.expandedKey === displayItem.key}
          highlighted={feedViewStore.selectedKey === displayItem.key}
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

  /* When a collapse re-anchors a card to the top (see handleExpand), land it
     below the fixed feed header — mirrors .feed-page's padding-top so the card
     sits where the top of the list naturally would. */
  .article-item-anchor {
    scroll-margin-top: 3.5rem;
  }

  @media (max-width: 1000px) {
    .article-item-anchor {
      scroll-margin-top: 0.5rem;
    }
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
