<script lang="ts">
  import type { Article } from '$lib/types';
  import type { FeedDisplayItem } from '$lib/stores/feedView.svelte';
  import type { LaneId } from '$lib/components/articleCardView.types';
  import { auth } from '$lib/stores/auth.svelte';
  import { linkblogStore } from '$lib/stores/linkblog.svelte';
  import { linkPostContentStore } from '$lib/stores/linkPostContent.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { preferences } from '$lib/stores/preferences.svelte';
  import { useAtmosphere } from '$lib/hooks/useAtmosphere.svelte';
  import { getExternalArticleLink, formatQuoteSeed } from '$lib/utils/linkPost';
  import { normalizeDisplayItem } from '$lib/utils/displayItem';
  import AtmospherePanel from './AtmospherePanel.svelte';
  import ShareConfirmModal from './ShareConfirmModal.svelte';
  import Icon from '$lib/components/Icon.svelte';

  let {
    readerItem,
    onSaveToSemble,
    onSaveToMargin,
    panelId = 'reader-discussion-panel',
  }: {
    readerItem: FeedDisplayItem;
    onSaveToSemble?: () => void;
    onSaveToMargin?: () => void;
    panelId?: string;
  } = $props();

  let sub = $derived(
    readerItem.type === 'article'
      ? subscriptionsStore.subscriptions.find(
          (entry) => entry.id === readerItem.item.subscriptionId
        )
      : undefined
  );
  let normalized = $derived(normalizeDisplayItem(readerItem, sub));
  let itemUrl = $derived(normalized.url);
  let title = $derived(normalized.title);
  let publishedAt = $derived(normalized.publishedAt);
  let linkPostUrl = $derived(
    readerItem.type === 'document' ? getExternalArticleLink(readerItem.item) : undefined
  );

  $effect(() => {
    if (linkPostUrl) linkPostContentStore.fetch(linkPostUrl);
  });

  let linkPostArticle = $derived(
    linkPostUrl && readerItem.type === 'document'
      ? linkPostContentStore.get(linkPostUrl)
      : undefined
  );
  let sharedNow = $derived(linkblogStore.isShared(itemUrl));
  let currentShareNote = $derived(linkblogStore.getNote(itemUrl));
  let canShareLinkblog = $derived(Boolean(auth.user) && !preferences.linkblogDisabled);
  let shareHighlights = $derived(itemLabelsStore.getHighlights(readerItem.key));

  let shareTarget = $derived.by((): { article: Article; repostUri?: string } | null => {
    if (!itemUrl) return null;
    if (readerItem.type === 'article') return { article: readerItem.item };
    if (readerItem.type === 'saved') {
      const saved = readerItem.item;
      return {
        article: {
          subscriptionId: 0,
          guid: saved.url,
          url: saved.url,
          title: saved.title ?? saved.url,
          author: saved.author ?? undefined,
          summary: saved.description ?? undefined,
          imageUrl: saved.image ?? undefined,
          publishedAt: saved.publishedAt ?? saved.savedAt,
          fetchedAt: Date.now(),
        },
      };
    }

    const document = readerItem.item;
    const image = document.coverImageCid
      ? `https://cdn.bsky.app/img/feed_fullsize/plain/${document.authorDid}/${document.coverImageCid}@jpeg`
      : undefined;
    return {
      article: {
        subscriptionId: 0,
        guid: itemUrl,
        url: itemUrl,
        title: title || itemUrl,
        author: linkPostArticle?.author ?? undefined,
        summary: document.description ?? undefined,
        imageUrl: image,
        publishedAt,
        fetchedAt: Date.now(),
      },
      repostUri: document.recordUri,
    };
  });

  let seededQuote = $derived(formatQuoteSeed(shareTarget?.article.summary));

  async function performShare() {
    const target = shareTarget;
    if (!target) return;
    await linkblogStore.shareLink(target.article, seededQuote ?? '', target.repostUri);
  }

  // Sharing from the reader publishes exactly as publicly as sharing from a
  // card, so it takes the same first-share confirmation.
  let showShareConfirm = $state(false);

  function shareNow() {
    if (!preferences.linkblogShareConfirmed) {
      showShareConfirm = true;
      return;
    }
    void performShare();
  }

  function laneCanCreate(id: LaneId): boolean {
    if (id === 'linkblog') return false;
    if (id === 'semble') return Boolean(onSaveToSemble);
    if (id === 'margin') return Boolean(onSaveToMargin);
    return true;
  }

  const atmosphere = useAtmosphere({
    itemUrl: () => itemUrl,
    isShared: () => sharedNow,
    canCreate: laneCanCreate,
  });

  function createInLane(id: LaneId) {
    if (id === 'linkblog') {
      if (!sharedNow) shareNow();
    } else if (id === 'semble') {
      onSaveToSemble?.();
    } else if (id === 'margin') {
      onSaveToMargin?.();
    } else {
      window.open(
        `https://bsky.app/intent/compose?text=${encodeURIComponent(itemUrl)}`,
        '_blank',
        'noopener'
      );
    }
  }
</script>

<section class="reader-discussion" aria-label="Discussion">
  <div class="reader-discussion-divider"></div>
  {#if !sharedNow && canShareLinkblog}
    <button type="button" class="reader-share-cta" onclick={shareNow}>
      <Icon name="share" size={16} />
      <span>Share to your linkblog</span>
    </button>
  {/if}
  <AtmospherePanel
    laneRow={atmosphere.laneRow}
    expandedLane={atmosphere.expandedLane}
    expandedLaneItems={atmosphere.expandedLaneItems}
    currentlyShared={sharedNow}
    currentNote={currentShareNote}
    highlights={shareHighlights}
    lanesOpen={true}
    {panelId}
    onToggleLane={atmosphere.toggleLane}
    onCreateInLane={createInLane}
    onApplyComment={(note) => linkblogStore.setNote(itemUrl, note)}
    onOpenAuthor={(did) => sidebarStore.openAddFeedModalForDid(did)}
  >
    {#snippet leadExtra()}
      <button
        type="button"
        class="discussion-remove"
        onclick={() => void linkblogStore.unshare(itemUrl)}
      >
        <Icon name="trash" size={14} />
        <span>Remove from your linkblog</span>
      </button>
    {/snippet}
  </AtmospherePanel>
</section>

<ShareConfirmModal
  open={showShareConfirm}
  onconfirm={() => {
    showShareConfirm = false;
    void performShare();
  }}
  oncancel={() => (showShareConfirm = false)}
/>

<style>
  .reader-discussion {
    margin-top: 2.5rem;
  }

  .reader-discussion-divider {
    height: 1px;
    margin-bottom: 1.25rem;
    background: var(--color-border, #e8e8e8);
  }

  .reader-share-cta,
  .discussion-remove {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    border: 1px solid var(--color-border, #e0e0e0);
    background: none;
    color: var(--color-text);
    cursor: pointer;
  }

  .reader-share-cta {
    padding: 0.5rem 0.875rem;
    border-radius: 8px;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
  }

  .reader-share-cta:hover {
    border-color: var(--color-primary, #0066cc);
    color: var(--color-primary, #0066cc);
  }

  .reader-share-cta :global(.icon) {
    color: currentColor;
  }

  .discussion-remove {
    gap: 0.375rem;
    margin-top: 0.75rem;
    padding: 0.375rem 0.625rem;
    border-radius: 6px;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }

  .discussion-remove:hover {
    border-color: var(--color-error, #f44336);
    color: var(--color-error, #f44336);
  }

  @media (max-width: 1000px) {
    .reader-discussion:has(:global(textarea:focus)) {
      padding-bottom: calc(50vh + env(safe-area-inset-bottom, 0px));
    }
  }
</style>
