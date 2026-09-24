<script lang="ts">
  import { shellToolbar } from '$lib/actions/shell-toolbar';
  import { appScrollTo } from '$lib/utils/appScroll';
  // The Home view: the default landing surface. Not a feed — a composition of
  // lanes drawn from the reader's saved pile (Continue reading / From your saved
  // / Recently saved, then one lane per room and saved channel), so opening the
  // app offers something to read rather than an undifferentiated river. The
  // reader can hide and reorder sections (Customize; see utils/homeLayout.ts).
  // Reuses the saved-list reader stack so a tile opens the same in-app reader as
  // everywhere else.
  import { onMount } from 'svelte';
  import NavigationDropdown from '$lib/components/NavigationDropdown.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import LibraryEmptyState from '$lib/components/LibraryEmptyState.svelte';
  import SavedReader from '$lib/components/feed/SavedReader.svelte';
  import MobileBottomBar from '$lib/components/feed/MobileBottomBar.svelte';
  import MobileFeedSwitcher from '$lib/components/feed/MobileFeedSwitcher.svelte';
  import { perfBegin, PERF_SHEET_OPEN } from '$lib/utils/perfMarks';
  import BottomSheet from '$lib/components/common/BottomSheet.svelte';
  import NotificationList from '$lib/components/NotificationList.svelte';
  import HomeLane from '$lib/components/feed/HomeLane.svelte';
  import MagazineRail from '$lib/components/feed/MagazineRail.svelte';
  import HighlightReviewCard from '$lib/components/feed/HighlightReviewCard.svelte';
  import GuestModeBanner from '$lib/components/feed/GuestModeBanner.svelte';
  import HomeCustomizeDialog from '$lib/components/feed/HomeCustomizeDialog.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import {
    channelSectionId,
    EMPTY_HOME_LAYOUT,
    HOME_SECTION,
    mergeHomeOrder,
    orderHomeSections,
    pruneHomeLayout,
    roomSectionId,
    type HomeLayout,
    type HomeSectionOption,
  } from '$lib/utils/homeLayout';
  import { goto } from '$app/navigation';
  import type { LaneCardVM } from '$lib/components/feed/homeLane';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { roomsStore } from '$lib/stores/rooms.svelte';
  import { followLinksStore } from '$lib/stores/followLinks.svelte';
  import {
    followLinkReadKey,
    followLinkTitle,
    openFollowLink,
    sharedByShort,
  } from '$lib/utils/followLinks';
  import { FOLLOWING_PATH } from '$lib/utils/followsChannel';
  import { extractRoomArticle, sortRoomItems } from '$lib/utils/roomArticle';
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
  import {
    compareSavedNewestFirst,
    isSavedItemArchived,
    savedAtMs,
    savedItemLabelKeys,
  } from '$lib/utils/savedPile';
  import { preferences } from '$lib/stores/preferences.svelte';
  import {
    datePresetToMs,
    isSavedRowArchived,
    matchesReadingLength,
    setSavedRowArchived,
    type FeedDisplayItem,
  } from '$lib/stores/feedView.svelte';
  import type { FilteredView, RoomItem, SavedItem, SortOrder } from '$lib/types';

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
      if (isSavedItemArchived(s, itemLabelsStore.isArchived)) continue;
      out.push({ s, activity: itemLabelsStore.getReadActivity(keysFor(s)) });
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

  // Recently saved: the same rule the Saved list's default sort applies —
  // newest by savedAt, not whatever order the store's last load left behind
  // (the cache path reads an rkey index, and rkeys minted on another device or
  // by a backed collection don't line up with save time). Sorted here as well
  // as in the store so "View all" lands on a list that opens with these tiles.
  let recentItems = $derived(
    [...enriched]
      .sort((a, b) => compareSavedNewestFirst(a.s, b.s))
      .slice(0, RECENT_CAP)
      .map((e) => toVM(e.s, null))
  );

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
        return arr.sort((a, b) => compareSavedNewestFirst(a.s, b.s));
    }
  }

  interface ChannelLane {
    id: string;
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
        return {
          id: channelSectionId(v.uuid),
          view: v,
          items: matched.map((e) => toVM(e.s, null)),
        };
      })
      .filter((lane) => lane.items.length > 0)
  );

  // Reading rooms you've joined: one lane per room, its articles as tiles,
  // served from roomsStore's session cache so a repeat Home mount refetches
  // nothing. Account-only — the store no-ops for a guest.
  onMount(() => void roomsStore.load());

  function roomReadLabel(item: RoomItem): string | null {
    // The tile's check marker already says "you read this"; the label carries
    // the others.
    if (item.readByMe) {
      return item.readCount > 1 ? `${item.readCount - 1} more read this` : null;
    }
    if (item.readCount === 1) return '1 read this';
    if (item.readCount > 1) return `${item.readCount} read this`;
    return null;
  }

  let roomLanes = $derived.by(() =>
    roomsStore.rooms
      .map((room) => ({
        id: roomSectionId(room.subject),
        subject: room.subject,
        title: room.name ?? 'Untitled room',
        byKey: new Map(room.items.map((i) => [i.urlNormalized, i])),
        // The room page's own order: unread first, oldest addition first.
        items: sortRoomItems(room.items)
          .slice(0, CHANNEL_CAP)
          .map((item): LaneCardVM => ({
            key: item.urlNormalized,
            title: decodeEntities(item.title || '') || item.url,
            domain: hostnameOf(item.url),
            image: item.image ?? null,
            faviconUrl: getFaviconUrl(item.url),
            metaLabel: roomReadLabel(item),
            progress: null,
            read: item.readByMe,
          })),
      }))
      .filter((lane) => lane.items.length > 0)
  );

  // Open a room article in the reader without saving it (shared extract path
  // with RoomPage — see utils/roomArticle.ts).
  let openingRoomUrl = $state<string | null>(null);
  async function openRoomArticle(subject: string, item: RoomItem) {
    if (openingRoomUrl) return;
    openingRoomUrl = item.url;
    try {
      const saved = await extractRoomArticle(item);
      if (!saved) {
        window.open(item.url, '_blank', 'noopener');
        return;
      }
      reader.openReader({ type: 'saved', item: saved, key: item.url });
    } finally {
      openingRoomUrl = null;
    }
  }

  // The room item behind the open reader, when it was opened from a room lane
  // (those readers key on the article URL). Drives the reader's Mark as read.
  const openRoomRef = $derived.by(() => {
    const key = reader.readerItem?.key;
    if (!key) return null;
    for (const room of roomsStore.rooms) {
      const item = room.items.find((i) => i.url === key);
      if (item) return { subject: room.subject, item };
    }
    return null;
  });

  // From your follows: the week's most-shared links from your Bluesky follows,
  // as one lane (the server ranks them). Hidden until the reader has granted the
  // timeline permission (the ask lives on Manage Sources and the follows
  // channel, not here) and there is something to show. The store no-ops for a
  // guest. See docs/plans/FOLLOWS_LINKS_PLAN.md.
  onMount(() => void followLinksStore.load());

  const FOLLOW_LANE_CAP = 8;
  let followLinkByKey = $derived(
    new Map(followLinksStore.links.map((l) => [followLinkReadKey(l), l]))
  );
  let followItems = $derived.by((): LaneCardVM[] =>
    followLinksStore.scopeRequired
      ? []
      : followLinksStore.links.slice(0, FOLLOW_LANE_CAP).map((l) => ({
          key: followLinkReadKey(l),
          title: followLinkTitle(l),
          domain: l.site,
          image: l.thumb,
          faviconUrl: getFaviconUrl(l.url),
          metaLabel: sharedByShort(l.sharers),
          progress: null,
          read: itemLabelsStore.isRead(followLinkReadKey(l)),
        }))
  );

  let isLoading = $derived(savesStore.loading && savesStore.articles.length === 0);
  let hasAnyLane = $derived(
    continueItems.length > 0 ||
      randomItems.length > 0 ||
      recentItems.length > 0 ||
      channelLanes.length > 0 ||
      roomLanes.length > 0 ||
      followItems.length > 0
  );

  // --- Layout: which sections show, and in what order ---
  // Every section Home can show right now, in its built-in order. Rooms and
  // channels are listed even while empty (their lanes still hide then), so the
  // reader can place one before it has anything in it.
  let builtInSections = $derived.by((): HomeSectionOption[] => [
    { id: HOME_SECTION.highlights, label: 'Revisit your highlights', icon: 'highlighter' },
    { id: HOME_SECTION.magazine, label: 'Daily magazine', icon: 'newspaper' },
    { id: HOME_SECTION.continue, label: 'Continue reading', icon: 'clock' },
    ...(auth.isAuthenticated
      ? [
          {
            id: HOME_SECTION.follows,
            label: 'Shared by people you follow',
            icon: 'share-2' as const,
          },
        ]
      : []),
    { id: HOME_SECTION.random, label: 'Random picks', icon: 'layers' },
    { id: HOME_SECTION.recent, label: 'Recently saved', icon: 'bookmark' },
    ...roomsStore.rooms.map((room): HomeSectionOption => ({
      id: roomSectionId(room.subject),
      label: room.name ?? 'Untitled room',
      icon: 'book-open',
      kind: 'Room',
    })),
    ...savedChannels.map((v): HomeSectionOption => ({
      id: channelSectionId(v.uuid),
      label: v.name,
      icon: 'filter',
      kind: 'Channel',
    })),
  ]);

  let sections = $derived.by(() => {
    const byId = new Map(builtInSections.map((o) => [o.id, o]));
    return orderHomeSections(
      builtInSections.map((o) => o.id),
      preferences.homeLayout.order
    ).map((id) => byId.get(id)!);
  });
  let hiddenSections = $derived(new Set(preferences.homeLayout.hidden));
  let visibleSectionIds = $derived(
    sections.map((o) => o.id).filter((id) => !hiddenSections.has(id))
  );

  let roomLaneById = $derived(new Map(roomLanes.map((lane) => [lane.id, lane])));
  let channelLaneById = $derived(new Map(channelLanes.map((lane) => [lane.id, lane])));

  function laneHasItems(id: string): boolean {
    switch (id) {
      case HOME_SECTION.continue:
        return continueItems.length > 0;
      case HOME_SECTION.follows:
        return followItems.length > 0;
      case HOME_SECTION.random:
        return randomItems.length > 0;
      case HOME_SECTION.recent:
        return recentItems.length > 0;
      default:
        return roomLaneById.has(id) || channelLaneById.has(id);
    }
  }
  // There is something to read, but the reader has hidden every lane holding it.
  let allLanesHidden = $derived(hasAnyLane && !visibleSectionIds.some(laneHasItems));

  let customizeOpen = $state(false);

  // Every layout write also forgets deleted channels (see pruneHomeLayout).
  // Against all channels, not just saved ones: one switched to river mode and
  // back keeps its place.
  function saveLayout(layout: HomeLayout) {
    preferences.setHomeLayout(
      pruneHomeLayout(layout, new Set(filteredViewsStore.views.map((v) => v.uuid)))
    );
  }

  function reorderSections(order: string[]) {
    saveLayout({
      order: mergeHomeOrder(preferences.homeLayout.order, order),
      hidden: preferences.homeLayout.hidden,
    });
  }

  function toggleSection(id: string) {
    const hidden = preferences.homeLayout.hidden;
    saveLayout({
      order: preferences.homeLayout.order,
      hidden: hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id],
    });
  }

  // --- Reader stack (shared with the saved list) ---
  const reader = useReaderStack();
  let readerItem = $derived(reader.readerItem);

  function handleArchive(item: FeedDisplayItem) {
    void setSavedRowArchived(item, !isSavedRowArchived(item));
    if (readerItem?.key === item.key) reader.closeReader();
  }

  function handleRemove(item: FeedDisplayItem) {
    if (item.type === 'saved') savesStore.remove(item.item.rkey);
    if (readerItem?.key === item.key) reader.closeReader();
  }

  function openLaneItem(vm: LaneCardVM) {
    if (vm.displayItem) reader.openReader(vm.displayItem);
  }

  // Warm the saved item's body on hover so the click→reader open is instant
  // (every Home tile is a saved item; the body lives in IndexedDB, see savesStore).
  function handlePrefetch(vm: LaneCardVM) {
    if (vm.displayItem?.type === 'saved') void savesStore.prefetchContent(vm.displayItem.item.rkey);
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

{#snippet customizeButton()}
  <button type="button" class="customize-button" onclick={() => (customizeOpen = true)}>
    <Icon name="sliders" size={14} />
    Customize
  </button>
{/snippet}

{#snippet homeSection(id: string)}
  {#if id === HOME_SECTION.highlights}
    <HighlightReviewCard />
  {:else if id === HOME_SECTION.magazine}
    <MagazineRail
      issues={magazineStore.magazines}
      generating={magazineStore.generating}
      onGenerate={generateMagazine}
      onOpen={(rkey) => goto(`/daily?id=${rkey}`)}
    />
  {:else if id === HOME_SECTION.continue}
    {#if continueItems.length > 0}
      <HomeLane
        title="Continue reading"
        icon="clock"
        items={continueItems}
        onOpen={openLaneItem}
        onHover={handlePrefetch}
      />
    {/if}
  {:else if id === HOME_SECTION.follows}
    {#if followItems.length > 0}
      <HomeLane
        title="Shared by people you follow"
        icon="share-2"
        items={followItems}
        action={{ kind: 'link', label: 'View all', href: FOLLOWING_PATH }}
        onOpen={(vm) => {
          const link = followLinkByKey.get(vm.key);
          if (link) void openFollowLink(link, reader);
        }}
      />
    {/if}
  {:else if id === HOME_SECTION.random}
    {#if randomItems.length > 0}
      <HomeLane
        title="Random picks"
        icon="layers"
        items={randomItems}
        action={{ kind: 'button', label: 'Shuffle', icon: 'refresh-cw', onClick: reshuffle }}
        onOpen={openLaneItem}
        onHover={handlePrefetch}
      />
    {/if}
  {:else if id === HOME_SECTION.recent}
    {#if recentItems.length > 0}
      <HomeLane
        title="Recently saved"
        icon="bookmark"
        items={recentItems}
        action={{ kind: 'link', label: 'View all', href: '/saved' }}
        onOpen={openLaneItem}
        onHover={handlePrefetch}
      />
    {/if}
  {:else if roomLaneById.has(id)}
    {@const lane = roomLaneById.get(id)!}
    <HomeLane
      title={lane.title}
      icon="book-open"
      items={lane.items}
      action={{
        kind: 'link',
        label: 'Open room',
        href: `/rooms?uri=${encodeURIComponent(lane.subject)}`,
      }}
      onOpen={(vm) => {
        const item = lane.byKey.get(vm.key);
        if (item) void openRoomArticle(lane.subject, item);
      }}
    />
  {:else if channelLaneById.has(id)}
    {@const lane = channelLaneById.get(id)!}
    <HomeLane
      title={lane.view.name}
      icon="filter"
      items={lane.items}
      action={{ kind: 'link', label: 'View all', href: `/saved?view=${lane.view.uuid}` }}
      onOpen={openLaneItem}
      onHover={handlePrefetch}
    />
  {/if}
{/snippet}

<div class="home-page">
  <header class="home-header" use:shellToolbar>
    <div class="header-inner">
      <NavigationDropdown currentTitle="Home" />
      {@render customizeButton()}
    </div>
  </header>

  <div class="home-body" data-density={preferences.cardDensity}>
    <div class="masthead">
      <div class="masthead-text">
        {#if dateLabel}<p class="masthead-date">{dateLabel}</p>{/if}
        <h1 class="masthead-greeting">{greeting}</h1>
      </div>

      <!-- Below 1000px the toolbar strip is gone (mobile uses the bottom bar), so
           the button rides in the masthead there instead. -->
      <div class="masthead-customize">{@render customizeButton()}</div>
    </div>

    <!-- Renders itself only for a guest, and only until dismissed. -->
    <GuestModeBanner />

    {#if isLoading}
      {#if !hiddenSections.has(HOME_SECTION.continue)}
        <HomeLane title="Continue reading" icon="clock" items={[]} loading onOpen={() => {}} />
      {/if}
      {#if !hiddenSections.has(HOME_SECTION.random)}
        <HomeLane title="Random picks" icon="layers" items={[]} loading onOpen={() => {}} />
      {/if}
    {:else}
      <!-- In the reader's order (Customize). Highlights and the daily magazine work
           from local data for a guest (the server half queues until sign-in), so
           both surfaces show. Empty lanes render nothing. -->
      {#each visibleSectionIds as id (id)}
        {@render homeSection(id)}
      {/each}

      {#if !hasAnyLane}
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
      {:else if allLanesHidden}
        <p class="all-hidden">
          Every lane is hidden.
          <button type="button" class="link-button" onclick={() => (customizeOpen = true)}>
            Customize Home
          </button>
        </p>
      {/if}
    {/if}
  </div>

  <HomeCustomizeDialog
    open={customizeOpen}
    onclose={() => (customizeOpen = false)}
    {sections}
    hidden={hiddenSections}
    onReorder={reorderSections}
    onToggle={toggleSection}
    onReset={() => preferences.setHomeLayout(EMPTY_HOME_LAYOUT)}
  />

  {#if mobileStore.isMobile && !readerItem}
    <MobileBottomBar
      controlsVisible={scrollDirection.controlsVisible}
      currentTitle="Home"
      onScrollToTop={scrollToTop}
      onOpenFeedSwitcher={() => {
        perfBegin(PERF_SHEET_OPEN);
        feedSwitcherOpen = true;
      }}
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
      keepMounted
    >
      <MobileFeedSwitcher
        open={feedSwitcherOpen}
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
  <!-- A reader opened from a room lane holds a synthetic, unsaved item: archive
       and remove would act on a save that doesn't exist, so the room read gets
       Mark as read instead (same wiring as RoomPage). -->
  <SavedReader
    {readerItem}
    onClose={reader.closeReader}
    onArchive={openRoomRef ? undefined : () => handleArchive(readerItem!)}
    onRemove={openRoomRef ? undefined : () => handleRemove(readerItem!)}
    onMarkRead={openRoomRef
      ? () => roomsStore.markRead(openRoomRef.subject, openRoomRef.item)
      : undefined}
    markedRead={openRoomRef?.item.readByMe ?? false}
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
     and not as a floating column. Customize lives here rather than in the
     masthead, so the greeting is left to be a greeting. */
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

  /* Just the greeting on the framed layout — Customize sits up in the toolbar
     strip. The hairline under the masthead separates it from the lanes. Below
     1000px there is no strip, so the button comes back into this row, opposite
     the greeting (see .masthead-customize). */
  .masthead {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 0.5rem 1rem;
    padding: 1rem 0.25rem 0.875rem;
    margin-bottom: 0.875rem;
    border-bottom: 1px solid var(--color-border);
  }

  .masthead-customize {
    display: none;
  }

  @media (max-width: 1000px) {
    .masthead-customize {
      display: block;
      flex-shrink: 0;
      /* Sit level with the greeting's text rather than its descenders when the
         row bottom-aligns the two. */
      padding-bottom: 0.15rem;
    }
  }

  /* May shrink (the greeting wraps) so the button never pushes the row wider
     than a phone. */
  .masthead-text {
    min-width: 0;
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

  /* One quiet button: every Home setting (where the app opens, card density,
     which sections show and their order) lives behind it, in HomeCustomizeDialog.
     Matches the daily-magazine rail's small bordered controls. */
  .customize-button {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    white-space: nowrap;
    cursor: pointer;
  }

  .customize-button:hover {
    background: var(--color-bg-secondary);
  }

  .customize-button:focus-visible,
  .link-button:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  .all-hidden {
    margin: 2rem 0;
    text-align: center;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .link-button {
    padding: 0;
    border: none;
    background: none;
    color: var(--color-primary);
    font: inherit;
    cursor: pointer;
  }

  .link-button:hover {
    text-decoration: underline;
  }
</style>
