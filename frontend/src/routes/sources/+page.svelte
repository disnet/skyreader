<script lang="ts">
  import { onMount } from 'svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { appManager } from '$lib/stores/app.svelte';
  import { feedStatusStore } from '$lib/stores/feedStatus.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { fetchSingleFeed, fetchAllDocuments } from '$lib/services/feedFetcher';
  import { articlesStore } from '$lib/stores/articles.svelte';
  import { profileService } from '$lib/services/profiles';
  import { api, SubscriptionLimitError } from '$lib/services/api';
  import { getSourceDisplay, isLinkblogPublication } from '$lib/utils/sourceDisplay';
  import { findCrossTypeDuplicates } from '$lib/services/subscriptionDedup';
  import { loadDismissedUnifyHosts, dismissUnifyHost } from '$lib/services/unifyDismiss';
  import Icon from '$lib/components/Icon.svelte';
  import UnifyNotice from '$lib/components/UnifyNotice.svelte';
  import StaticPageChrome from '$lib/components/feed/StaticPageChrome.svelte';
  import EditFeedModal from '$lib/components/EditFeedModal.svelte';
  import AddFeedModal from '$lib/components/AddFeedModal.svelte';
  import AddHandleModal from '$lib/components/AddHandleModal.svelte';
  import SourceRow from '$lib/components/sources/SourceRow.svelte';
  import SourceList from '$lib/components/sources/SourceList.svelte';
  import ScopeTabs from '$lib/components/sources/ScopeTabs.svelte';
  import SourcesToolbar from '$lib/components/sources/SourcesToolbar.svelte';
  import BulkActionBar from '$lib/components/sources/BulkActionBar.svelte';
  import SourceSectionHeader from '$lib/components/sources/SourceSectionHeader.svelte';
  import SourcesDiscovery, {
    type AuthorPublication,
  } from '$lib/components/sources/SourcesDiscovery.svelte';
  import FollowsSourceRow from '$lib/components/sources/FollowsSourceRow.svelte';
  import BlueskyFeedsSection from '$lib/components/sources/BlueskyFeedsSection.svelte';
  import LimitNotice from '$lib/components/LimitNotice.svelte';
  import { feedLimitLine } from '$lib/utils/limitCopy';
  import { auth } from '$lib/stores/auth.svelte';

  import type { Subscription, BlueskyProfile } from '$lib/types';

  interface DetectedPublication {
    uri: string;
    name: string;
    url: string;
    description?: string;
    iconUrl?: string;
  }

  interface DetectedContent {
    publications: DetectedPublication[];
    loading: boolean;
  }

  // -- State --
  let searchQuery = $state('');
  let editingSubscription = $state<Subscription | null>(null);
  let editModalOpen = $state(false);
  let selectedIds = $state<Set<number>>(new Set());
  let profiles = $state<Map<string, BlueskyProfile>>(new Map());
  let detectedContent = $state<Map<string, DetectedContent>>(new Map());

  // -- Parked feeds: PDS records over the plan's active capacity. Saved to the
  // account and portable, just not serviced or shown in the reader until the user
  // reactivates one (which requires a free active slot). --
  interface ParkedRecord {
    rkey: string;
    title: string;
    subtitle: string;
    iconUrl: string | null;
    fallbackIcon: string;
  }
  let parkedFeeds = $state<ParkedRecord[]>([]);
  let parkedError = $state<string | null>(null);

  // -- Scope: which kind of source the list shows. Replaces the per-section
  // collapse toggles: one control, and parked feeds get a place in it. --
  type Scope = 'all' | 'atmosphere' | 'web' | 'parked';
  let scope = $state<Scope>('all');

  // Checkboxes only appear once the reader asks to select; the everyday list
  // stays quiet. Selection is scoped to the Web (folders only apply to RSS).
  let selecting = $state(false);

  function stopSelecting() {
    selecting = false;
    selectedIds = new Set();
  }

  // -- Unify duplicates: a site followed both by RSS and on standard.site.
  // "Keep both" dismissals are persisted by host so the notice doesn't nag. --
  let dismissedUnifyHosts = $state<Set<string>>(new Set());

  function dismissUnify(host: string) {
    dismissUnifyHost(host);
    dismissedUnifyHosts = new Set(dismissedUnifyHosts).add(host);
  }

  // Pairs where the same publication is followed by RSS and on standard.site,
  // minus any host the user chose to keep both copies of.
  let unifyPairs = $derived(
    findCrossTypeDuplicates(subscriptionsStore.subscriptions).filter(
      (p) => !dismissedUnifyHosts.has(p.host)
    )
  );

  // Resolve a duplicate by dropping the subscription the user didn't keep.
  // "Keep both" instead persists a dismissal via dismissUnify.
  async function dropSubscription(id: number | undefined) {
    if (id == null) return;
    await subscriptionsStore.remove(id);
  }

  const CONTENT_CACHE_KEY = 'skyreader:detected-content';
  type CachedContent = Omit<DetectedContent, 'loading'>;

  function loadContentCache(): Map<string, CachedContent> {
    try {
      const raw = localStorage.getItem(CONTENT_CACHE_KEY);
      if (!raw) return new Map();
      const obj = JSON.parse(raw) as Record<string, CachedContent>;
      return new Map(Object.entries(obj));
    } catch {
      return new Map();
    }
  }

  function saveContentCache(did: string, content: CachedContent) {
    try {
      const existing = loadContentCache();
      existing.set(did, content);
      const obj: Record<string, CachedContent> = {};
      for (const [k, v] of existing) {
        obj[k] = v;
      }
      localStorage.setItem(CONTENT_CACHE_KEY, JSON.stringify(obj));
    } catch {
      // localStorage full or unavailable
    }
  }

  // -- The Atmosphere: AT Proto sources, one row each, ordered by person --
  interface AtmosphereRow {
    sub: Subscription;
    handle: string;
    name: string;
    avatarUrl: string | null;
  }

  function isAtmosphere(sub: Subscription): boolean {
    return (
      !!sub.subjectDid &&
      (sub.sourceType === 'atproto.documents' || sub.sourceType === 'atproto.collection')
    );
  }

  let atmosphereRows = $derived.by((): AtmosphereRow[] => {
    const rows: AtmosphereRow[] = [];
    for (const sub of subscriptionsStore.subscriptions) {
      if (!isAtmosphere(sub)) continue;
      const profile = profiles.get(sub.subjectDid!);
      rows.push({
        sub,
        handle: profile?.handle || sub.subjectDid!,
        name: profile?.displayName || profile?.handle || sub.subjectDid!,
        avatarUrl: profile?.avatar ?? null,
      });
    }
    rows.sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        (a.sub.customTitle || a.sub.title).localeCompare(b.sub.customTitle || b.sub.title)
    );
    return rows;
  });

  // Publications on those same accounts that the reader hasn't added. They used
  // to sit faded inside the reader's own list; they're suggestions, so they go
  // to Find more with the rest.
  let authorPublications = $derived.by((): AuthorPublication[] => {
    const out: AuthorPublication[] = [];
    const subscribedUris = new Set(
      subscriptionsStore.subscriptions
        .filter((s) => s.sourceType === 'atproto.documents' && s.feedUrl)
        .map((s) => s.feedUrl as string)
    );
    for (const [did, content] of detectedContent) {
      if (!atprotoDids.includes(did)) continue;
      const profile = profiles.get(did);
      for (const pub of content.publications) {
        if (subscribedUris.has(pub.uri)) continue;
        out.push({
          did,
          handle: profile?.handle || did,
          avatarUrl: profile?.avatar ?? null,
          uri: pub.uri,
          name: pub.name,
          url: pub.url,
          iconUrl: pub.iconUrl,
        });
      }
    }
    return out;
  });

  // -- The Web: RSS feeds --
  let websites = $derived.by(() => {
    return [...subscriptionsStore.subscriptions]
      .filter((s) => !s.sourceType || s.sourceType === 'rss')
      .sort((a, b) => (a.customTitle || a.title).localeCompare(b.customTitle || b.title));
  });

  interface WebsiteCategoryGroup {
    name: string;
    websites: Subscription[];
  }

  let websiteCategories = $derived.by((): WebsiteCategoryGroup[] => {
    const byCategory = new Map<string, Subscription[]>();
    for (const sub of websites) {
      if (sub.category) {
        const existing = byCategory.get(sub.category) || [];
        existing.push(sub);
        byCategory.set(sub.category, existing);
      }
    }
    return [...byCategory.entries()]
      .map(([name, subs]) => ({ name, websites: subs }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  let uncategorizedWebsites = $derived(websites.filter((s) => !s.category));

  // -- Filtering --
  let filteredAtmosphere = $derived(
    searchQuery
      ? atmosphereRows.filter((r) => {
          const q = searchQuery.toLowerCase();
          return (
            r.name.toLowerCase().includes(q) ||
            r.handle.toLowerCase().includes(q) ||
            (r.sub.customTitle || r.sub.title).toLowerCase().includes(q) ||
            (r.sub.siteUrl || '').toLowerCase().includes(q)
          );
        })
      : atmosphereRows
  );

  let filteredWebsites = $derived(
    searchQuery
      ? websites.filter((s) => {
          const q = searchQuery.toLowerCase();
          return (
            (s.customTitle || s.title).toLowerCase().includes(q) ||
            (s.feedUrl || '').toLowerCase().includes(q) ||
            (s.siteUrl || '').toLowerCase().includes(q)
          );
        })
      : websites
  );

  function filterWebsitesBySearch(subs: Subscription[]): Subscription[] {
    if (!searchQuery) return subs;
    const q = searchQuery.toLowerCase();
    return subs.filter(
      (s) =>
        (s.customTitle || s.title).toLowerCase().includes(q) ||
        (s.feedUrl || '').toLowerCase().includes(q) ||
        (s.siteUrl || '').toLowerCase().includes(q)
    );
  }

  let filteredWebsiteCategories = $derived(
    websiteCategories
      .map((cat) => ({
        ...cat,
        websites: filterWebsitesBySearch(cat.websites),
      }))
      .filter((cat) => cat.websites.length > 0)
  );

  let filteredUncategorizedWebsites = $derived(filterWebsitesBySearch(uncategorizedWebsites));

  let filteredParked = $derived(
    searchQuery
      ? parkedFeeds.filter((p) => {
          const q = searchQuery.toLowerCase();
          return p.title.toLowerCase().includes(q) || p.subtitle.toLowerCase().includes(q);
        })
      : parkedFeeds
  );

  let hasNoSources = $derived(websites.length === 0 && atmosphereRows.length === 0);

  // Only offer the scope control when there's more than one kind to choose from.
  let scopes = $derived(
    (
      [
        { id: 'all', label: 'All', count: websites.length + atmosphereRows.length },
        { id: 'atmosphere', label: 'Atmosphere', count: atmosphereRows.length },
        { id: 'web', label: 'Web', count: websites.length },
        { id: 'parked', label: 'Parked', count: parkedFeeds.length },
      ] as { id: Scope; label: string; count: number }[]
    ).filter((s) => s.id === 'all' || s.count > 0)
  );

  // A scope that empties out (the last parked feed reactivated) falls back to All.
  $effect(() => {
    if (!scopes.some((s) => s.id === scope)) scope = 'all';
  });

  let showAtmosphere = $derived(scope === 'all' || scope === 'atmosphere');
  let showWeb = $derived(scope === 'all' || scope === 'web');
  let showParked = $derived(scope === 'all' || scope === 'parked');

  let noMatches = $derived(
    !!searchQuery &&
      (!showAtmosphere || filteredAtmosphere.length === 0) &&
      (!showWeb || filteredWebsites.length === 0) &&
      (!showParked || filteredParked.length === 0)
  );

  // -- Selection (scoped to The Web — folders only apply to RSS) --
  let allVisibleIds = $derived.by(() => {
    const ids: number[] = [];
    for (const s of filteredWebsites) {
      if (s.id) ids.push(s.id);
    }
    return ids;
  });

  let allSelected = $derived(
    allVisibleIds.length > 0 && allVisibleIds.every((id) => selectedIds.has(id))
  );
  let selectionCount = $derived(selectedIds.size);

  function toggleSelectAll() {
    selectedIds = allSelected ? new Set() : new Set(allVisibleIds);
  }

  function toggleSelect(id: number) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedIds = next;
  }

  // -- Actions --
  function handleEdit(sub: Subscription) {
    editingSubscription = sub;
    editModalOpen = true;
  }

  async function handleRemove(sub: Subscription) {
    if (sub.id && confirm(`Remove "${sub.customTitle || sub.title}"?`)) {
      await subscriptionsStore.remove(sub.id);
    }
  }

  function closeEditModal() {
    editModalOpen = false;
    editingSubscription = null;
  }

  function getFaviconUrl(sub: Subscription): string | null {
    if (sub.customIconUrl) return sub.customIconUrl;
    const url = sub.siteUrl || sub.feedUrl;
    if (!url) return null;
    try {
      const host = new URL(url).hostname;
      return `https://icons.duckduckgo.com/ip3/${host}.ico`;
    } catch {
      return null;
    }
  }

  function getSubtitle(sub: Subscription): string {
    if (!sub.sourceType || sub.sourceType === 'rss') {
      try {
        return new URL(sub.siteUrl || sub.feedUrl || '').hostname;
      } catch {
        return '';
      }
    }
    return '';
  }

  // Strip protocol/trailing slash so a publication URL reads cleanly inline.
  function formatPublicationUrl(url: string): string {
    return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  }

  // Subtitle for a subscribed Atmosphere source: whose it is, then what it is.
  // With no per-person header above the rows, the handle always leads.
  function getAtmosphereSubtitle(sub: Subscription, handle: string): string {
    const who = handle.startsWith('did:') ? handle : '@' + handle;
    if (sub.sourceType === 'atproto.collection') return `${who} · Collection`;
    if (isLinkblogPublication(sub.feedUrl, sub.siteUrl)) return `${who} · Linkblog`;
    return sub.siteUrl ? `${who} · ${formatPublicationUrl(sub.siteUrl)}` : who;
  }

  // -- Bulk operations (The Web) --
  async function bulkDelete() {
    const count = selectionCount;
    if (!confirm(`Remove ${count} source${count > 1 ? 's' : ''}?`)) return;
    for (const id of [...selectedIds]) {
      await subscriptionsStore.remove(id);
    }
    stopSelecting();
  }

  let folders = $derived.by(() => {
    const cats = new Set<string>();
    for (const sub of subscriptionsStore.subscriptions) {
      if (sub.category) cats.add(sub.category);
    }
    return [...cats].sort((a, b) => a.localeCompare(b));
  });

  let selectedHasCategory = $derived.by(() => {
    for (const id of selectedIds) {
      const sub = subscriptionsStore.getById(id);
      if (sub?.category) return true;
    }
    return false;
  });

  async function assignToFolder(folderName: string) {
    await subscriptionsStore.bulkUpdateLocal([...selectedIds], {
      category: folderName,
    });
    selectedIds = new Set();
  }

  async function removeFromFolder() {
    await subscriptionsStore.bulkUpdateLocal([...selectedIds], {
      category: null,
    });
    selectedIds = new Set();
  }

  // -- Parked feeds --
  async function loadParked() {
    // Parking is an account concept (PDS records over the plan's active
    // capacity). A guest's library is local and capped locally.
    if (auth.isGuest) return;
    try {
      const res = await api.getParkedSubscriptions();
      parkedFeeds = res.records.map((r) => {
        const v = r.value;
        const isAtProto = (v.sourceType || '').startsWith('atproto.');
        const display = getSourceDisplay(v.sourceType as Subscription['sourceType'], v.feedUrl);
        let subtitle = '';
        if (!isAtProto) {
          try {
            subtitle = new URL(v.feedUrl).hostname;
          } catch {
            subtitle = v.feedUrl;
          }
        } else {
          subtitle = isLinkblogPublication(v.feedUrl)
            ? 'linkblog'
            : formatPublicationUrl(v.feedUrl);
        }
        return {
          rkey: r.uri.split('/').pop() || '',
          title: v.customTitle || v.title || v.feedUrl,
          subtitle,
          iconUrl: v.customIconUrl || null,
          fallbackIcon: display.iconName,
        };
      });
    } catch (e) {
      console.error('Failed to load parked feeds:', e);
    }
  }

  async function reactivate(rec: ParkedRecord) {
    parkedError = null;
    try {
      await api.activateSubscription(rec.rkey);
      parkedFeeds = parkedFeeds.filter((p) => p.rkey !== rec.rkey);
      // Now returned by /api/records/list — pull it into the reader and warm it.
      await appManager.syncSubscriptions();
      void fetchAllDocuments(subscriptionsStore.subscriptions);
    } catch (e) {
      // The backend's 403 arrives as a typed error, so this reads the type
      // rather than sniffing the message text for the word "limit".
      parkedError =
        e instanceof SubscriptionLimitError
          ? feedLimitLine(subscriptionsStore.maxSubscriptions, { onSources: true })
          : 'Could not reactivate this feed.';
    }
  }

  // Park an active feed: flips it to parked (kept + portable, just not serviced)
  // and drops it from the reader on resync. Non-destructive — unlike Remove, the
  // PDS record stays, so it can be reactivated later without re-adding.
  async function park(sub: Subscription) {
    try {
      await api.parkSubscription(sub.rkey);
      await appManager.syncSubscriptions();
      await loadParked();
    } catch (e) {
      console.error('Failed to park feed:', e);
    }
  }

  async function removeParked(rec: ParkedRecord) {
    if (!confirm(`Remove "${rec.title}"? This deletes it from your account.`)) return;
    try {
      await api.deleteSubscription(rec.rkey);
      parkedFeeds = parkedFeeds.filter((p) => p.rkey !== rec.rkey);
    } catch (e) {
      console.error('Failed to remove parked feed:', e);
    }
  }

  onMount(() => {
    dismissedUnifyHosts = loadDismissedUnifyHosts();
    // Seed detected-content from cache so unsubscribed publications show instantly.
    detectedContent = new Map(
      [...loadContentCache().entries()].map(([did, c]) => [did, { ...c, loading: false }])
    );
    void loadParked();
  });

  // The AT Proto accounts we have subscriptions for. Subscriptions sync in
  // after mount, so profile + content fetching must REACT to this set rather
  // than snapshot it once — otherwise a fresh load (empty cache) never resolves
  // names/avatars or detects more of a person's publications.
  let atprotoDids = $derived([
    ...new Set(
      subscriptionsStore.subscriptions.filter((s) => s.subjectDid).map((s) => s.subjectDid!)
    ),
  ]);

  // Plain (non-reactive) guards so the effect fires each request at most once.
  const profilesRequested = new Set<string>();
  const detectRequested = new Set<string>();

  $effect(() => {
    const dids = atprotoDids;
    if (dids.length === 0) return;

    const needProfiles = dids.filter((d) => !profilesRequested.has(d));
    if (needProfiles.length > 0) {
      needProfiles.forEach((d) => profilesRequested.add(d));
      profileService.getProfiles(needProfiles).then((fetched) => {
        const next = new Map(profiles);
        for (const [k, v] of fetched) next.set(k, v);
        profiles = next;
      });
    }

    for (const did of dids) {
      if (detectRequested.has(did)) continue;
      detectRequested.add(did);

      if (!detectedContent.has(did)) {
        const next = new Map(detectedContent);
        next.set(did, { publications: [], loading: true });
        detectedContent = next;
      }

      api
        .detectContent(did)
        .then((result) => {
          const content = { publications: result.publications };
          saveContentCache(did, content);
          const updated = new Map(detectedContent);
          updated.set(did, { ...content, loading: false });
          detectedContent = updated;
        })
        .catch(() => {
          const updated = new Map(detectedContent);
          updated.set(did, {
            publications: detectedContent.get(did)?.publications ?? [],
            loading: false,
          });
          detectedContent = updated;
        });
    }
  });
</script>

<svelte:head>
  <title>Sources - Skyreader</title>
</svelte:head>

<StaticPageChrome title="Manage Sources" />

{#snippet webRow(sub: Subscription)}
  {@const status = sub.feedUrl ? feedStatusStore.getStatus(sub.feedUrl) : undefined}
  <SourceRow
    iconUrl={getFaviconUrl(sub)}
    title={sub.customTitle || sub.title}
    subtitle={getSubtitle(sub)}
    hasError={status?.status === 'error' || status?.status === 'circuit-open'}
    errorDetails={sub.feedUrl ? feedStatusStore.getErrorDetails(sub.feedUrl) : null}
    subscribed={true}
    selected={sub.id != null && selectedIds.has(sub.id)}
    fallbackIcon="rss"
    onToggleSelect={selecting ? () => sub.id && toggleSelect(sub.id) : undefined}
    onEdit={() => handleEdit(sub)}
    onRefresh={() => fetchSingleFeed(sub, true, articlesStore.savedGuids)}
    onPark={auth.isGuest ? null : () => park(sub)}
    onRemove={() => handleRemove(sub)}
  />
{/snippet}

<div class="sources-page">
  <SourcesToolbar
    {searchQuery}
    onSearchChange={(v) => (searchQuery = v)}
    onAddRss={() => sidebarStore.openAddFeedModal()}
    onAddHandle={() => sidebarStore.openAddHandleModal()}
  />

  {#if !hasNoSources && (scopes.length > 2 || websites.length > 0)}
    <div class="scope-bar">
      {#if scopes.length > 2}
        <ScopeTabs
          options={scopes}
          value={scope}
          label="Show sources"
          onchange={(id) => (scope = id)}
        />
      {/if}
      {#if websites.length > 0 && showWeb}
        <button
          class="select-toggle"
          aria-pressed={selecting}
          onclick={() => (selecting ? stopSelecting() : (selecting = true))}
        >
          {selecting ? 'Done' : 'Select'}
        </button>
      {/if}
    </div>
  {/if}

  {#if selectionCount > 0}
    <BulkActionBar
      {selectionCount}
      {folders}
      hasCategory={selectedHasCategory}
      onAssignToFolder={assignToFolder}
      onRemoveFromFolder={removeFromFolder}
      onBulkDelete={bulkDelete}
      onClearSelection={() => (selectedIds = new Set())}
    />
  {/if}

  {#if unifyPairs.length > 0}
    <div class="unify-list">
      {#each unifyPairs as pair (`${pair.host}:${pair.rss.id}:${pair.standard.id}`)}
        <UnifyNotice
          {pair}
          onKeepRss={() => dropSubscription(pair.standard.id)}
          onKeepStandard={() => dropSubscription(pair.rss.id)}
          onKeepBoth={() => dismissUnify(pair.host)}
        />
      {/each}
    </div>
  {/if}

  {#if hasNoSources && !searchQuery}
    <!-- First run: no sources yet -->
    <div class="onboarding">
      <h2>Build your library</h2>
      {#if auth.isGuest}
        <p>Sign in to add feeds and keep them across your devices.</p>
        <p><a href="/auth/login?returnUrl=/sources">Sign in</a></p>
      {:else}
        <p>
          Follow RSS feeds, standard.site blogs, and the linkblogs of people you know on Bluesky.
          Use <strong>Add source</strong> above, or start from the suggestions below.
        </p>
      {/if}
    </div>
    {#if !auth.isGuest}
      <section class="sources-section">
        <SourceSectionHeader title="The Atmosphere" />
        <SourceList>
          <FollowsSourceRow />
        </SourceList>
      </section>
      <section class="sources-section" id="bluesky">
        <BlueskyFeedsSection />
      </section>
    {/if}
  {:else}
    {#if noMatches}
      <p class="section-empty">No sources match “{searchQuery}”.</p>
    {/if}

    <!-- THE ATMOSPHERE -->
    {#if showAtmosphere && (!searchQuery || filteredAtmosphere.length > 0)}
      <section class="sources-section">
        <SourceSectionHeader title="The Atmosphere" count={atmosphereRows.length} />
        <SourceList>
          {#if !auth.isGuest && !searchQuery}
            <FollowsSourceRow />
          {/if}
          {#each filteredAtmosphere as row (row.sub.rkey)}
            {@const display = getSourceDisplay(
              row.sub.sourceType,
              row.sub.feedUrl,
              row.sub.siteUrl
            )}
            <SourceRow
              iconUrl={row.sub.customIconUrl || row.avatarUrl}
              iconRound={!row.sub.customIconUrl}
              title={row.sub.customTitle || row.sub.title}
              subtitle={getAtmosphereSubtitle(row.sub, row.handle)}
              subscribed={true}
              fallbackIcon={display.iconName}
              onRemove={() => handleRemove(row.sub)}
              onPark={() => park(row.sub)}
              onEdit={row.sub.sourceType === 'atproto.documents' ? () => handleEdit(row.sub) : null}
            />
          {/each}
        </SourceList>
        {#if atmosphereRows.length === 0 && !searchQuery}
          <p class="section-note">
            No blogs or linkblogs yet. Find people in <strong>Find more</strong> below.
          </p>
        {/if}
      </section>
    {/if}

    <!-- BLUESKY FEEDS -->
    {#if showAtmosphere && !auth.isGuest && !searchQuery}
      <section class="sources-section" id="bluesky">
        <BlueskyFeedsSection />
      </section>
    {/if}

    <!-- THE WEB -->
    {#if showWeb && (!searchQuery || filteredWebsites.length > 0)}
      <section class="sources-section">
        <SourceSectionHeader title="The Web" count={websites.length}>
          {#if selecting && filteredWebsites.length > 0}
            <label class="select-all">
              <input type="checkbox" checked={allSelected} onchange={toggleSelectAll} />
              Select all
            </label>
          {/if}
        </SourceSectionHeader>

        {#each filteredWebsiteCategories as cat (cat.name)}
          <SourceList label={cat.name} count={cat.websites.length}>
            {#snippet icon()}<Icon name="folder" size={13} />{/snippet}
            {#each cat.websites as sub (sub.id)}
              {@render webRow(sub)}
            {/each}
          </SourceList>
        {/each}

        {#if filteredUncategorizedWebsites.length > 0}
          <SourceList
            label={filteredWebsiteCategories.length > 0 ? 'Not in a folder' : null}
            count={filteredUncategorizedWebsites.length}
          >
            {#each filteredUncategorizedWebsites as sub (sub.id)}
              {@render webRow(sub)}
            {/each}
          </SourceList>
        {/if}

        {#if websites.length === 0 && !searchQuery}
          <p class="section-note">
            No RSS feeds yet. Use <strong>Add source → RSS feed</strong> to follow a blog or site.
          </p>
        {/if}
      </section>
    {/if}
  {/if}

  <!-- PARKED: feeds over the active limit, or parked by hand. Saved and
       portable, just not fetched. -->
  {#if showParked && filteredParked.length > 0}
    <section class="sources-section">
      <SourceSectionHeader title="Parked" count={parkedFeeds.length} />
      <!-- The upgrade prompt belongs here only when the cap is what put these
           feeds here. A reader can also park a feed by hand at any count, and
           telling someone with 3 of 100 feeds that they're over their limit is
           both false and a pitch for a plan they don't need. -->
      {#if !subscriptionsStore.canAddMore}
        <div class="parked-notice">
          <LimitNotice kind="feeds">
            <p>
              Over your {subscriptionsStore.maxSubscriptions}-feed active limit. These stay saved to
              your account. Reactivate one to read it, parking or removing an active feed first if
              you're full.
            </p>
          </LimitNotice>
        </div>
      {:else}
        <p class="section-note above">
          Kept on your account, just not fetched. Reactivate one to read it again.
        </p>
      {/if}
      {#if parkedError}
        <p class="parked-error">{parkedError}</p>
      {/if}
      <SourceList>
        {#each filteredParked as rec (rec.rkey)}
          <SourceRow
            iconUrl={rec.iconUrl}
            title={rec.title}
            subtitle={rec.subtitle}
            subscribed={false}
            fallbackIcon={rec.fallbackIcon}
            onReactivate={() => reactivate(rec)}
            onRemove={() => removeParked(rec)}
          />
        {/each}
      </SourceList>
    </section>
  {/if}

  <!-- FIND MORE: suggestions come after the reader's own sources, in the same
       rows, so the page is about what you follow first. -->
  {#if !auth.isGuest && !searchQuery && scope === 'all'}
    <SourcesDiscovery {authorPublications} />
  {/if}
</div>

<AddFeedModal
  open={sidebarStore.addFeedModalOpen}
  onclose={() => sidebarStore.closeAddFeedModal()}
/>

<AddHandleModal
  open={sidebarStore.addHandleModalOpen}
  onclose={() => sidebarStore.closeAddHandleModal()}
/>

<EditFeedModal open={editModalOpen} subscription={editingSubscription} onclose={closeEditModal} />

<style>
  .sources-page {
    max-width: 640px;
    margin: 0 auto;
    padding: 3.5rem 1rem 5rem;
  }

  @media (max-width: 1000px) {
    .sources-page {
      padding-top: 0.5rem;
      padding-bottom: calc(var(--bottom-bar-height) + var(--safe-area-bottom) + 5rem);
    }
  }

  .sources-section + .sources-section {
    margin-top: 2rem;
  }

  /* Scope control: which kind of source the list shows, plus Select. */
  .scope-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: -0.25rem 0 1.5rem;
  }

  .select-toggle:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  .select-toggle {
    flex-shrink: 0;
    margin-left: auto;
    padding: 0.3125rem 0.5rem;
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-primary);
    background: none;
    border: none;
    border-radius: var(--radius-md, 6px);
    cursor: pointer;
  }

  .select-toggle:hover {
    background: var(--color-primary-wash, rgba(0, 102, 204, 0.1));
  }

  .select-all {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    cursor: pointer;
    user-select: none;
  }

  .select-all input {
    margin: 0;
    cursor: pointer;
  }

  .onboarding {
    padding: 0.5rem 0.25rem 0;
    margin-bottom: 2rem;
  }

  .onboarding h2 {
    font-size: var(--text-xl);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-tight);
    margin: 0 0 0.375rem;
  }

  .onboarding p {
    font-size: var(--text-md);
    color: var(--color-text-secondary);
    line-height: var(--leading-normal);
    margin: 0;
    max-width: 56ch;
  }

  .onboarding strong,
  .section-note strong {
    font-weight: var(--weight-semibold);
    color: var(--color-text);
  }

  .section-note {
    margin: 0.5rem 0.25rem 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    line-height: var(--leading-normal);
  }

  .section-note.above {
    margin: 0 0.25rem 0.625rem;
  }

  .section-empty {
    font-size: var(--text-md);
    color: var(--color-text-secondary);
    margin: 0.5rem 0.25rem 1.5rem;
  }

  .parked-notice {
    margin-bottom: 0.75rem;
  }

  .parked-error {
    font-size: var(--text-xs);
    color: var(--color-error);
    margin: 0 0.25rem 0.5rem;
  }

  /* Unify notice: a site followed both by RSS and on standard.site. */
  .unify-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
  }
</style>
