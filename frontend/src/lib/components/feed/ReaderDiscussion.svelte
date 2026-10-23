<script lang="ts">
  import { untrack } from 'svelte';
  import type { Article, BlueskyProfile } from '$lib/types';
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
  import { blueskyComposerStore } from '$lib/stores/blueskyComposer.svelte';
  import {
    connectToPreviousRead,
    sembleConnectionStore,
  } from '$lib/stores/sembleConnection.svelte';
  import { recentReadsStore } from '$lib/stores/recentReads.svelte';
  import { savedConnectionsStore } from '$lib/stores/savedConnections.svelte';
  import { profileService } from '$lib/services/profiles';
  import { withLocalConnections } from '$lib/utils/localSembleConnections';
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
    eager = false,
  }: {
    readerItem: FeedDisplayItem;
    panelId?: string;
    /** The host shows one article at a time (the fullscreen reader), so having
        it open a few seconds is reason enough to start resolving the discussion.
        Off where many readers stack on one page (the daily magazine). */
    eager?: boolean;
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

  // What the reader has read, in order, so the next article's end can offer to
  // connect back to this one. The fullscreen reader (`eager`) shows one article,
  // so opening it is reading it; in the stacked magazine an article counts once
  // the reader reaches its end (see `loadWhenNear`).
  function noteRead() {
    const data = extractSembleMetadata(readerItem);
    recentReadsStore.record(data.url, data.title);
  }

  $effect(() => {
    if (eager && itemUrl) untrack(noteRead);
  });

  // A save with new Semble connections opens its discussion on Connections with
  // those marked, and they stay marked until the reader clears them there. Only
  // in the fullscreen reader (`eager`): the daily magazine stacks many readers
  // on one page, and scrolling past one isn't looking at it. Opening one
  // refreshes the list (at most once a minute), so news that came in while the
  // reader was elsewhere lands here too.
  let savedItem = $derived(eager && readerItem.type === 'saved' ? readerItem.item : null);
  $effect(() => {
    if (savedItem) void savedConnectionsStore.load();
  });
  let connectionsNewSince = $derived(
    savedItem ? savedConnectionsStore.newSince(savedItem.rkey, savedItem.savedAt) : null
  );

  // Semble's own index, which the panel reads through a cache, can be minutes
  // behind the badge; the edges Skyreader already holds fill the gap.
  let localConnections = $derived(savedItem ? savedConnectionsStore.newest(savedItem.rkey) : []);
  let curatorProfiles = $state<Map<string, BlueskyProfile>>(new Map());
  // Asked once each: a DID the appview doesn't know shouldn't be asked again.
  const askedCurators = new Set<string>();
  $effect(() => {
    const dids = [...new Set(localConnections.map((c) => c.curatorDid))];
    const missing = untrack(() =>
      dids.filter((did) => !askedCurators.has(did) && !curatorProfiles.has(did))
    );
    if (missing.length === 0) return;
    for (const did of missing) askedCurators.add(did);
    profileService
      .getProfiles(missing)
      .then((found) => {
        if (found.size === 0) return;
        const next = new Map(curatorProfiles);
        for (const [did, profile] of found) next.set(did, profile);
        curatorProfiles = next;
      })
      .catch(() => {
        // Names are adornment; the edge reads without them.
      });
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
    if (id === 'leaflet') return false;
    // Bluesky's compose intent needs no Skyreader session, but adding to the
    // discussion is an account action across the board — a guest reads every
    // lane and writes to none.
    return Boolean(auth.user);
  }

  const atmosphere = useAtmosphere({
    itemUrl: () => itemUrl,
    itemAtUri: () =>
      readerItem.type === 'document' && !linkPostUrl ? readerItem.item.recordUri : undefined,
    itemTitle: () => title,
    // A bridge posts the publication's name as often as the headline, so the
    // note cleaner needs both to recognize a bare relink.
    sourceTitle: () => sub?.title,
    isShared: () => sharedNow,
    canCreate: laneCanCreate,
  });
  let sembleContext = $derived(
    withLocalConnections(atmosphere.sembleContext, localConnections, curatorProfiles)
  );

  // The counts are one batched, proxy-cached lookup, so they start as soon as the
  // article opens: by the time the reader reaches the end, the section already
  // knows its shape.
  $effect(() => {
    if (eager) atmosphere.enterViewport();
  });

  // How long a reader has to stay on an article before the people resolve
  // without waiting for the section to come near. Long enough to skip a skim.
  const DWELL_MS = 3000;

  // Resolving who wrote about this costs a PDS fetch per record, and the section
  // sits below a whole article — so it waits until the reader is nearly there,
  // or (in the fullscreen reader) has stayed a few seconds. The margin alone
  // used to be the only trigger, and a fast scroll or a page turn outran it:
  // the section filled in while the reader was looking at it. In paged mode the
  // observer can't see a page that hasn't been turned to at all.
  function loadWhenNear(node: HTMLElement) {
    const dwell = eager ? setTimeout(() => atmosphere.openStream(), DWELL_MS) : undefined;
    if (typeof IntersectionObserver === 'undefined') {
      clearTimeout(dwell);
      atmosphere.openStream();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          if (!eager) noteRead();
          atmosphere.openStream();
          observer.disconnect();
        }
      },
      // Viewport-rooted, unlike the feed card's twin: the reader is a fixed,
      // full-viewport overlay that scrolls itself, so the viewport IS its
      // scroller's box. Rooting this on the app pane instead reports no
      // intersection at all and the stream never opens.
      { rootMargin: '600px 0px' }
    );
    observer.observe(node);
    return {
      destroy() {
        clearTimeout(dwell);
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

  // Only for the signed-in, like the connect control it sits beside.
  let connectSuggestion = $derived.by(() => {
    if (!auth.user || !itemUrl) return undefined;
    const data = extractSembleMetadata(readerItem);
    return connectToPreviousRead({
      url: data.url,
      title: data.title,
      cardUrl: atmosphere.sembleContext?.cardUrl ?? null,
    });
  });

  function createInLane(id: LaneId) {
    if (id === 'semble') {
      integrationSaveStore.openPicker('semble', extractSembleMetadata(readerItem));
    } else if (id === 'margin') {
      integrationSaveStore.openPicker('margin', extractMarginMetadata(readerItem));
    } else if (id === 'bluesky') {
      // Signed in, post from here; a guest has no account to post from, so
      // Bluesky's own composer takes the link.
      if (auth.user && itemUrl) {
        blueskyComposerStore.open({ source: shareTarget?.article ?? { url: itemUrl, title } });
      } else {
        window.open(
          `https://bsky.app/intent/compose?text=${encodeURIComponent(itemUrl)}`,
          '_blank',
          'noopener'
        );
      }
    }
  }
</script>

<!-- Everything here is keyed on the URL: an emailed newsletter with no web copy
     has nothing to discuss, share or save out, so the section stays away. -->
{#if itemUrl}
  <section class="reader-discussion" aria-label="Discussion" use:loadWhenNear>
    <AtmospherePanel
      laneRow={atmosphere.laneRow}
      filters={atmosphere.filters}
      activeFilter={atmosphere.activeFilter}
      stream={atmosphere.stream}
      {sembleContext}
      lanesOpen={true}
      {panelId}
      {itemUrl}
      onSelectFilter={atmosphere.setFilter}
      onRetry={atmosphere.retry}
      onCreateInLane={createInLane}
      onOpenAuthor={(did) => sidebarStore.openAddFeedModalForDid(did)}
      onSaveConnection={auth.user ? toggleSavedLink : undefined}
      onCreateConnection={auth.user && itemUrl ? createConnection : undefined}
      {connectSuggestion}
      isConnectionSaved={(url) => savesStore.isSaved(url)}
      {connectionsNewSince}
      newConnections={savedItem ? savedConnectionsStore.unseen(savedItem.rkey) : 0}
      onMarkConnectionsSeen={savedItem
        ? () => savedConnectionsStore.markSeen(savedItem.rkey)
        : undefined}
      viewerDid={auth.user?.did}
      composeLead={canShareLinkblog ? shareControl : undefined}
    />
  </section>
{/if}

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
