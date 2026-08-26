<script lang="ts">
  // PURE presentational discussion panel: one merged stream of what the
  // Atmosphere said about this article, a filter row over it, and the ways to
  // add your own. Renders entirely from props — no stores, no fetching — so it
  // drops into any surface (the feed card's sticky footer, the reader's
  // Discussion section) given a resolved stream and handlers. The data wiring
  // lives in useAtmosphere (the container/host owns it).
  //
  // <!--
  // THESIS: an article's discussion is ONE conversation that happens to be
  //   spread across several networks — and the network is a property of a row, not
  //   a mode of the panel. So it still refuses the per-NETWORK tab strip that
  //   made the reader click through four bordered boxes, two of them empty, to
  //   find out what anyone said.
  //   What it does tab is KIND, because three different kinds of thing had piled
  //   up here with no boundary between them: what people SAID (every network,
  //   merged), how this is CONNECTED (Semble's collections and typed edges), and
  //   what to READ NEXT (Semble's recommendations). Those are not one list, and
  //   a source filter cut across all three at once — picking "Semble" returned
  //   savers and a graph and a reading list. Tabs by kind; the source filter
  //   survives inside Conversation, the one tab where "which network" means
  //   anything.
  // OWN-WORLD: the app's own reading-room system, at list density: flat,
  //   borderless rows separated by rhythm, one interaction blue, pill filters on
  //   the sunken tone, hairline rules. The tab strip is text on a hairline with
  //   a 2px primary rule under the selected mode — no boxes, no fills, nothing
  //   that reads as chrome the article has to be read around. The only new
  //   material is the person — a 30px avatar wearing a small source glyph.
  // STORY: the reader finishes an article, sees who else read it and what they
  //   said, in order, and can answer in the network of their choosing — then, if
  //   they want it, where this sits in the graph and what to read after it.
  // FIRST VIEWPORT: heading, then the tab row carrying each kind and its count,
  //   then the conversation — avatar left, name and time on the head line, the
  //   person's words beneath in ink. The ways to add yours sit below a hairline
  //   at the end, where a reply belongs.
  // FORM: chronological conversation list under a kind-tab strip; an extension
  //   of the established surface, so no new visual world.
  // -->
  //
  // Your own posted note is NOT rendered here: the Share control carries the
  // shared state and opens the composer on it. This panel is other people's side
  // of the discussion.
  import type { Snippet } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { safeHref } from '$lib/utils/sanitize';
  import type { IconName } from '$lib/components/Icon.svelte';
  import type {
    LaneId,
    LaneRowVM,
    DiscussionEntryVM,
    DiscussionFilterId,
    DiscussionFilterVM,
    DiscussionStreamVM,
    SembleContextVM,
  } from '../articleCardView.types';

  let {
    laneRow = [],
    filters = [],
    activeFilter = 'all',
    stream = { idle: true, loading: false, entries: [] },
    sembleContext,
    /** Render the discussion at all. */
    lanesOpen = true,
    /** Optional DOM id for the region (so a toggle can aria-control it). */
    panelId,
    /** The article this discussion belongs to. Used only as an identity: moving
        to another article refolds everything the reader had opened here. */
    itemUrl,
    /** The reader frames the section with a heading; the card's own Discussion
        button already names it, so it opts out. */
    showHeading = true,
    /** Surface-specific control that leads the "Add yours" row (the reader's
        share-to-linkblog button, which carries its own shared/draft state). */
    composeLead,
    onSelectFilter,
    onCreateInLane,
    onOpenAuthor,
    onRetry,
    onSaveConnection,
    onCreateConnection,
    isConnectionSaved,
  }: {
    laneRow?: LaneRowVM[];
    filters?: DiscussionFilterVM[];
    activeFilter?: DiscussionFilterId;
    stream?: DiscussionStreamVM;
    sembleContext?: SembleContextVM;
    lanesOpen?: boolean;
    panelId?: string;
    itemUrl?: string;
    showHeading?: boolean;
    composeLead?: Snippet;
    onSelectFilter?: (id: DiscussionFilterId) => void;
    onCreateInLane?: (id: LaneId) => void;
    onOpenAuthor?: (did: string) => void;
    onRetry?: () => void;
    /** Toggle a connected article into the reader's own Saved list. Absent when
     *  the reader can't save (signed out), and the control doesn't render at
     *  all. Async — a save fetches and extracts the article first. */
    onSaveConnection?: (url: string) => void | Promise<void>;
    /** Draw a connection of the reader's own from this article. Absent when the
     *  reader can't write one (signed out), and no control renders. Skyreader
     *  could always *show* Semble's graph; this is the way into it. */
    onCreateConnection?: () => void;
    /** Reactive saved-state predicate, so the control reads as state rather than
     *  as an invitation the reader has already accepted. */
    isConnectionSaved?: (url: string) => boolean;
  } = $props();

  // The connections whose saves are in flight. A save costs a fetch and an
  // extraction, so each control has to say it is working, and re-entry on the
  // same one is blocked so a double-click can't create two saves. Different
  // connections save concurrently — keeping three in a row is the normal case.
  let savingUrls = $state<string[]>([]);

  async function toggleSave(url: string) {
    if (!onSaveConnection || savingUrls.includes(url)) return;
    savingUrls = [...savingUrls, url];
    try {
      await onSaveConnection(url);
    } finally {
      savingUrls = savingUrls.filter((u) => u !== url);
    }
  }

  // The headline count: every reference across every lane, before filtering.
  const total = $derived(laneRow.reduce((sum, lane) => sum + lane.count, 0));
  const capped = $derived(laneRow.some((lane) => lane.capped));
  // One populated lane needs no filter row — there is nothing to filter to.
  const showFilters = $derived(filters.length > 2);
  const creatable = $derived(laneRow.filter((lane) => lane.canCreate));
  // Each lane resolves only its most recent handful, so the headline count can
  // outrun the stream. Say so rather than letting "17 references" sit above six
  // people as if that were all of them.
  const linkOnly = $derived(stream.linkOnly ?? []);
  const shown = $derived(stream.entries.length + linkOnly.length);

  // ── The long discussion, folded ─────────────────────────────────────────
  // A widely-read article can bring back dozens of people. All of them at once
  // buries whatever follows (the ways to add yours, the rest of the reader) under
  // a wall the reader never asked to scroll. The first handful is the discussion;
  // the rest is available on request, in the panel's own disclosure grammar.
  /** Entries read before the stream asks to be opened. */
  const STREAM_PREVIEW = 6;
  /** Linkers named before the line asks to be opened. */
  const LINKS_PREVIEW = 8;
  /** Collections named before the strip asks to be opened. A well-mapped URL
   *  sits in dozens; unfolded they are a wall of pills above the discussion. */
  const COLLECTIONS_PREVIEW = 6;

  let streamExpanded = $state(false);
  let linksExpanded = $state(false);
  /** Which kind the reader is looking at. See "The three kinds, as tabs" below. */
  let activeTab = $state<DiscussionTab>('conversation');
  // A different article is a different discussion: nothing stays open across it.
  let expandedFor: string | undefined = undefined;
  $effect(() => {
    if (itemUrl !== expandedFor) {
      expandedFor = itemUrl;
      streamExpanded = false;
      linksExpanded = false;
      activeTab = 'conversation';
    }
  });
  // Narrowing to a lane is its own request to see that lane: it starts folded too.
  let expandedFilter: DiscussionFilterId = 'all';
  $effect(() => {
    if (activeFilter !== expandedFilter) {
      expandedFilter = activeFilter;
      streamExpanded = false;
      linksExpanded = false;
    }
  });

  const visibleEntries = $derived(
    streamExpanded ? stream.entries : stream.entries.slice(0, STREAM_PREVIEW)
  );
  const foldedEntries = $derived(stream.entries.length - visibleEntries.length);
  const visibleLinks = $derived(linksExpanded ? linkOnly : linkOnly.slice(0, LINKS_PREVIEW));
  const foldedLinks = $derived(linkOnly.length - visibleLinks.length);
  // Only once the stream has actually settled: while it is idle or loading,
  // `shown` is 0 for reasons that have nothing to do with how many there are.
  const settled = $derived(!stream.idle && !stream.loading);
  const undisclosed = $derived(
    activeFilter === 'all' && settled && total > shown ? total - shown : 0
  );
  // The source filter lives inside Conversation and reaches every row in it,
  // Semble's own standalone notes included.
  const sembleLaneVisible = $derived(activeFilter === 'all' || activeFilter === 'semble');
  const sembleNotesAll = $derived(sembleContext?.notes ?? []);
  const sembleNotes = $derived(sembleLaneVisible ? sembleNotesAll : []);
  const sembleCollections = $derived(sembleContext?.collections ?? []);
  const hasComposeRow = $derived(Boolean(composeLead) || creatable.length > 0);

  // ── Semble's graph, folded ──────────────────────────────────────────────
  // A curator mapping a topic makes the same edge over and over: same person,
  // same relation, same direction, twenty different targets. Rendered one row
  // each that is twenty repetitions of the sentence and one line of payload.
  // Folded on (curator, direction, type) it is one sentence and twenty titles,
  // which is what the reader came for.
  type SembleConnection = SembleContextVM['connections'][number];
  interface ConnectionGroup {
    key: string;
    direction: 'in' | 'out';
    type: string | null;
    curator: SembleConnection['curator'];
    items: SembleConnection[];
  }
  /** Targets listed inside a group before it asks to be opened. */
  const GROUP_PREVIEW = 3;
  /** Groups listed before the block asks to be opened. */
  const BLOCK_PREVIEW = 5;

  const connectionGroups = $derived.by(() => {
    const groups = new Map<string, ConnectionGroup>();
    for (const connection of sembleContext?.connections ?? []) {
      const key = `${connection.direction}|${connection.type ?? ''}|${connection.curator.did}`;
      const existing = groups.get(key);
      if (existing) existing.items.push(connection);
      else
        groups.set(key, {
          key,
          direction: connection.direction,
          type: connection.type,
          curator: connection.curator,
          items: [connection],
        });
    }
    return [...groups.values()];
  });

  let openGroups = $state<string[]>([]);
  let allGroupsOpen = $state(false);
  let collectionsExpanded = $state(false);
  let similarExpanded = $state(false);
  // A different article is a different graph: nothing stays open across it.
  let openedFor: SembleContextVM | undefined = undefined;
  $effect(() => {
    if (sembleContext !== openedFor) {
      openedFor = sembleContext;
      openGroups = [];
      allGroupsOpen = false;
      collectionsExpanded = false;
      similarExpanded = false;
    }
  });

  const visibleCollections = $derived(
    collectionsExpanded
      ? (sembleContext?.collections ?? [])
      : (sembleContext?.collections ?? []).slice(0, COLLECTIONS_PREVIEW)
  );
  const foldedCollections = $derived(
    (sembleContext?.collections.length ?? 0) - visibleCollections.length
  );
  const similar = $derived(sembleContext?.similar ?? []);
  const visibleSimilar = $derived(similarExpanded ? similar : similar.slice(0, 4));
  const foldedSimilar = $derived(similar.length - visibleSimilar.length);

  const visibleGroups = $derived(
    allGroupsOpen ? connectionGroups : connectionGroups.slice(0, BLOCK_PREVIEW)
  );
  const foldedConnections = $derived(
    connectionGroups.slice(visibleGroups.length).reduce((n, group) => n + group.items.length, 0)
  );

  function toggleGroup(key: string) {
    openGroups = openGroups.includes(key)
      ? openGroups.filter((k) => k !== key)
      : [...openGroups, key];
  }

  // Semble hands back a page of edges, not all of them. Say which, once, where
  // the reader can act on it — rather than as a headline count that contradicts
  // the panel's own.
  const connectionsHeld = $derived(sembleContext?.stats?.connections.total ?? 0);
  const connectionsGot = $derived(sembleContext?.connections.length ?? 0);
  const connectionsBeyond = $derived(
    connectionsHeld > connectionsGot ? connectionsHeld - connectionsGot : 0
  );
  // Collections page the same way. The strip's own fold says how many we hold
  // back; only this says how many we were never handed.
  const collectionsHeld = $derived(sembleContext?.stats?.collections ?? 0);
  const collectionsGot = $derived(sembleContext?.collections.length ?? 0);
  const collectionsBeyond = $derived(
    collectionsHeld > collectionsGot ? collectionsHeld - collectionsGot : 0
  );
  const sembleTruncated = $derived(
    Boolean(sembleContext && Object.values(sembleContext.truncated).some(Boolean))
  );

  // ── The three kinds, as tabs ────────────────────────────────────────────
  // Three different kinds of thing had accumulated in one column with nothing
  // between them, and the source filter cut across all three at once. They are
  // separated by KIND instead: what people said, how this is connected, and what
  // to read next. Conversation always exists — it carries the empty state and
  // the ways to answer — so a tab strip only appears once Semble gives it
  // something to sit beside. One tab is not a tab strip.
  type DiscussionTab = 'conversation' | 'connections' | 'related';
  interface TabVM {
    id: DiscussionTab;
    label: string;
    count: number;
    capped: boolean;
  }

  // Whether Semble returned anything at all to read. A context object that came
  // back empty (the saver fallback, or an API answer with nothing in it) is not
  // content: it must not stand in for the people who aren't there, or the panel
  // would go silent instead of saying nobody wrote about this.
  const hasSembleContent = $derived(
    Boolean(sembleContext) &&
      Boolean(
        sembleNotesAll.length ||
        sembleCollections.length ||
        connectionGroups.length ||
        similar.length
      )
  );
  // A collection membership and a typed edge are both edges in the same graph —
  // one to a shelf, one to another article — so the tab counts them together.
  const connectionsCount = $derived(
    sembleCollections.length + (sembleContext?.connections.length ?? 0)
  );
  const hasConnectionsTab = $derived(connectionsCount > 0);
  const hasRelatedTab = $derived(similar.length > 0);
  const tabs = $derived.by<TabVM[]>(() => {
    const out: TabVM[] = [
      {
        id: 'conversation',
        label: 'Conversation',
        // The headline reference count, plus Semble's standalone notes — which
        // are people saying something and now read in the stream with everyone
        // else, rather than in a block of their own above it.
        count: total + sembleNotesAll.length,
        capped,
      },
    ];
    if (hasConnectionsTab)
      out.push({
        id: 'connections',
        label: 'Connections',
        count: connectionsCount,
        // The count is what this tab will actually render. Where Semble holds
        // more than it handed over, the `+` says so and the tab's own foot says
        // how many.
        capped: connectionsBeyond > 0 || collectionsBeyond > 0 || sembleTruncated,
      });
    if (hasRelatedTab)
      out.push({ id: 'related', label: 'Related', count: similar.length, capped: false });
    return out;
  });
  const showTabs = $derived(tabs.length > 1);

  // Exactly one connect control per panel. It belongs in the Connections tab,
  // beside the edges it adds to; on an article Semble holds no edges for there
  // is no such tab, so the invitation stands at the end of the conversation
  // instead — which is where it matters most, since an unconnected article is
  // the one whose first edge is the only thing there is to add.
  const showStandaloneConnect = $derived(Boolean(onCreateConnection) && !hasConnectionsTab);
  // What the conversation tab actually put on screen. Its emptiness is its own:
  // Semble's graph sits behind another tab and can't stand in for people who
  // never wrote.
  const conversationShown = $derived(shown + sembleNotes.length);

  // A tab whose content drops out from under it (Semble resolved late, the
  // reader moved on) falls back to the conversation rather than showing nothing.
  $effect(() => {
    if (!tabs.some((tab) => tab.id === activeTab)) activeTab = 'conversation';
  });

  // Tabs need ids to point `aria-controls` at. The host supplies one when it has
  // its own toggle to wire up; otherwise the instance mints one.
  const generatedId = $props.id();
  const tabBase = $derived(panelId ?? generatedId);

  // A panel is a tabpanel only while there is a strip above it to select from.
  // Focusable, because APG asks for it and because the reader who just moved a
  // tab needs somewhere for the caret to land in what they revealed.
  function tabPanelAttrs(id: DiscussionTab) {
    if (!showTabs) return {};
    return {
      role: 'tabpanel',
      id: `${tabBase}-panel-${id}`,
      'aria-labelledby': `${tabBase}-tab-${id}`,
      tabindex: 0,
    };
  }

  // Arrow keys move between tabs and select as they go — the expected contract
  // for a strip this small, where every panel is already loaded.
  let tablistEl = $state<HTMLElement | undefined>(undefined);
  function onTabKeydown(event: KeyboardEvent) {
    const ids = tabs.map((tab) => tab.id);
    const from = ids.indexOf(activeTab);
    let to: number;
    if (event.key === 'ArrowRight') to = (from + 1) % ids.length;
    else if (event.key === 'ArrowLeft') to = (from - 1 + ids.length) % ids.length;
    else if (event.key === 'Home') to = 0;
    else if (event.key === 'End') to = ids.length - 1;
    else return;
    event.preventDefault();
    event.stopPropagation();
    activeTab = ids[to];
    tablistEl?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[to]?.focus();
  }

  function groupSentence(group: ConnectionGroup): string {
    const type = group.type ?? 'connected';
    const n = group.items.length;
    const other = n === 1 ? 'one piece' : `${n} pieces`;
    return group.direction === 'out'
      ? `This article ${type} ${other}, connected by ${authorName(group.curator)}`
      : `${other[0].toUpperCase()}${other.slice(1)} ${type} this article, connected by ${authorName(group.curator)}`;
  }

  function authorName(author: { name?: string | null; handle?: string | null; did: string }) {
    return author.name?.trim() || `@${author.handle || author.did.slice(0, 18)}`;
  }

  function connectionLabel(connection: SembleContextVM['connections'][number]): string {
    try {
      return (
        connection.other.title ||
        connection.other.siteName ||
        new URL(connection.other.url).hostname
      );
    } catch {
      return connection.other.title || 'Connected article';
    }
  }

  function similarLabel(item: NonNullable<SembleContextVM['similar']>[number]): string {
    try {
      return item.title || item.siteName || new URL(item.url).hostname;
    } catch {
      return item.title || item.siteName || 'Similar article';
    }
  }

  function displayNameFor(entry: DiscussionEntryVM): string {
    return entry.displayName?.trim() || `@${entry.handle ?? entry.did.slice(0, 18)}`;
  }

  function monogram(source: string): string {
    return source.charAt(0).toUpperCase();
  }

  // The engagement number the stream ranked on, as it reads in the head line.
  function likeLabel(count: number): string {
    return `${count} ${count === 1 ? 'like' : 'likes'}`;
  }

  function monogramFor(entry: DiscussionEntryVM): string {
    return monogram(entry.displayName?.trim() || entry.handle || entry.did.replace('did:plc:', ''));
  }

  // A broken avatar URL (a deleted blob, a CDN miss) hides the image and lets the
  // monogram underneath stand in, rather than leaving a torn-image box.
  function hideBrokenAvatar(event: Event) {
    (event.currentTarget as HTMLImageElement).style.display = 'none';
  }
</script>

<!-- The person: a 30px avatar wearing its network as a small glyph, and a hit
     target that follows them in Skyreader. Shared by the stream's entries and by
     Semble's curators, so the two can never drift apart. -->
{#snippet person(
  did: string,
  handle: string | null | undefined,
  name: string | null | undefined,
  avatar: string | null | undefined,
  laneIcon: IconName = 'semble',
  laneLabel: string = 'Semble'
)}
  {@const label = name?.trim() || `@${handle || did.slice(0, 18)}`}
  <button
    type="button"
    class="entry-avatar"
    title="Follow {handle || did} in Skyreader"
    aria-label="Follow {label} in Skyreader"
    onclick={(e) => {
      e.stopPropagation();
      onOpenAuthor?.(did);
    }}
  >
    <span class="entry-monogram" aria-hidden="true"
      >{monogram(name?.trim() || handle || did.replace('did:plc:', ''))}</span
    >
    {#if avatar}
      <img
        class="entry-photo"
        src={avatar}
        alt=""
        loading="lazy"
        decoding="async"
        onerror={hideBrokenAvatar}
      />
    {/if}
    <span class="entry-source" title={laneLabel}>
      <Icon name={laneIcon} size={10} />
    </span>
  </button>
{/snippet}

<!-- The way into Semble's graph. Quiet, in the block's own disclosure
     vocabulary — an offer, not a call to action. Rendered wherever it currently
     belongs, so it reads the same whether or not Semble already holds anything
     about this article. -->
{#snippet connectCta()}
  <button
    type="button"
    class="semble-disclose semble-connect"
    onclick={(e) => {
      e.stopPropagation();
      onCreateConnection?.();
    }}
  >
    <Icon name="link" size={12} />
    {connectionGroups.length ? 'Connect this to something' : 'Draw the first connection'}
  </button>
{/snippet}

{#if lanesOpen && (total > 0 || hasComposeRow || showStandaloneConnect || hasConnectionsTab || hasRelatedTab)}
  <section class="discussion" class:no-heading={!showHeading} id={panelId} aria-label="Discussion">
    {#if showHeading}
      <div class="discussion-head">
        <h2 class="discussion-title">Discussion</h2>
        <!-- The total and the Conversation tab's count are the same number, and
             two lines apart they read as two facts that don't add up. Where
             there is a tab row it carries every count; where there isn't, the
             heading keeps the one it always had. -->
        {#if total > 0 && !showTabs}
          <span class="discussion-total"
            >{total}{capped ? '+' : ''}
            {total === 1 ? 'reference' : 'references'} across the Atmosphere</span
          >
        {/if}
      </div>
    {/if}

    <!-- The three kinds, named. Text on a hairline with a 2px rule under the
         selected one: enough to say these are modes, quiet enough that the
         article above it stays the loudest thing on the page. It only appears
         once there is more than one kind to choose between. -->
    {#if showTabs}
      <div
        class="discussion-tabs"
        role="tablist"
        aria-label="Kinds of discussion"
        bind:this={tablistEl}
      >
        {#each tabs as tab (tab.id)}
          {@const isActive = activeTab === tab.id}
          <button
            type="button"
            role="tab"
            id="{tabBase}-tab-{tab.id}"
            class="discussion-tab"
            class:active={isActive}
            aria-selected={isActive}
            aria-controls="{tabBase}-panel-{tab.id}"
            tabindex={isActive ? 0 : -1}
            onkeydown={onTabKeydown}
            onclick={(e) => {
              e.stopPropagation();
              activeTab = tab.id;
            }}
          >
            <span>{tab.label}</span>
            <span class="discussion-tab-count">{tab.count}{tab.capped ? '+' : ''}</span>
          </button>
        {/each}
      </div>
    {/if}

    {#if activeTab === 'conversation'}
      <!-- What people said, every network in one list. Semble's standalone notes
           lead it: they are somebody's words about this article, so they read in
           the stream with everyone else's rather than in a block above them. -->
      <div class="discussion-panel" {...tabPanelAttrs('conversation')}>
        <!-- Lanes are filters over the conversation, not navigation between four of
           them. `All` is the resting state; a lane narrows to its own network.
           They live here and nowhere else: "which network" is a fact about a
           row, and only this tab is made of rows. -->
        {#if showFilters}
          <div class="discussion-filters" role="group" aria-label="Filter by source">
            {#each filters as filter (filter.id)}
              {@const isActive = activeFilter === filter.id}
              <button
                type="button"
                class="filter-chip"
                class:active={isActive}
                aria-pressed={isActive}
                onclick={(e) => {
                  e.stopPropagation();
                  onSelectFilter?.(filter.id);
                }}
              >
                {#if filter.icon}
                  <span class="filter-icon"><Icon name={filter.icon} size={13} /></span>
                {/if}
                <span class="filter-label">{filter.label}</span>
                <!-- `All` carries no count. It is the resting state, so its
                     number is the tab's number by definition, and two of them a
                     line apart (one counting Semble's standalone notes, one not)
                     read as an arithmetic mistake rather than the same fact
                     twice. -->
                {#if filter.id !== 'all'}
                  <span class="filter-count">{filter.count}{filter.capped ? '+' : ''}</span>
                {/if}
              </button>
            {/each}
          </div>
        {/if}

        {#if sembleNotes.length > 0 || visibleEntries.length > 0}
          <ul class="discussion-stream">
            {#each sembleNotes as note (note.id)}
              <li class="entry">
                {@render person(
                  note.author.did,
                  note.author.handle,
                  note.author.name,
                  note.author.avatarUrl
                )}
                <div class="entry-body">
                  <div class="entry-head">
                    <span class="entry-name">{authorName(note.author)}</span>
                    {#if note.author.name?.trim() && note.author.handle}
                      <span class="entry-handle">@{note.author.handle}</span>
                    {/if}
                    <span class="entry-verb">noted</span>
                  </div>
                  <p class="entry-note">{note.text}</p>
                </div>
              </li>
            {/each}

            {#each visibleEntries as entry (entry.key)}
              <li class="entry">
                {@render person(
                  entry.did,
                  entry.handle,
                  entry.displayName,
                  entry.avatar,
                  entry.laneIcon,
                  entry.laneLabel
                )}

                <div class="entry-body">
                  <div class="entry-head">
                    <span class="entry-name">{displayNameFor(entry)}</span>
                    {#if entry.displayName?.trim() && entry.handle}
                      <span class="entry-handle">@{entry.handle}</span>
                    {/if}
                    {#if entry.headVerb}
                      <span class="entry-verb">{entry.headVerb}</span>
                    {/if}
                    {#if entry.relativeTime}
                      <span class="entry-sep" aria-hidden="true">·</span>
                      <time class="entry-time" datetime={entry.isoTime ?? undefined}
                        >{entry.relativeTime}</time
                      >
                    {/if}
                    <!-- The stream leads with the most-liked references, so the
                     number that decided the order is on the row. Plain muted
                     text, and absent entirely at zero — a quiet discussion
                     shouldn't be scored. -->
                    {#if entry.likeCount}
                      <span class="entry-sep" aria-hidden="true">·</span>
                      <span class="entry-likes">{likeLabel(entry.likeCount)}</span>
                    {/if}
                    {#if entry.url}
                      <a
                        class="entry-out"
                        href={safeHref(entry.url)}
                        target="_blank"
                        rel="noopener"
                        title="Open on {entry.laneLabel}"
                        aria-label="Open on {entry.laneLabel}"
                        onclick={(e) => e.stopPropagation()}
                      >
                        <Icon name="external-link" size={13} />
                      </a>
                    {/if}
                  </div>

                  <!-- A margin.at note targets a passage: the passage is the point, so
                   it leads, with the annotator's own words beneath it. -->
                  {#if entry.quote}
                    <p class="entry-quote">{entry.quote}</p>
                  {/if}

                  {#if entry.cleanNote}
                    {#if entry.url}
                      <a
                        class="entry-note"
                        href={safeHref(entry.url)}
                        target="_blank"
                        rel="noopener"
                        onclick={(e) => e.stopPropagation()}>{entry.cleanNote}</a
                      >
                    {:else}
                      <p class="entry-note">{entry.cleanNote}</p>
                    {/if}
                  {/if}

                  <!-- Semble saves aren't notes — what matters is which collection
                   the article was filed into. -->
                  {#if entry.collections?.length}
                    <div class="entry-collections">
                      <span class="entry-verb">saved to</span>
                      {#each entry.collections as col (col.name + (col.url ?? ''))}
                        {#if col.url}
                          <a
                            class="entry-collection"
                            href={col.url}
                            target="_blank"
                            rel="noopener"
                            title="Open “{col.name}” on Semble"
                            onclick={(e) => e.stopPropagation()}
                            ><Icon name="folder" size={11} />{col.name}</a
                          >
                        {:else}
                          <span class="entry-collection"
                            ><Icon name="folder" size={11} />{col.name}</span
                          >
                        {/if}
                      {/each}
                    </div>
                  {:else if entry.lane === 'semble' && !entry.cleanNote}
                    <p class="entry-note muted">Saved this</p>
                  {/if}
                </div>
              </li>
            {/each}
          </ul>
        {/if}

        {#if visibleEntries.length > 0}
          {#if foldedEntries > 0}
            <button
              type="button"
              class="semble-disclose semble-disclose-block discussion-disclose"
              aria-expanded={false}
              onclick={(e) => {
                e.stopPropagation();
                streamExpanded = true;
              }}
            >
              Show {foldedEntries} more {foldedEntries === 1 ? 'reply' : 'replies'}
            </button>
          {:else if streamExpanded && stream.entries.length > STREAM_PREVIEW}
            <button
              type="button"
              class="semble-disclose semble-disclose-block discussion-disclose"
              aria-expanded={true}
              onclick={(e) => {
                e.stopPropagation();
                streamExpanded = false;
              }}
            >
              Show fewer
            </button>
          {/if}
        {/if}

        <!-- People are still resolving. Show the shape of what's coming rather than
         the word "Loading" — the stream is the content here. -->
        {#if stream.loading}
          <ul class="discussion-stream skeletons" aria-hidden="true">
            {#each [0, 1, 2] as row (row)}
              <li class="entry skeleton-entry">
                <span class="entry-avatar skeleton-block"></span>
                <div class="entry-body">
                  <span class="skeleton-block skeleton-line short"></span>
                  <span class="skeleton-block skeleton-line"></span>
                </div>
              </li>
            {/each}
          </ul>
          <span class="visually-hidden" role="status">Loading the discussion…</span>
        {/if}

        <!-- Bridges and bots that posted the headline and the URL and nothing else.
         Each of these used to take a full row with an empty body; as one line
         they read as what they are — distribution, not discussion — and the
         people who said something keep the stream to themselves. -->
        {#if linkOnly.length > 0}
          <div class="also-linked" class:leading={visibleEntries.length === 0}>
            <span class="also-linked-label">Also linked by</span>
            {#each visibleLinks as entry (entry.key)}
              {@const label = displayNameFor(entry)}
              {@const hint = entry.relativeTime
                ? `${label} · ${entry.laneLabel} · ${entry.relativeTime}`
                : `${label} · ${entry.laneLabel}`}
              {#if entry.url}
                <a
                  class="also-link"
                  href={safeHref(entry.url)}
                  target="_blank"
                  rel="noopener"
                  title={hint}
                  onclick={(e) => e.stopPropagation()}
                >
                  <span class="also-avatar">
                    <span class="also-monogram" aria-hidden="true">{monogramFor(entry)}</span>
                    {#if entry.avatar}
                      <img
                        class="also-photo"
                        src={entry.avatar}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        onerror={hideBrokenAvatar}
                      />
                    {/if}
                  </span>
                  <span class="also-name">{label}</span>
                </a>
              {:else}
                <span class="also-link" title={hint}>
                  <span class="also-avatar">
                    <span class="also-monogram" aria-hidden="true">{monogramFor(entry)}</span>
                    {#if entry.avatar}
                      <img
                        class="also-photo"
                        src={entry.avatar}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        onerror={hideBrokenAvatar}
                      />
                    {/if}
                  </span>
                  <span class="also-name">{label}</span>
                </span>
              {/if}
            {/each}
            <!-- The rest of the linkers stay one click away rather than wrapping the
             line into a paragraph of names. -->
            {#if foldedLinks > 0}
              <button
                type="button"
                class="also-link also-more"
                aria-expanded="false"
                onclick={(e) => {
                  e.stopPropagation();
                  linksExpanded = true;
                }}
              >
                <span class="also-name">{foldedLinks} more</span>
              </button>
            {:else if linksExpanded && linkOnly.length > LINKS_PREVIEW}
              <button
                type="button"
                class="also-link also-more"
                aria-expanded="true"
                onclick={(e) => {
                  e.stopPropagation();
                  linksExpanded = false;
                }}
              >
                <span class="also-name">Show fewer</span>
              </button>
            {/if}
          </div>
        {/if}

        {#if undisclosed > 0 && shown > 0}
          <p class="discussion-more">
            {undisclosed}{capped ? '+' : ''} more, further back.
          </p>
        {/if}

        <!-- Emptiness is now a fact about THIS tab: an article nobody wrote about
           but everybody filed still says so here, and the Connections tab's own
           count says where the rest of it went. A lane that failed still gets
           its retry, and still says whether anything else answered. -->
        {#if settled && conversationShown === 0}
          {#if stream.failed}
            <p class="discussion-empty">
              {hasSembleContent
                ? "Some of the Atmosphere didn't answer."
                : "Couldn't reach the Atmosphere just now."}
              <button type="button" class="discussion-retry" onclick={() => onRetry?.()}>
                Try again
              </button>
            </p>
          {:else if activeFilter !== 'all'}
            <p class="discussion-empty">Nothing readable from this one.</p>
          {:else if total > 0}
            <p class="discussion-empty">Nothing readable came back.</p>
          {:else}
            <p class="discussion-empty">No one has written about this yet.</p>
          {/if}
        {/if}

        <!-- With no Connections tab to carry it, the invitation stands here on its
           own — and this is the case where drawing an edge matters most: the
           reader has just finished something nobody else has connected, so the
           edge they can make is the only one there is. -->
        {#if showStandaloneConnect}
          <div class="semble-connect-standalone">{@render connectCta()}</div>
        {/if}

        {#if hasComposeRow}
          <div class="discussion-compose">
            <span class="compose-label">Add yours</span>
            {#if composeLead}{@render composeLead()}{/if}
            {#each creatable as lane (lane.id)}
              <button
                type="button"
                class="compose-btn"
                title={lane.createLabel}
                aria-label={lane.createLabel}
                onclick={(e) => {
                  e.stopPropagation();
                  onCreateInLane?.(lane.id);
                }}
              >
                <span class="compose-icon"><Icon name={lane.icon} size={14} /></span>
                <span>{lane.label}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {:else if activeTab === 'connections'}
      <!-- How this article sits in Semble's graph: the shelves it was filed on,
           and the typed edges somebody drew to and from it. Both are edges — one
           to a collection, one to another article — which is why they share a
           tab and a count. -->
      <div class="discussion-panel graph" {...tabPanelAttrs('connections')}>
        {#if sembleContext}
          {#if sembleContext.collections.length}
            <p class="semble-filed">
              <span class="semble-filed-label">Filed in</span>
              {#each visibleCollections as collection (collection.id)}
                {#if collection.url}
                  <a
                    class="semble-collection"
                    href={safeHref(collection.url)}
                    target="_blank"
                    rel="noopener"
                    title={collection.name}
                    onclick={(e) => e.stopPropagation()}
                    ><Icon name="folder" size={11} /><span class="semble-collection-name"
                      >{collection.name}</span
                    ></a
                  >
                {:else}
                  <span class="semble-collection" title={collection.name}
                    ><Icon name="folder" size={11} /><span class="semble-collection-name"
                      >{collection.name}</span
                    ></span
                  >
                {/if}
              {/each}
              {#if foldedCollections > 0}
                <button
                  type="button"
                  class="semble-disclose semble-disclose-inline"
                  aria-expanded={false}
                  onclick={(e) => {
                    e.stopPropagation();
                    collectionsExpanded = true;
                  }}
                >
                  {foldedCollections} more
                </button>
              {/if}
            </p>
          {/if}

          {#if visibleGroups.length > 0}
            <ul class="discussion-stream">
              <!-- One row per (curator, relation, direction). The sentence is said
                 once in the head line and the arrow still points the way the
                 edge does; the titles beneath are the only part that varies. -->
              {#each visibleGroups as group (group.key)}
                {@const open = openGroups.includes(group.key)}
                {@const shown = open ? group.items : group.items.slice(0, GROUP_PREVIEW)}
                {@const folded = group.items.length - shown.length}
                <li class="entry">
                  {@render person(
                    group.curator.did,
                    group.curator.handle,
                    group.curator.name,
                    group.curator.avatarUrl
                  )}
                  <div class="entry-body">
                    <div class="entry-head">
                      <span class="entry-name">{authorName(group.curator)}</span>
                      <span class="relation" aria-label={groupSentence(group)}>
                        {#if group.direction === 'out'}
                          <span class="relation-self">this</span>
                          <span class="relation-arrow" aria-hidden="true">&rarr;</span>
                          <span class="relation-type">{group.type ?? 'connected'}</span>
                        {:else}
                          <span class="relation-type">{group.type ?? 'connected'}</span>
                          <span class="relation-arrow" aria-hidden="true">&rarr;</span>
                          <span class="relation-self">this</span>
                        {/if}
                      </span>
                      {#if group.items.length > 1}
                        <span class="relation-count">{group.items.length}</span>
                      {/if}
                    </div>
                    <ul class="connection-list">
                      {#each shown as connection (connection.id)}
                        {@const saved = isConnectionSaved?.(connection.other.url) ?? false}
                        {@const busy = savingUrls.includes(connection.other.url)}
                        <li>
                          <div class="connection-row">
                            <a
                              class="connection-target"
                              href={safeHref(connection.other.url)}
                              target="_blank"
                              rel="noopener"
                              onclick={(e) => e.stopPropagation()}>{connectionLabel(connection)}</a
                            >
                            <!-- The one thing a reader wants to do with someone
                               else's connected article is keep it. The control
                               stays put rather than appearing on hover: which of
                               these twenty are already yours is information, not
                               an affordance to be discovered. -->
                            {#if onSaveConnection}
                              <button
                                type="button"
                                class="connection-save"
                                class:saved
                                class:busy
                                disabled={busy}
                                aria-busy={busy}
                                aria-pressed={saved}
                                title={saved
                                  ? 'In your Saved list. Remove it'
                                  : 'Save to read in Skyreader'}
                                aria-label={saved
                                  ? `Remove “${connectionLabel(connection)}” from Saved`
                                  : `Save “${connectionLabel(connection)}” to read in Skyreader`}
                                onclick={(e) => {
                                  e.stopPropagation();
                                  toggleSave(connection.other.url);
                                }}
                              >
                                <Icon name="bookmark" size={14} />
                              </button>
                            {/if}
                          </div>
                          {#if connection.note}<p class="connection-note">{connection.note}</p>{/if}
                        </li>
                      {/each}
                    </ul>
                    {#if group.items.length > GROUP_PREVIEW}
                      <button
                        type="button"
                        class="semble-disclose"
                        aria-expanded={open}
                        onclick={(e) => {
                          e.stopPropagation();
                          toggleGroup(group.key);
                        }}
                      >
                        {open ? 'Show fewer' : `Show ${folded} more`}
                      </button>
                    {/if}
                  </div>
                </li>
              {/each}
            </ul>
          {/if}

          {#if foldedConnections > 0}
            <button
              type="button"
              class="semble-disclose semble-disclose-block"
              onclick={(e) => {
                e.stopPropagation();
                allGroupsOpen = true;
              }}
            >
              {foldedConnections} more {foldedConnections === 1 ? 'connection' : 'connections'}
            </button>
          {/if}

          <!-- Where the graph already is, so adding to it doesn't mean scrolling
             past everything to the compose row. -->
          {#if onCreateConnection}
            {@render connectCta()}
          {/if}

          {#if sembleContext.cardUrl && (connectionsBeyond > 0 || collectionsBeyond > 0 || sembleContext.incomplete || sembleTruncated)}
            <p class="semble-foot">
              {#if connectionsBeyond > 0}Showing {connectionsGot} of {connectionsHeld} connections.{/if}
              {#if collectionsBeyond > 0}Showing {collectionsGot} of {collectionsHeld} collections.{/if}
              {#if sembleContext.incomplete}
                Some Semble context is unavailable.
              {:else if sembleTruncated && connectionsBeyond === 0 && collectionsBeyond === 0}
                Semble holds more than this.
              {/if}
              {#if sembleContext.cardUrl}
                <a
                  href={safeHref(sembleContext.cardUrl)}
                  target="_blank"
                  rel="noopener"
                  onclick={(e) => e.stopPropagation()}>See all on Semble</a
                >
              {/if}
            </p>
          {/if}
        {/if}
      </div>
    {:else}
      <!-- What to read next. Not discussion at all, which is exactly why it kept
           reading as a wall bolted onto the end of one. -->
      <div class="discussion-panel graph" {...tabPanelAttrs('related')}>
        {#if sembleContext}
          {#if similar.length > 0}
            <div class="semble-similar">
              <h3>Similar on Semble</h3>
              <ul class="similar-list">
                {#each visibleSimilar as item (item.url)}
                  {@const saved = isConnectionSaved?.(item.url) ?? false}
                  {@const busy = savingUrls.includes(item.url)}
                  <li>
                    <div class="connection-row">
                      <div class="similar-body">
                        <a
                          class="connection-target"
                          href={safeHref(item.url)}
                          target="_blank"
                          rel="noopener"
                          onclick={(e) => e.stopPropagation()}>{similarLabel(item)}</a
                        >
                        {#if (item.title && item.siteName) || item.saveCount > 1}
                          <span class="similar-meta">
                            {#if item.title && item.siteName}{item.siteName}{/if}
                            {#if item.title && item.siteName && item.saveCount > 1}<span
                                aria-hidden="true"
                              >
                                ·
                              </span>{/if}
                            {#if item.saveCount > 1}{item.saveCount} saves{/if}
                          </span>
                        {/if}
                      </div>
                      {#if onSaveConnection}
                        <button
                          type="button"
                          class="connection-save"
                          class:saved
                          class:busy
                          disabled={busy}
                          aria-busy={busy}
                          aria-pressed={saved}
                          title={saved
                            ? 'In your Saved list. Remove it'
                            : 'Save to read in Skyreader'}
                          aria-label={saved
                            ? `Remove “${similarLabel(item)}” from Saved`
                            : `Save “${similarLabel(item)}” to read in Skyreader`}
                          onclick={(e) => {
                            e.stopPropagation();
                            toggleSave(item.url);
                          }}
                        >
                          <Icon name="bookmark" size={14} />
                        </button>
                      {/if}
                    </div>
                  </li>
                {/each}
              </ul>
              {#if foldedSimilar > 0}
                <button
                  type="button"
                  class="semble-disclose"
                  aria-expanded={similarExpanded}
                  onclick={(e) => {
                    e.stopPropagation();
                    similarExpanded = true;
                  }}>{foldedSimilar} more</button
                >
              {/if}
            </div>
          {/if}

          {#if sembleContext.cardUrl}
            <p class="semble-foot">
              <a
                href={safeHref(sembleContext.cardUrl)}
                target="_blank"
                rel="noopener"
                onclick={(e) => e.stopPropagation()}>See all on Semble</a
              >
            </p>
          {/if}
        {/if}
      </div>
    {/if}
  </section>
{/if}

<style>
  .discussion {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  /* In the card's sticky footer there is no heading to open the section, so the
     panel supplies the gap the heading would have made. */
  .discussion.no-heading {
    padding-top: 0.625rem;
  }

  /* Section framing. More space above the heading than below it: the discussion
     is a new movement after the article, and its own parts belong together. */
  .discussion-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }

  .discussion-title {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    line-height: var(--leading-tight);
    color: var(--color-text);
  }

  .discussion-total {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .discussion-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    margin-bottom: 0.875rem;
  }

  /* Filters are pills on the sunken tone — quieter than a bordered control,
     because narrowing the stream is a side road, not the main act. */
  .filter-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    padding: 0.25rem 0.5625rem;
    border: none;
    border-radius: 999px;
    background: var(--color-bg-secondary);
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    line-height: var(--leading-none);
    color: var(--color-text-secondary);
    cursor: pointer;
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }

  .filter-chip:hover {
    color: var(--color-text);
  }

  .filter-chip.active {
    background: var(--color-sidebar-active);
    color: var(--color-primary);
  }

  .filter-icon {
    display: inline-flex;
    flex-shrink: 0;
  }

  .filter-count {
    font-variant-numeric: tabular-nums;
    color: inherit;
    opacity: 0.7;
  }

  .filter-chip.active .filter-count {
    opacity: 1;
  }

  /* The stream: borderless rows separated by rhythm, like the feed itself. */
  .discussion-stream {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  /* The tab row: three kinds, named, on a hairline. Text and a rule, no boxes
     and no fills — the strip has to say these are modes without becoming chrome
     the article has to be read around. It scrolls rather than wraps, so a long
     label can never push the panel into two rows of navigation. */
  .discussion-tabs {
    display: flex;
    gap: 1.25rem;
    margin-bottom: 0.875rem;
    border-bottom: 1px solid var(--color-border);
    overflow-x: auto;
    scrollbar-width: none;
  }

  .discussion-tabs::-webkit-scrollbar {
    display: none;
  }

  /* Weight is identical across tabs on purpose: bolding the selected one would
     re-measure the strip on every switch, and the rule under it already says
     which is which without moving anything. */
  .discussion-tab {
    display: inline-flex;
    align-items: baseline;
    flex-shrink: 0;
    gap: 0.375rem;
    margin-bottom: -1px;
    padding: 0 0 0.4375rem;
    border: 0;
    border-bottom: 2px solid transparent;
    background: none;
    font: inherit;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    line-height: var(--leading-snug);
    color: var(--color-text-secondary);
    white-space: nowrap;
    cursor: pointer;
    transition:
      color 0.15s ease,
      border-color 0.15s ease;
  }

  .discussion-tab:hover {
    color: var(--color-text);
  }

  /* The selected mode is the only thing in the strip in ink, and the rule under
     it is the only place the interaction blue lands here. Colour is never the
     sole carrier: the 2px rule is the shape that says the same thing. */
  .discussion-tab.active {
    color: var(--color-text);
    border-bottom-color: var(--color-primary);
  }

  .discussion-tab-count {
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
    color: var(--color-text-secondary);
  }

  .discussion-tab.active .discussion-tab-count {
    color: var(--color-primary);
  }

  .discussion-panel {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  /* Semble's side is a graph, not a conversation. Its parts are separate
     statements about the article and want room between them, where the
     conversation's rows carry their own rhythm. */
  .discussion-panel.graph {
    gap: 0.875rem;
  }

  /* The panel is the tab's own scroll and focus target; the rule above it is
     the strip's, so it needs no outline box of its own. */
  .discussion-panel:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 4px;
    border-radius: 4px;
  }

  /* Where the article is filed. One line of pills reading as a set, with a
     lead-in rather than a heading — a heading here would compete with the
     panel's own, for two words of wayfinding. */
  .semble-filed {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--leading-snug);
  }

  .semble-filed-label {
    color: var(--color-text-secondary);
  }

  .semble-collection {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    min-width: 0;
    max-width: 100%;
    padding: 0.1875rem 0.5rem;
    border-radius: 999px;
    background: var(--color-bg-secondary);
    color: var(--color-text);
    text-decoration: none;
  }

  /* A collection name is user-written and can run to a paragraph. The pill keeps
     its shape and gives up the tail; the full name stays in the title. */
  .semble-collection-name {
    min-width: 0;
    max-width: 16rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .semble-collection :global(.icon) {
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }

  a.semble-collection:hover {
    color: var(--color-primary);
  }

  a.semble-collection:hover :global(.icon) {
    color: var(--color-primary);
  }

  /* The relation, said once per group. `this` is a token of the article itself,
     so it takes the sunken pill; the arrow between them is the sentence, and it
     points the way the edge does. */
  .relation {
    display: inline-flex;
    align-items: baseline;
    gap: 0.25rem;
    min-width: 0;
    color: var(--color-text-secondary);
  }

  .relation-self {
    flex-shrink: 0;
    padding: 0.0625rem 0.4375rem;
    border-radius: 999px;
    background: var(--color-bg-secondary);
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .relation-count {
    flex-shrink: 0;
    color: var(--color-text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .relation-type {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .relation-arrow {
    flex-shrink: 0;
    color: var(--color-text-secondary);
    opacity: 0.7;
  }

  /* The payload. Titles are the only part of a group that varies, so they are
     the only part in ink — twenty blue links would be a colour event twenty
     times over, and the article is what the reader is here for. */
  .connection-list {
    list-style: none;
    margin: 0.25rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  /* Title takes the room; the keep control holds a fixed column at the trailing
     edge so twenty of them line up instead of ragging with the text. */
  .connection-row {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    min-width: 0;
  }

  .semble-similar {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .semble-similar h3 {
    margin: 0;
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--color-text-secondary);
  }

  .similar-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .similar-body {
    flex: 1;
    min-width: 0;
  }

  .similar-meta {
    display: block;
    margin-top: 0.0625rem;
    font-size: var(--text-xs);
    line-height: var(--leading-snug);
    color: var(--color-text-secondary);
  }

  .similar-list .connection-target {
    color: var(--color-primary);
  }

  /* Quiet at rest and quiet in a column of twenty: the bookmark carries no fill
     and no chrome until it is either hovered or holding something. */
  .connection-save {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    margin: -0.125rem -0.25rem -0.125rem 0;
    padding: 0;
    border: 0;
    border-radius: 999px;
    background: none;
    color: var(--color-text-secondary);
    /* Quiet, but not below the 3:1 bar a control has to clear: 0.75 lands the
       resting glyph at ~3.4:1 on white and ~4.1:1 on the night surface. */
    opacity: 0.75;
    cursor: pointer;
    transition:
      color 0.15s ease,
      opacity 0.15s ease,
      background-color 0.15s ease;
  }

  .connection-save:hover {
    background: var(--color-bg-secondary);
    color: var(--color-primary);
    opacity: 1;
  }

  /* Kept. The bookmark fills so the state survives a glance down the column,
     and it is never the only signal — aria-pressed and the label say it too. */
  .connection-save.saved {
    color: var(--color-primary);
    opacity: 1;
  }

  .connection-save.saved :global(.icon) {
    fill: currentColor;
  }

  /* A save fetches and extracts the article, so this is a real wait. The
     bookmark pulses rather than swapping in a spinner the row has no room for. */
  .connection-save.busy {
    color: var(--color-primary);
    opacity: 1;
    cursor: default;
    animation: connection-save-pulse 1.1s ease-in-out infinite;
  }

  @keyframes connection-save-pulse {
    50% {
      opacity: 0.35;
    }
  }

  /* Two lines, not one: at phone width a single clipped line turns most of
     these into an ellipsis, and the title is the whole payload of the row. */
  .connection-target {
    flex: 1;
    min-width: 0;
    font-size: var(--text-sm);
    line-height: var(--leading-snug);
    color: var(--color-text);
    text-decoration: none;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .connection-target:hover {
    color: var(--color-primary);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .connection-note {
    margin: 0.125rem 0 0;
    font-size: var(--text-sm);
    line-height: var(--leading-snug);
    color: var(--color-text-secondary);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .semble-disclose {
    align-self: flex-start;
    margin-top: 0.375rem;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .semble-disclose:hover {
    color: var(--color-primary);
  }

  .semble-disclose-block {
    margin-top: 0;
  }

  .semble-connect {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
  }

  /* Standing on its own (no Semble block above it), it needs the breathing room
     the block's own gap would have given it. */
  .semble-connect-standalone {
    display: flex;
    margin-top: 0.5rem;
  }

  /* Reads as the last pill in the strip rather than a control beneath it. */
  .semble-disclose-inline {
    align-self: auto;
    margin-top: 0;
  }

  .semble-foot {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--leading-snug);
    color: var(--color-text-secondary);
  }

  .semble-foot a {
    color: var(--color-text-secondary);
    text-decoration: underline;
    text-decoration-color: var(--color-border);
    text-underline-offset: 2px;
  }

  .semble-foot a:hover {
    color: var(--color-primary);
    text-decoration-color: currentColor;
  }

  .connection-target:focus-visible,
  .connection-save:focus-visible,
  .semble-collection:focus-visible,
  .semble-disclose:focus-visible,
  .semble-foot a:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
    border-radius: 4px;
  }

  @media (prefers-reduced-motion: reduce) {
    .connection-save {
      transition: none;
    }

    .connection-save.busy {
      animation: none;
      opacity: 0.6;
    }
  }

  .entry {
    display: flex;
    gap: 0.625rem;
    min-width: 0;
  }

  /* The person. The avatar wears its network as a small glyph, so the source is
     legible without a word of chrome. */
  .entry-avatar {
    position: relative;
    flex-shrink: 0;
    width: 30px;
    height: 30px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: var(--color-bg-secondary);
    cursor: pointer;
  }

  .entry-monogram {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--color-text-secondary);
    user-select: none;
  }

  .entry-photo {
    position: relative;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    object-fit: cover;
    background: var(--color-bg-secondary);
  }

  .entry-source {
    position: absolute;
    right: -4px;
    bottom: -4px;
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: content-box;
    width: 13px;
    height: 13px;
    border-radius: 50%;
    /* Knocked out of the page's own ground, so the glyph reads as pinned to the
       avatar rather than floating over it. A border, not a shadow — nothing here
       has left the page plane. */
    border: 1.5px solid var(--color-bg);
    background: var(--color-bg);
    color: var(--color-text-secondary);
  }

  .entry-avatar:hover .entry-source {
    color: var(--color-primary);
  }

  .entry-body {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }

  .entry-head {
    display: flex;
    align-items: baseline;
    gap: 0.3125rem;
    min-width: 0;
    font-size: var(--text-sm);
    line-height: var(--leading-snug);
  }

  .entry-name {
    flex-shrink: 0;
    max-width: 24ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: var(--weight-semibold);
    color: var(--color-text);
  }

  /* The handle identifies; it doesn't lead. It yields its width first. */
  .entry-handle {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text-secondary);
  }

  .entry-verb,
  .entry-sep,
  .entry-likes,
  .entry-time {
    flex-shrink: 0;
    white-space: nowrap;
    color: var(--color-text-secondary);
  }

  .entry-out {
    flex-shrink: 0;
    display: inline-flex;
    align-self: center;
    margin-left: 0.125rem;
    color: var(--color-text-secondary);
    transition: color 0.15s ease;
  }

  .entry:hover .entry-out,
  .entry-out:hover {
    color: var(--color-primary);
  }

  /* What the person actually said, in ink — the substance of the row, and the
     reason it beats the handle for weight. */
  .entry-note {
    margin: 0.1875rem 0 0;
    font-size: var(--text-sm);
    line-height: var(--leading-normal);
    color: var(--color-text);
    text-decoration: none;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* Hovering the words underlines them rather than repainting a whole paragraph
     in the interaction blue — the head's arrow already carries the tint. */
  a.entry-note:hover {
    text-decoration: underline;
    text-decoration-color: var(--color-border);
    text-underline-offset: 2px;
  }

  .entry-note.muted {
    color: var(--color-text-secondary);
  }

  /* The passage a margin.at note points at. The rule is a quotation mark, the
     one place a side stroke is a convention rather than an accent. */
  .entry-quote {
    margin: 0.375rem 0 0;
    padding-left: 0.5625rem;
    border-left: 2px solid var(--color-border);
    font-size: var(--text-sm);
    line-height: var(--leading-snug);
    color: var(--color-text-secondary);
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .entry-collections {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.3125rem;
    margin-top: 0.25rem;
    font-size: var(--text-sm);
    line-height: var(--leading-snug);
  }

  .entry-collection {
    display: inline-flex;
    align-items: center;
    gap: 0.1875rem;
    font-weight: var(--weight-medium);
    color: var(--color-text);
    text-decoration: none;
    white-space: nowrap;
  }

  .entry-collection :global(.icon) {
    opacity: 0.7;
  }

  a.entry-collection:hover {
    color: var(--color-primary);
    text-decoration: underline;
  }

  a.entry-collection:hover :global(.icon) {
    opacity: 1;
  }

  /* One quiet line, not a list. Pills on the sunken tone group them as a set and
     keep them clearly subordinate to the stream above. */
  .also-linked {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
    margin-top: 1rem;
  }

  /* When nobody commented, this line IS the content — it shouldn't hang off a
     gap meant to separate it from a stream that isn't there. */
  .also-linked.leading {
    margin-top: 0;
  }

  .also-linked-label {
    margin-right: 0.125rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .also-link {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    max-width: 100%;
    padding: 0.125rem 0.5rem 0.125rem 0.1875rem;
    border-radius: 999px;
    background: var(--color-bg-secondary);
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    text-decoration: none;
    transition: color 0.15s ease;
  }

  a.also-link:hover {
    color: var(--color-primary);
  }

  .also-avatar {
    position: relative;
    flex-shrink: 0;
    width: 18px;
    height: 18px;
  }

  .also-monogram {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: var(--color-bg);
    font-size: var(--text-3xs);
    font-weight: var(--weight-semibold);
    color: var(--color-text-secondary);
    user-select: none;
  }

  .also-photo {
    position: relative;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    object-fit: cover;
  }

  .also-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The disclosure under the stream sits where the next reply would be, at the
     stream's own left edge — it continues the list rather than labelling it. */
  .discussion-disclose {
    margin-top: 0.75rem;
  }

  .also-more {
    border: 0;
    font: inherit;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    cursor: pointer;
    padding-left: 0.5rem;
  }

  .also-more:hover {
    color: var(--color-primary);
  }

  .discussion-more {
    margin: 0.875rem 0 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .discussion-empty {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .discussion-retry {
    padding: 0;
    border: none;
    background: none;
    font: inherit;
    color: var(--color-primary);
    text-decoration: underline;
    cursor: pointer;
  }

  /* Loading shows the shape of a person, not a spinner: the stream is the
     content, so its silhouette is the honest placeholder. */
  .skeletons {
    margin-top: 0;
  }

  .skeleton-block {
    display: block;
    border-radius: 4px;
    /* NOT the Sunken tone: that is exactly the card footer's own background, and
       the silhouette vanished into it. Derived from the ink so it reads on any
       surface, in either theme. */
    background: color-mix(in srgb, var(--color-text) 11%, transparent);
    animation: skeleton-fade 1.4s ease-in-out infinite;
  }

  .skeleton-entry .entry-avatar {
    border-radius: 50%;
    cursor: default;
  }

  .skeleton-line {
    width: 78%;
    height: 0.6875rem;
    margin-top: 0.375rem;
  }

  .skeleton-line.short {
    width: 34%;
    margin-top: 0.25rem;
  }

  .skeleton-entry:nth-child(2) .skeleton-line:not(.short) {
    width: 62%;
  }

  .skeleton-entry:nth-child(3) .skeleton-line:not(.short) {
    width: 85%;
  }

  .skeleton-entry:nth-child(2) .skeleton-block {
    animation-delay: 0.12s;
  }

  .skeleton-entry:nth-child(3) .skeleton-block {
    animation-delay: 0.24s;
  }

  @keyframes skeleton-fade {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.55;
    }
  }

  /* Answering comes last, after a hairline — the place a reply belongs. */
  .discussion-compose {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
    margin-top: 1.125rem;
    padding-top: 0.875rem;
    border-top: 1px solid var(--color-border);
  }

  .compose-label {
    margin-right: 0.125rem;
    font-size: var(--text-2xs);
    font-weight: var(--weight-medium);
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
    color: var(--color-text-secondary);
  }

  .compose-btn {
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

  .compose-btn:hover {
    border-color: var(--color-primary);
    color: var(--color-primary);
  }

  .compose-icon {
    display: inline-flex;
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  .compose-btn:hover .compose-icon {
    color: var(--color-primary);
  }

  /* Keyboard focus is visible on every control here, in the interaction blue.
     PRODUCT.md's accessibility floor asks for a visible focus state; a 10%-alpha
     wash would technically be "the ring" and practically be invisible. */
  .discussion-tab:focus-visible,
  .filter-chip:focus-visible,
  .compose-btn:focus-visible,
  .entry-avatar:focus-visible,
  .entry-out:focus-visible,
  .entry-note:focus-visible,
  .entry-collection:focus-visible,
  .also-link:focus-visible,
  .discussion-retry:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
    border-radius: 4px;
  }

  .entry-avatar:focus-visible {
    border-radius: 50%;
  }

  /* The tab's ring hugs the label rather than the underline, so the rule that
     marks the selection stays readable underneath it. */
  .discussion-tab:focus-visible {
    outline-offset: -1px;
    border-radius: 4px;
  }

  .filter-chip:focus-visible,
  .compose-btn:focus-visible,
  .also-link:focus-visible {
    border-radius: 999px;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /* Inside a feed card the panel rides a sticky footer, so it tightens its
     rhythm and lets the avatar shrink rather than pushing the action row down. */
  @container card (max-width: 34rem) {
    .discussion-tabs {
      /* Three labels and three counts have to clear a phone column without
         clipping. They still scroll if a future label or a large text setting
         takes them past it, but at the widths the app ships they fit. */
      gap: 0.75rem;
    }

    .discussion-tab {
      font-size: var(--text-sm);
    }

    .discussion-stream {
      gap: 0.8125rem;
    }

    .entry-avatar {
      width: 26px;
      height: 26px;
    }

    .entry-name {
      max-width: 16ch;
    }
  }

  @media (max-width: 640px) {
    /* On a phone the head line has no room for both names. The avatar and the
       display name identify the person; the handle is the part that goes. Where
       there is no display name the handle IS the name, so it stays. */
    .entry-handle {
      display: none;
    }

    .entry-name {
      max-width: 22ch;
    }

    .discussion-tabs {
      /* Three labels and three counts have to clear a phone column without
         clipping. They still scroll if a future label or a large text setting
         takes them past it, but at the widths the app ships they fit. */
      gap: 0.75rem;
    }

    .discussion-tab {
      font-size: var(--text-sm);
    }

    /* The count is the secondary half of the label, so it is the half that
       gives up a step when the column gets narrow. */
    .discussion-tab-count {
      font-size: var(--text-xs);
    }

    .discussion-compose {
      margin-top: 1rem;
      padding-top: 0.75rem;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .discussion-tab,
    .filter-chip,
    .entry-out,
    .compose-btn,
    .compose-icon,
    .also-link {
      transition: none;
    }

    .skeleton-block {
      animation: none;
    }
  }
</style>
