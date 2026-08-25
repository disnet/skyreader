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
  import { savesStore } from '$lib/stores/saves.svelte';
  import { integrationSaveStore } from '$lib/stores/integrationSave.svelte';
  import { sembleConnectionStore } from '$lib/stores/sembleConnection.svelte';
  import { preferences } from '$lib/stores/preferences.svelte';
  import { useAtmosphere } from '$lib/hooks/useAtmosphere.svelte';
  import { getExternalArticleLink } from '$lib/utils/linkPost';
  import { shareTargetForDisplayItem } from '$lib/utils/shareTarget';
  import {
    normalizeDisplayItem,
    extractSembleMetadata,
    extractMarginMetadata,
  } from '$lib/utils/displayItem';
  import { toggleSavedLink } from '$lib/utils/saveLink';
  import AtmospherePanel from './AtmospherePanel.svelte';
  import Icon from '$lib/components/Icon.svelte';

  let {
    readerItem,
    panelId = 'reader-discussion-panel',
  }: {
    readerItem: FeedDisplayItem;
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

  // Semble and Margin are offered wherever the reader is signed in: the picker
  // is global, so the affordance no longer depends on which page happens to host
  // this reader. Already having saved the article doesn't retire the control —
  // saving again is how you put it in another collection.
  function laneCanCreate(id: LaneId): boolean {
    if (id === 'linkblog') return false;
    if (id === 'semble' || id === 'margin') return Boolean(auth.user);
    return true;
  }

  const atmosphere = useAtmosphere({
    itemUrl: () => itemUrl,
    itemTitle: () => title,
    // A bridge posts the publication's name as often as the headline, so the
    // note cleaner needs both to recognize a bare relink.
    sourceTitle: () => sub?.title,
    isShared: () => sharedNow,
    canCreate: laneCanCreate,
  });

  // Resolving who wrote about this costs a PDS fetch per record, and the section
  // sits below a whole article — so it waits until the reader is nearly there.
  // The margin means the stream is usually resolved by the time it's on screen.
  function loadWhenNear(node: HTMLElement) {
    if (typeof IntersectionObserver === 'undefined') {
      atmosphere.openStream();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          atmosphere.openStream();
          observer.disconnect();
        }
      },
      { rootMargin: '600px 0px' }
    );
    observer.observe(node);
    return {
      destroy() {
        observer.disconnect();
      },
    };
  }

  // Gated exactly like the Semble save lane: signed in is the whole condition.
  // A session without the connection scope still gets the dialog — it says so up
  // front rather than hiding a capability the reader can have by logging in again.
  function createConnection() {
    const data = extractSembleMetadata(readerItem);
    sembleConnectionStore.openFor({
      url: data.url,
      title: data.title,
      // Semble keys cards by exact URL string, and the card page the panel
      // resolved carries the variant Semble actually holds.
      cardUrl: atmosphere.sembleContext?.cardUrl ?? null,
    });
  }

  function createInLane(id: LaneId) {
    if (id === 'semble') {
      integrationSaveStore.openPicker('semble', extractSembleMetadata(readerItem));
    } else if (id === 'margin') {
      integrationSaveStore.openPicker('margin', extractMarginMetadata(readerItem));
    } else if (id === 'bluesky') {
      window.open(
        `https://bsky.app/intent/compose?text=${encodeURIComponent(itemUrl)}`,
        '_blank',
        'noopener'
      );
    }
  }
</script>

<section class="reader-discussion" aria-label="Discussion" use:loadWhenNear>
  <div class="reader-discussion-divider"></div>
  <AtmospherePanel
    laneRow={atmosphere.laneRow}
    filters={atmosphere.filters}
    activeFilter={atmosphere.activeFilter}
    stream={atmosphere.stream}
    sembleContext={atmosphere.sembleContext}
    lanesOpen={true}
    {panelId}
    {itemUrl}
    onSelectFilter={atmosphere.setFilter}
    onRetry={atmosphere.retry}
    onCreateInLane={createInLane}
    onOpenAuthor={(did) => sidebarStore.openAddFeedModalForDid(did)}
    onSaveConnection={auth.user ? toggleSavedLink : undefined}
    onCreateConnection={auth.user && itemUrl ? createConnection : undefined}
    isConnectionSaved={(url) => savesStore.isSaved(url)}
    composeLead={canShareLinkblog ? shareControl : undefined}
  />
</section>

<!-- One control for the linkblog, in both states: it says where the article
     stands and opens the composer on it. It leads the "Add yours" row because
     this is the reader's own network — what you write here is your linkblog.
     What you wrote isn't reprinted under the article you just read: it's a
     click away, in the place you edit it. -->
{#snippet shareControl()}
  <button
    type="button"
    class="reader-share-cta"
    class:shared={sharedNow}
    onclick={sharedNow ? editShare : composeShare}
  >
    <Icon name="share" size={14} />
    <span>
      {#if sharedNow}
        {hasShareNote ? 'Shared with a note' : 'Shared without a note'}
      {:else if hasShareDraft}
        Resume draft
      {:else}
        Your linkblog
      {/if}
    </span>
  </button>
{/snippet}

<style>
  .reader-discussion {
    margin-top: 2.5rem;
  }

  .reader-discussion-divider {
    height: 1px;
    margin-bottom: 1.5rem;
    background: var(--color-border);
  }

  /* The linkblog's own control, in the compose row's vocabulary but carrying
     more weight than its neighbours — it is the one that writes to the reader's
     own publication. */
  .reader-share-cta {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.3125rem 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: none;
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    line-height: var(--leading-none);
    color: var(--color-text);
    cursor: pointer;
    transition:
      border-color 0.15s ease,
      color 0.15s ease;
  }

  /* Already shared: the control reads as state, not an invitation — the border
     picks up the interaction blue and stays there. */
  .reader-share-cta.shared {
    border-color: var(--color-primary);
    color: var(--color-primary);
  }

  .reader-share-cta:hover {
    border-color: var(--color-primary);
    color: var(--color-primary);
  }

  .reader-share-cta :global(.icon) {
    color: currentColor;
  }

  .reader-share-cta:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .reader-share-cta {
      transition: none;
    }
  }
</style>
