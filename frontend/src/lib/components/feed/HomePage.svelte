<script lang="ts">
  import { shellToolbar } from '$lib/actions/shell-toolbar';
  import { appScrollTo } from '$lib/utils/appScroll';
  // The Home view: the default landing surface. Not a feed — a fixed composition
  // of lanes drawn from the reader's saved pile (Continue reading / From your saved
  // / Recently saved, then one lane per saved channel), so opening the app offers
  // something to read rather than an undifferentiated river. Reuses the saved-list
  // reader stack so a tile opens the same in-app reader as everywhere else.
  import { onMount } from 'svelte';
  import NavigationDropdown from '$lib/components/NavigationDropdown.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import LibraryEmptyState from '$lib/components/LibraryEmptyState.svelte';
  import SavedReader from '$lib/components/feed/SavedReader.svelte';
  import MobileBottomBar from '$lib/components/feed/MobileBottomBar.svelte';
  import MobileFeedSwitcher from '$lib/components/feed/MobileFeedSwitcher.svelte';
  import BottomSheet from '$lib/components/common/BottomSheet.svelte';
  import NotificationList from '$lib/components/NotificationList.svelte';
  import HomeLane from '$lib/components/feed/HomeLane.svelte';
  import MagazineRail from '$lib/components/feed/MagazineRail.svelte';
  import HighlightReviewCard from '$lib/components/feed/HighlightReviewCard.svelte';
  import { goto } from '$app/navigation';
  import type { LaneCardVM } from '$lib/components/feed/homeLane';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { magazineStore } from '$lib/stores/magazine.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { filteredViewsStore } from '$lib/stores/filteredViews.svelte';
  import { viewTitleStore } from '$lib/stores/viewTitle.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { notificationsStore } from '$lib/stores/notifications.svelte';
  import { mobileStore } from '$lib/stores/mediaQuery.svelte';
  import { useReaderStack } from '$lib/hooks/useReaderStack.svelte';
  import { useScrollDirection } from '$lib/hooks/useScrollDirection.svelte';
  import { getFaviconUrl } from '$lib/utils/favicon';
  import { decodeEntities } from '$lib/utils/entities';
  import { savedItemLabelKeys } from '$lib/utils/dailyMagazine';
  import { preferences, type CardDensity, type DefaultView } from '$lib/stores/preferences.svelte';
  import {
    datePresetToMs,
    matchesReadingLength,
    type FeedDisplayItem,
  } from '$lib/stores/feedView.svelte';
  import type { FilteredView, SavedItem, SortOrder } from '$lib/types';

  // Quiet Home preferences strip (under the greeting). "Opens to" reuses the
  // global default-view preference (consumed by the `/` redirector); "Cards"
  // drives the lane-tile density variables set on .home-body below.
  const defaultViewOptions: { value: DefaultView; label: string }[] = [
    { value: 'home', label: 'Home' },
    { value: 'feeds', label: 'Feeds' },
    { value: 'saved', label: 'Saved' },
  ];
  const densityOptions: { value: CardDensity; label: string }[] = [
    { value: 'compact', label: 'Compact' },
    { value: 'cozy', label: 'Cozy' },
    { value: 'comfortable', label: 'Comfortable' },
  ];

  const CONTINUE_CAP = 12;
  const RANDOM_CAP = 12;
  const RECENT_CAP = 12;
  const CHANNEL_CAP = 12;
  const WORDS_PER_MIN = 200;

  // --- Browser-tab title ---
  $effect(() => {
    viewTitleStore.set('Home');
    return () => viewTitleStore.set('');
  });

  // --- Time-of-day masthead (client-only; computed once on mount) ---
  let greeting = $state('Welcome back');
  let dateLabel = $state('');
  onMount(() => {
    const now = new Date();
    const h = now.getHours();
    greeting =
      h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    dateLabel = now.toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });
  });

  // --- Helpers ---
  function keysFor(s: SavedItem): string[] {
    return savedItemLabelKeys(s);
  }

  function displayKey(s: SavedItem): string {
    return s.uri || s.itemGuid || s.rkey;
  }

  function hostnameOf(url: string): string | null {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  }

  // Fraction of the article actually scrolled through, or null if it was never
  // opened in the reader (a bare `read` label from marking-read in a feed list
  // carries no scroll progress).
  function readFraction(
    activity: { progress: { paragraphIndex: number; totalParagraphs: number } | null } | null
  ): number | null {
    const p = activity?.progress;
    if (p && p.totalParagraphs > 0) {
      return Math.min(1, (p.paragraphIndex + 1) / p.totalParagraphs);
    }
    return null;
  }

  function toVM(
    s: SavedItem,
    activity: { progress: { paragraphIndex: number; totalParagraphs: number } | null } | null
  ): LaneCardVM {
    const totalMin = s.wordCount ? Math.max(1, Math.round(s.wordCount / WORDS_PER_MIN)) : null;

    let progress: number | null = null;
    let metaLabel: string | null = totalMin ? `${totalMin} min read` : null;

    const fraction = readFraction(activity);
    if (fraction !== null) {
      progress = fraction;
      if (fraction < 0.98 && totalMin) {
        const left = Math.max(1, Math.round(totalMin * (1 - fraction)));
        metaLabel = `${left} min left`;
      }
    }

    const key = displayKey(s);
    return {
      key,
      displayItem: { type: 'saved', item: s, key },
      title: decodeEntities(s.title || '') || s.url,
      domain: s.domain || hostnameOf(s.url),
      image: s.image,
      faviconUrl: s.url ? getFaviconUrl(s.url) : '',
      metaLabel,
      progress,
    };
  }

  // --- Eligible saves (not archived) enriched with read activity ---
  interface Enriched {
    s: SavedItem;
    activity: ReturnType<typeof itemLabelsStore.getReadActivity>;
  }

  let enriched = $derived.by((): Enriched[] => {
    const out: Enriched[] = [];
    for (const s of savesStore.articles) {
      const keys = keysFor(s);
      if (keys.some((k) => itemLabelsStore.isArchived(k))) continue;
      out.push({ s, activity: itemLabelsStore.getReadActivity(keys) });
    }
    return out;
  });

  // The Home card reflects the user's durable current magazine (if any). Mint a
  // new one on demand and open it straight away; past issues stay reachable via
  // the rail below.
  async function generateMagazine() {
    const magazine = await magazineStore.generate();
    if (magazine) goto('/daily');
  }

  // Continue reading: only items actually started in the reader and not yet
  // finished — newest activity first. A bare `read` label (marked-read from a
  // feed list, never opened) has no scroll progress and doesn't qualify.
  let continueEnriched = $derived.by(() =>
    enriched
      .filter((e) => {
        const fraction = readFraction(e.activity);
        return fraction !== null && fraction < 0.98;
      })
      .sort((a, b) => (b.activity!.lastActivityAt ?? 0) - (a.activity!.lastActivityAt ?? 0))
      .slice(0, CONTINUE_CAP)
  );
  let continueSet = $derived(new Set(continueEnriched.map((e) => e.s.rkey)));
  let continueItems = $derived(continueEnriched.map((e) => toVM(e.s, e.activity)));

  // Recently saved: savesStore is newest-first already.
  let recentItems = $derived(enriched.slice(0, RECENT_CAP).map((e) => toVM(e.s, null)));

  // From your saved: a rotating random sample. Held in state so it only re-rolls on
  // demand (shuffle) or when first seeded — not on every reactive tick. Prefers
  // never-opened saves so the lane resurfaces things from the pile.
  let randomRkeys = $state<string[]>([]);
  let seededOnce = false;

  function shuffled<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function reshuffle() {
    const pool = enriched.filter((e) => !continueSet.has(e.s.rkey));
    const fresh = pool.filter((e) => !e.activity);
    const rest = pool.filter((e) => e.activity);
    randomRkeys = [...shuffled(fresh), ...shuffled(rest)].slice(0, RANDOM_CAP).map((e) => e.s.rkey);
  }

  // Seed once data arrives; re-seed if the pool was empty before (first load).
  $effect(() => {
    if (!seededOnce && enriched.length > 0) {
      seededOnce = true;
      reshuffle();
    }
  });

  let randomItems = $derived.by(() => {
    const byRkey = new Map(enriched.map((e) => [e.s.rkey, e]));
    return randomRkeys
      .map((rk) => byRkey.get(rk))
      .filter((e): e is Enriched => Boolean(e))
      .map((e) => toVM(e.s, null));
  });

  // Saved channels: one lane per saved-mode channel, its items filtered by the
  // channel's own rules (source / date / reading length / domain) — the same
  // fields the Saved view applies — then sorted by the channel's sort order.
  // Channels whose matches are all archived (or otherwise empty) are dropped so
  // Home doesn't show hollow lanes.
  let savedChannels = $derived(filteredViewsStore.views.filter((v) => v.mode === 'saved'));

  function matchesChannel(s: SavedItem, v: FilteredView): boolean {
    if (v.savedSourceFilter && v.savedSourceFilter.length > 0) {
      if (!v.savedSourceFilter.includes(s.source ?? 'url')) return false;
    }
    if (v.savedDateFilter) {
      if (new Date(s.savedAt).getTime() < datePresetToMs(v.savedDateFilter)) return false;
    }
    if (v.savedReadingLength && v.savedReadingLength.length > 0) {
      if (!v.savedReadingLength.some((b) => matchesReadingLength(s.wordCount, b))) return false;
    }
    if (v.savedDomainFilter && v.savedDomainFilter.length > 0) {
      const domain = (s.domain || hostnameOf(s.url) || '').toLowerCase();
      if (!domain || !v.savedDomainFilter.some((d) => d.toLowerCase() === domain)) return false;
    }
    return true;
  }

  function savedAtMs(s: SavedItem): number {
    return new Date(s.savedAt).getTime();
  }
  function publishedMs(s: SavedItem): number {
    return s.publishedAt ? new Date(s.publishedAt).getTime() : 0;
  }
  function domainOf(s: SavedItem): string {
    return (s.domain || hostnameOf(s.url) || '').toLowerCase();
  }

  function sortByOrder(items: Enriched[], order: SortOrder | undefined): Enriched[] {
    const arr = [...items];
    switch (order) {
      case 'oldest':
        return arr.sort((a, b) => savedAtMs(a.s) - savedAtMs(b.s));
      case 'longest':
        return arr.sort((a, b) => (b.s.wordCount ?? 0) - (a.s.wordCount ?? 0));
      case 'shortest':
        return arr.sort((a, b) => (a.s.wordCount ?? 0) - (b.s.wordCount ?? 0));
      case 'published-newest':
        return arr.sort((a, b) => publishedMs(b.s) - publishedMs(a.s));
      case 'published-oldest':
        return arr.sort((a, b) => publishedMs(a.s) - publishedMs(b.s));
      case 'domain-asc':
        return arr.sort((a, b) => domainOf(a.s).localeCompare(domainOf(b.s)));
      case 'domain-desc':
        return arr.sort((a, b) => domainOf(b.s).localeCompare(domainOf(a.s)));
      default:
        return arr.sort((a, b) => savedAtMs(b.s) - savedAtMs(a.s));
    }
  }

  interface ChannelLane {
    view: FilteredView;
    items: LaneCardVM[];
  }

  let channelLanes = $derived.by((): ChannelLane[] =>
    savedChannels
      .map((v) => {
        const matched = sortByOrder(
          enriched.filter((e) => matchesChannel(e.s, v)),
          v.sortOrder
        ).slice(0, CHANNEL_CAP);
        return { view: v, items: matched.map((e) => toVM(e.s, null)) };
      })
      .filter((lane) => lane.items.length > 0)
  );

  let isLoading = $derived(savesStore.loading && savesStore.articles.length === 0);
  let hasAnyLane = $derived(
    continueItems.length > 0 ||
      randomItems.length > 0 ||
      recentItems.length > 0 ||
      channelLanes.length > 0
  );

  // --- Reader stack (shared with the saved list) ---
  const reader = useReaderStack();
  let readerItem = $derived(reader.readerItem);

  function handleArchive(item: FeedDisplayItem) {
    itemLabelsStore.toggleArchive(item.key, item.type);
    if (item.type === 'saved' && item.item.itemGuid && item.item.itemGuid !== item.key) {
      itemLabelsStore.toggleArchive(item.item.itemGuid, 'saved');
    }
    if (readerItem?.key === item.key) reader.closeReader();
  }

  function handleRemove(item: FeedDisplayItem) {
    if (item.type === 'saved') savesStore.remove(item.item.rkey);
    if (readerItem?.key === item.key) reader.closeReader();
  }

  // Warm the saved item's body on hover so the click→reader open is instant
  // (every Home tile is a saved item; the body lives in IndexedDB, see savesStore).
  function handlePrefetch(vm: LaneCardVM) {
    if (vm.displayItem.type === 'saved') void savesStore.prefetchContent(vm.displayItem.item.rkey);
  }

  // --- Mobile chrome (mirrors the feed / highlights pages) ---
  const scrollDirection = useScrollDirection();
  let feedSwitcherOpen = $state(false);
  let notifSheetOpen = $state(false);

  function scrollToTop() {
    appScrollTo({ top: 0, behavior: 'smooth' });
  }

  function handleCreateChannel(type: 'feed' | 'saved' = 'feed') {
    feedSwitcherOpen = false;
    sidebarStore.openChannelModal(null, type);
  }

  function handleEditChannel(id: number) {
    feedSwitcherOpen = false;
    sidebarStore.openChannelModal(id);
  }
</script>

{#snippet homeControls()}
  <label class="control-group">
    <span class="control-label">Opens to</span>
    <select
      class="control-select"
      value={preferences.defaultView}
      onchange={(e) => preferences.setDefaultView(e.currentTarget.value as DefaultView)}
    >
      {#each defaultViewOptions as option}
        <option value={option.value}>{option.label}</option>
      {/each}
    </select>
  </label>

  <label class="control-group">
    <span class="control-label">Cards</span>
    <select
      class="control-select"
      value={preferences.cardDensity}
      onchange={(e) => preferences.setCardDensity(e.currentTarget.value as CardDensity)}
    >
      {#each densityOptions as option}
        <option value={option.value}>{option.label}</option>
      {/each}
    </select>
  </label>
{/snippet}

<div class="home-page">
  <header class="home-header" use:shellToolbar>
    <div class="header-inner">
      <NavigationDropdown currentTitle="Home" />
      <div class="home-controls">{@render homeControls()}</div>
    </div>
  </header>

  <div class="home-body" data-density={preferences.cardDensity}>
    <div class="masthead">
      <div class="masthead-text">
        {#if dateLabel}<p class="masthead-date">{dateLabel}</p>{/if}
        <h1 class="masthead-greeting">{greeting}</h1>
      </div>

      <!-- Below 1000px the toolbar strip is gone (mobile uses the bottom bar), so
           the same controls ride in the masthead there instead. -->
      <div class="home-controls masthead-controls">{@render homeControls()}</div>
    </div>

    {#if !isLoading}
      <HighlightReviewCard />
      <MagazineRail
        issues={magazineStore.magazines}
        generating={magazineStore.generating}
        onGenerate={generateMagazine}
        onOpen={(rkey) => goto(`/daily?id=${rkey}`)}
      />
    {/if}

    {#if isLoading}
      <HomeLane title="Continue reading" icon="clock" items={[]} loading onOpen={() => {}} />
      <HomeLane title="Random picks" icon="layers" items={[]} loading onOpen={() => {}} />
    {:else if !hasAnyLane}
      {#if subscriptionsStore.subscriptions.length === 0}
        <LibraryEmptyState
          onAddFeed={() => sidebarStore.openAddFeedModal()}
          onAddHandle={() => sidebarStore.openAddHandleModal()}
        />
      {:else}
        <EmptyState
          title="Nothing to read here yet"
          description="Save an article and it collects here: your recent reads, a few to pick back up, and a rotating handful from your pile."
          actionHref="/feeds"
          actionText="Browse your feeds"
          icon="📚"
        />
      {/if}
    {:else}
      {#if continueItems.length > 0}
        <HomeLane
          title="Continue reading"
          icon="clock"
          items={continueItems}
          onOpen={(vm) => reader.openReader(vm.displayItem)}
          onHover={handlePrefetch}
        />
      {/if}

      {#if randomItems.length > 0}
        <HomeLane
          title="Random picks"
          icon="layers"
          items={randomItems}
          action={{ kind: 'button', label: 'Shuffle', icon: 'refresh-cw', onClick: reshuffle }}
          onOpen={(vm) => reader.openReader(vm.displayItem)}
          onHover={handlePrefetch}
        />
      {/if}

      {#if recentItems.length > 0}
        <HomeLane
          title="Recently saved"
          icon="bookmark"
          items={recentItems}
          action={{ kind: 'link', label: 'View all', href: '/saved' }}
          onOpen={(vm) => reader.openReader(vm.displayItem)}
          onHover={handlePrefetch}
        />
      {/if}

      {#each channelLanes as lane (lane.view.uuid)}
        <HomeLane
          title={lane.view.name}
          icon="filter"
          items={lane.items}
          action={{ kind: 'link', label: 'View all', href: `/saved?view=${lane.view.uuid}` }}
          onOpen={(vm) => reader.openReader(vm.displayItem)}
          onHover={handlePrefetch}
        />
      {/each}
    {/if}
  </div>

  {#if mobileStore.isMobile && !readerItem}
    <MobileBottomBar
      controlsVisible={scrollDirection.controlsVisible}
      currentTitle="Home"
      onScrollToTop={scrollToTop}
      onOpenFeedSwitcher={() => (feedSwitcherOpen = true)}
      onOpenNotifications={() => {
        notifSheetOpen = true;
        void notificationsStore.load();
      }}
      onOpenFilterSheet={() => {}}
      hasActiveFilters={false}
      hideFilterButton={true}
    />

    <BottomSheet
      open={feedSwitcherOpen}
      onclose={() => (feedSwitcherOpen = false)}
      title="Switch Feed"
    >
      <MobileFeedSwitcher
        onclose={() => (feedSwitcherOpen = false)}
        currentTitle="Home"
        onEditChannel={handleEditChannel}
        onCreateChannel={handleCreateChannel}
      />
    </BottomSheet>

    <BottomSheet
      open={notifSheetOpen}
      onclose={() => {
        notifSheetOpen = false;
        void notificationsStore.markAllSeen();
      }}
      title="Notifications"
    >
      <NotificationList onItemClick={() => (notifSheetOpen = false)} />
    </BottomSheet>
  {/if}
</div>

{#if readerItem}
  <SavedReader
    {readerItem}
    onClose={reader.closeReader}
    onArchive={() => handleArchive(readerItem!)}
    onRemove={() => handleRemove(readerItem!)}
  />
{/if}

<style>
  .home-page {
    width: 100%;
  }

  /* Moved into the shell's toolbar strip (see FeedPageHeader for the rationale):
     it rides on the ground colour above the content card, which supplies the
     separation a divider used to. */
  .home-header {
    background: transparent;
  }

  @media (max-width: 1000px) {
    .home-header {
      display: none;
    }

    .home-page {
      padding-top: 0.5rem;
      padding-bottom: calc(var(--bottom-bar-height) + var(--safe-area-bottom) + 1rem);
    }
  }

  /* Full card width, title on the card's left edge and the preferences on its
     right — matching FeedPageHeader, so the bar reads as the card's own chrome
     and not as a floating column. Home's two preferences live here rather than
     in the masthead: the strip is already the width of the card, so it absorbs
     them for free, and the greeting is left to be a greeting. */
  .header-inner {
    min-height: var(--shell-bar-height);
    padding: 0.25rem var(--shell-bar-inset);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  /* Home is a browse surface, not a reading surface: the 800px band belongs to the
     feed body and the reader, where measure governs. Here the content unit is a
     horizontal lane, which is the one layout that turns width directly into value —
     more tiles seen, less scrolling. So Home fills the card instead of stranding a
     narrow column in it, capped only so the lanes stay a scannable sweep on very
     wide displays. */
  .home-body {
    max-width: 1440px;
    margin: 0 auto;
    padding: 0.5rem 0.75rem 2rem;
    /* Density tokens for the lane tiles (read by HomeLaneCard / HomeLane skeletons,
       which inherit them). Base = "cozy"; data-density overrides below. Kept here
       rather than on each card so the "Cards" control changes one attribute and the
       whole surface re-flows. */
    --lane-card-w: 16.5rem;
    --lane-card-w-m: 9.75rem;
    --lane-thumb: 3.25rem;
    --lane-thumb-h: 5.5rem;
    --lane-pad-x: 0.875rem;
    --lane-pad-t: 0.75rem;
    --lane-pad-b: 0.875rem;
    --lane-gap: 0.75rem;
  }

  /* Compact tiles are text-only squares (HomeLaneCard drops the thumbnail), so they
     need a small square footprint — several across the lane. Thumb vars go unused. */
  .home-body[data-density='compact'] {
    --lane-card-w: 9rem;
    --lane-card-w-m: 7.25rem;
    --lane-pad-x: 0.7rem;
    --lane-pad-t: 0.6rem;
    --lane-pad-b: 0.7rem;
    --lane-gap: 0;
  }

  .home-body[data-density='comfortable'] {
    --lane-card-w: 19.5rem;
    --lane-card-w-m: 11.5rem;
    --lane-thumb: 4rem;
    --lane-thumb-h: 6.5rem;
    --lane-pad-x: 1.05rem;
    --lane-pad-t: 1rem;
    --lane-pad-b: 1.05rem;
    --lane-gap: 0.95rem;
  }

  /* Just the greeting on the framed layout — the preferences moved up to the
     toolbar strip, which spans the card and so doesn't strand them a full card's
     width from the text they used to share a row with. The hairline under the
     masthead separates it from the lanes. Below 1000px there is no strip, so the
     controls come back into this row (see .masthead-controls). */
  .masthead {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: 0.5rem 1.5rem;
    padding: 1rem 0.25rem 0.875rem;
    margin-bottom: 0.875rem;
    border-bottom: 1px solid var(--color-border);
  }

  /* Two-class selector so it outranks the `.home-controls` display below,
     whichever order they end up in. */
  .home-controls.masthead-controls {
    display: none;
  }

  @media (max-width: 1000px) {
    .home-controls.masthead-controls {
      display: flex;
      /* Sit level with the greeting's text rather than its descenders when the
         row bottom-aligns the two. */
      padding-bottom: 0.15rem;
    }
  }

  .masthead-text {
    flex-shrink: 0;
  }

  .masthead-date {
    margin: 0 0 0.15rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .masthead-greeting {
    margin: 0;
    font-size: var(--text-2xl);
    font-weight: var(--weight-semibold);
    line-height: var(--leading-tight);
    letter-spacing: var(--tracking-tight);
    color: var(--color-text);
  }

  /* Quiet preferences strip. Two compact <select>s styled to match the daily-magazine
     dropdowns that share this screen (MagazineRail's `.control` / `.control select`),
     so the toolbar and the magazine rail read as one control vocabulary. */
  .home-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem 1.25rem;
    flex-shrink: 0;
    min-width: 0;
  }

  .control-group {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    cursor: pointer;
  }

  .control-select {
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    cursor: pointer;
  }

  .control-select:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }
</style>
