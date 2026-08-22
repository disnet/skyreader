<script lang="ts">
  import type { Article } from '$lib/types';
  import type { FeedDisplayItem } from '$lib/stores/feedView.svelte';
  import type { LaneId } from '$lib/components/articleCardView.types';
  import { auth } from '$lib/stores/auth.svelte';
  import { linkblogStore } from '$lib/stores/linkblog.svelte';
  import { linkPostContentStore } from '$lib/stores/linkPostContent.svelte';
  import { shareComposerStore } from '$lib/stores/shareComposer.svelte';
  import { shareDraftsStore } from '$lib/stores/shareDrafts.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { preferences } from '$lib/stores/preferences.svelte';
  import { useAtmosphere } from '$lib/hooks/useAtmosphere.svelte';
  import { getExternalArticleLink } from '$lib/utils/linkPost';
  import { shareTargetForDisplayItem } from '$lib/utils/shareTarget';
  import { normalizeDisplayItem } from '$lib/utils/displayItem';
  import AtmospherePanel from './AtmospherePanel.svelte';
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
  let hasShareDraft = $derived(itemUrl ? shareDraftsStore.hasDraft(itemUrl) : false);
  let hasShareNote = $derived(Boolean(currentShareNote?.trim()));

  let shareTarget = $derived.by((): { article: Article; repostUri?: string } | null =>
    shareTargetForDisplayItem(
      readerItem,
      { url: itemUrl, title, publishedAt },
      linkPostArticle?.author ?? undefined
    )
  );

  // Open the composer drawer (drafting; resumes any saved draft). The drawer
  // docks under the article so quotes can be gathered while it's open.
  function composeShare() {
    const target = shareTarget;
    if (!target) return;
    shareComposerStore.open({
      article: target.article,
      repostUri: target.repostUri,
      itemKey: readerItem.key,
      mode: 'create',
    });
  }

  // Reopen what you posted: the composer owns editing the note and taking the
  // share down (its Remove control), so this is the only affordance the reader
  // needs once shared.
  function editShare() {
    const target = shareTarget;
    if (!target) return;
    shareComposerStore.open({
      article: target.article,
      itemKey: readerItem.key,
      mode: 'edit',
      initialNote: currentShareNote ?? '',
    });
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
      if (!sharedNow) composeShare();
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
  <!-- One control for the linkblog, in both states: it says where the article
       stands and opens the composer on it. What you wrote isn't reprinted under
       the article you just read — it's a click away, in the place you edit it. -->
  {#if canShareLinkblog}
    <div class="reader-share-row">
      <button
        type="button"
        class="reader-share-cta"
        class:shared={sharedNow}
        onclick={sharedNow ? editShare : composeShare}
      >
        <Icon name="share" size={16} />
        <span>
          {#if sharedNow}
            {hasShareNote ? 'Shared with a note' : 'Shared without a note'}
          {:else if hasShareDraft}
            Resume your share draft
          {:else}
            Share to your linkblog
          {/if}
        </span>
      </button>
    </div>
  {/if}
  <AtmospherePanel
    laneRow={atmosphere.laneRow}
    expandedLane={atmosphere.expandedLane}
    expandedLaneItems={atmosphere.expandedLaneItems}
    lanesOpen={true}
    {panelId}
    onToggleLane={atmosphere.toggleLane}
    onCreateInLane={createInLane}
    onOpenAuthor={(did) => sidebarStore.openAddFeedModalForDid(did)}
  />
</section>

<style>
  .reader-discussion {
    margin-top: 2.5rem;
  }

  .reader-discussion-divider {
    height: 1px;
    margin-bottom: 1.25rem;
    background: var(--color-border, #e8e8e8);
  }

  .reader-share-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  .reader-share-cta {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.875rem;
    border: 1px solid var(--color-border, #e0e0e0);
    border-radius: 8px;
    background: none;
    color: var(--color-text);
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    cursor: pointer;
  }

  /* Already shared: the control reads as state, not an invitation — the border
     picks up the interaction blue and stays there. */
  .reader-share-cta.shared {
    border-color: var(--color-primary, #0066cc);
    color: var(--color-primary, #0066cc);
  }

  .reader-share-cta:hover {
    border-color: var(--color-primary, #0066cc);
    color: var(--color-primary, #0066cc);
  }

  .reader-share-cta :global(.icon) {
    color: currentColor;
  }
</style>
