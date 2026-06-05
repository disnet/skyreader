<script lang="ts">
  import { onMount } from 'svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { feedStatusStore } from '$lib/stores/feedStatus.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { fetchSingleFeed, fetchAllDocuments } from '$lib/services/feedFetcher';
  import { articlesStore } from '$lib/stores/articles.svelte';
  import { profileService } from '$lib/services/profiles';
  import { api } from '$lib/services/api';
  import { mobileStore } from '$lib/stores/mediaQuery.svelte';
  import { getSourceDisplay, isLinkblogPublication } from '$lib/utils/sourceDisplay';
  import Icon from '$lib/components/Icon.svelte';
  import FeedPageHeader from '$lib/components/feed/FeedPageHeader.svelte';
  import MobileBottomBar from '$lib/components/feed/MobileBottomBar.svelte';
  import MobileFeedSwitcher from '$lib/components/feed/MobileFeedSwitcher.svelte';
  import BottomSheet from '$lib/components/common/BottomSheet.svelte';
  import EditFeedModal from '$lib/components/EditFeedModal.svelte';
  import AddFeedModal from '$lib/components/AddFeedModal.svelte';
  import AddHandleModal from '$lib/components/AddHandleModal.svelte';
  import SourceRow from '$lib/components/sources/SourceRow.svelte';
  import SourceGroupHeader from '$lib/components/sources/SourceGroupHeader.svelte';
  import SourcesToolbar from '$lib/components/sources/SourcesToolbar.svelte';
  import BulkActionBar from '$lib/components/sources/BulkActionBar.svelte';
  import SourceSectionHeader from '$lib/components/sources/SourceSectionHeader.svelte';
  import SourcesDiscovery from '$lib/components/sources/SourcesDiscovery.svelte';
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
  let feedSwitcherOpen = $state(false);
  let searchQuery = $state('');
  let editingSubscription = $state<Subscription | null>(null);
  let editModalOpen = $state(false);
  let selectedIds = $state<Set<number>>(new Set());
  let profiles = $state<Map<string, BlueskyProfile>>(new Map());
  let detectedContent = $state<Map<string, DetectedContent>>(new Map());

  // -- Section collapse (persisted) --
  const COLLAPSE_KEY = 'skyreader:sources-collapsed';
  let webCollapsed = $state(false);
  let atmoCollapsed = $state(false);

  function loadCollapse() {
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw) as { web?: boolean; atmo?: boolean };
      webCollapsed = !!obj.web;
      atmoCollapsed = !!obj.atmo;
    } catch {
      // ignore
    }
  }

  function saveCollapse() {
    try {
      localStorage.setItem(
        COLLAPSE_KEY,
        JSON.stringify({ web: webCollapsed, atmo: atmoCollapsed })
      );
    } catch {
      // ignore
    }
  }

  // While searching, sections stay open so results are never hidden.
  let webOpen = $derived(!webCollapsed || !!searchQuery);
  let atmoOpen = $derived(!atmoCollapsed || !!searchQuery);

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

  // -- The Atmosphere: AT Proto sources grouped by person --
  interface PersonGroup {
    did: string;
    profile: BlueskyProfile | null;
    subscriptions: Subscription[];
  }

  let atmosphereGroups = $derived.by((): PersonGroup[] => {
    const byDid = new Map<string, Subscription[]>();
    for (const sub of subscriptionsStore.subscriptions) {
      if (!sub.subjectDid) continue;
      if (sub.sourceType === 'atproto.documents' || sub.sourceType === 'atproto.collection') {
        const existing = byDid.get(sub.subjectDid) || [];
        existing.push(sub);
        byDid.set(sub.subjectDid, existing);
      }
    }

    const groups: PersonGroup[] = [];
    for (const [did, subs] of byDid) {
      groups.push({
        did,
        profile: profiles.get(did) || null,
        subscriptions: subs,
      });
    }

    groups.sort((a, b) => {
      const nameA = a.profile?.displayName || a.profile?.handle || a.did;
      const nameB = b.profile?.displayName || b.profile?.handle || b.did;
      return nameA.localeCompare(nameB);
    });
    return groups;
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
  let filteredPeople = $derived(
    searchQuery
      ? atmosphereGroups.filter((g) => {
          const q = searchQuery.toLowerCase();
          const name = g.profile?.displayName || g.profile?.handle || g.did;
          return (
            name.toLowerCase().includes(q) ||
            g.did.toLowerCase().includes(q) ||
            g.subscriptions.some((s) => (s.customTitle || s.title).toLowerCase().includes(q))
          );
        })
      : atmosphereGroups
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

  let hasNoSources = $derived(websites.length === 0 && atmosphereGroups.length === 0);

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

  // -- Atmosphere helpers --
  function getPersonHandle(group: PersonGroup): string {
    return group.profile?.handle || group.did;
  }

  function getPersonName(group: PersonGroup): string {
    return group.profile?.displayName || group.profile?.handle || group.did;
  }

  async function subscribePublication(did: string, pub: DetectedPublication) {
    const subId = await subscriptionsStore.add(pub.uri, pub.name || pub.url, {
      sourceType: 'atproto.documents',
      subjectDid: did,
      siteUrl: pub.url,
      feedUrl: pub.uri,
    });
    if (pub.iconUrl) {
      await subscriptionsStore.updateLocal(subId, {
        customIconUrl: pub.iconUrl,
      });
    }
    // Fetch this publication's documents now so its feed isn't empty until the
    // next full refresh (also refreshed on the regular cycle).
    void fetchAllDocuments(subscriptionsStore.subscriptions);
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

  // Subtitle for a subscribed Atmosphere source. standard.site blogs surface
  // their publication URL (it identifies the blog); everything else shows the
  // owner's handle.
  function getAtmosphereSubtitle(sub: Subscription, handle: string): string {
    if (
      sub.sourceType === 'atproto.documents' &&
      !isLinkblogPublication(sub.feedUrl) &&
      sub.siteUrl
    ) {
      return formatPublicationUrl(sub.siteUrl);
    }
    return '@' + handle;
  }

  // -- Bulk operations (The Web) --
  async function bulkDelete() {
    const count = selectionCount;
    if (!confirm(`Remove ${count} source${count > 1 ? 's' : ''}?`)) return;
    for (const id of [...selectedIds]) {
      await subscriptionsStore.remove(id);
    }
    selectedIds = new Set();
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

  onMount(() => {
    loadCollapse();
    // Seed detected-content from cache so unsubscribed publications show instantly.
    detectedContent = new Map(
      [...loadContentCache().entries()].map(([did, c]) => [did, { ...c, loading: false }])
    );
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

  function toggleWeb() {
    webCollapsed = !webCollapsed;
    saveCollapse();
  }

  function toggleAtmo() {
    atmoCollapsed = !atmoCollapsed;
    saveCollapse();
  }
</script>

<svelte:head>
  <title>Sources - Skyreader</title>
</svelte:head>

<FeedPageHeader title="Manage Sources" hideControls />

<div class="sources-page">
  <SourcesToolbar
    {searchQuery}
    onSearchChange={(v) => (searchQuery = v)}
    onAddRss={() => sidebarStore.openAddFeedModal()}
    onAddHandle={() => sidebarStore.openAddHandleModal()}
  />

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

  {#if hasNoSources && !searchQuery}
    <!-- First run: no sources yet -->
    <div class="onboarding">
      <h2>Build your library</h2>
      <p>
        Follow RSS feeds, standard.site blogs, and the linkblogs of people you know on Bluesky.
        Everything you follow lives in your PDS — portable across the Atmosphere.
      </p>
    </div>
    <SourcesDiscovery />
  {:else}
    {#if !searchQuery}
      <SourcesDiscovery />
    {/if}

    <!-- THE ATMOSPHERE -->
    <section class="sources-section">
      <SourceSectionHeader
        icon="users"
        title="The Atmosphere"
        subtitle="people you follow"
        count={atmosphereGroups.length}
        collapsed={!atmoOpen}
        onToggle={toggleAtmo}
      />

      {#if atmoOpen}
        {#if filteredPeople.length > 0}
          <div class="source-list person-list">
            {#each filteredPeople as group (group.did)}
              {@const detected = detectedContent.get(group.did)}
              {@const handle = getPersonHandle(group)}
              {@const avatarUrl = group.profile?.avatar ?? null}

              <SourceGroupHeader
                {avatarUrl}
                displayName={getPersonName(group)}
                {handle}
                onRemoveAll={async () => {
                  if (confirm(`Remove all subscriptions for ${getPersonName(group)}?`)) {
                    await Promise.all(
                      group.subscriptions
                        .filter((s) => s.id != null)
                        .map((s) => subscriptionsStore.remove(s.id!))
                    );
                  }
                }}
              />

              <!-- Subscribed streams (blog / linkblog) -->
              {#each group.subscriptions as sub (sub.rkey)}
                {@const display = getSourceDisplay(sub.sourceType, sub.feedUrl)}
                <SourceRow
                  iconUrl={sub.customIconUrl || avatarUrl}
                  iconRound={!sub.customIconUrl}
                  title={sub.customTitle || sub.title}
                  subtitle={getAtmosphereSubtitle(sub, handle)}
                  subscribed={true}
                  fallbackIcon={display.iconName}
                  onRemove={() => handleRemove(sub)}
                  onEdit={sub.sourceType === 'atproto.documents' ? () => handleEdit(sub) : null}
                />
              {/each}

              <!-- Detected but not yet subscribed -->
              {#if detected && !detected.loading}
                {#each detected.publications as pub (pub.uri)}
                  {#if !group.subscriptions.some((s) => s.sourceType === 'atproto.documents' && s.feedUrl === pub.uri)}
                    {@const pubDisplay = getSourceDisplay('atproto.documents', pub.uri)}
                    <SourceRow
                      iconUrl={pub.iconUrl || avatarUrl}
                      iconRound={!pub.iconUrl}
                      title={pub.name || pub.url}
                      subtitle={formatPublicationUrl(pub.url)}
                      subscribed={false}
                      fallbackIcon={pubDisplay.iconName}
                      onSubscribe={() => subscribePublication(group.did, pub)}
                    />
                  {/if}
                {/each}
              {/if}

              {#if detected?.loading}
                <div class="content-type-loading">
                  <span class="spinner-small"></span>
                  <span>Detecting content…</span>
                </div>
              {/if}
            {/each}
          </div>
        {:else if searchQuery}
          <p class="section-empty">No people match “{searchQuery}”.</p>
        {:else}
          <p class="section-empty">
            You're not following anyone's blog or linkblog yet. Find people in Find more above.
          </p>
        {/if}
      {/if}
    </section>

    <!-- THE WEB -->
    <section class="sources-section">
      <SourceSectionHeader
        icon="globe"
        title="The Web"
        subtitle="RSS feeds"
        count={websites.length}
        collapsed={!webOpen}
        onToggle={toggleWeb}
      />

      {#if webOpen}
        {#if filteredWebsites.length > 0}
          <div class="select-all-row">
            <label class="checkbox-label">
              <input type="checkbox" checked={allSelected} onchange={toggleSelectAll} />
              <span class="select-all-text">Select all</span>
            </label>
          </div>

          {#each filteredWebsiteCategories as cat (cat.name)}
            <div class="category-section">
              <h3 class="category-title">
                <Icon name="folder" size={14} />
                {cat.name}
                <span class="group-count">{cat.websites.length}</span>
              </h3>
              <div class="source-list">
                {#each cat.websites as sub (sub.id)}
                  {@const status = sub.feedUrl ? feedStatusStore.getStatus(sub.feedUrl) : undefined}
                  <SourceRow
                    iconUrl={getFaviconUrl(sub)}
                    title={sub.customTitle || sub.title}
                    subtitle={getSubtitle(sub)}
                    hasError={status?.status === 'error' || status?.status === 'circuit-open'}
                    subscribed={true}
                    selected={sub.id != null && selectedIds.has(sub.id)}
                    fallbackIcon="rss"
                    onToggleSelect={() => sub.id && toggleSelect(sub.id)}
                    onEdit={() => handleEdit(sub)}
                    onRefresh={() => fetchSingleFeed(sub, true, articlesStore.savedGuids)}
                    onRemove={() => handleRemove(sub)}
                  />
                {/each}
              </div>
            </div>
          {/each}

          {#if filteredUncategorizedWebsites.length > 0}
            {#if filteredWebsiteCategories.length > 0}
              <h3 class="category-title uncategorized-title">
                Uncategorized
                <span class="group-count">{filteredUncategorizedWebsites.length}</span>
              </h3>
            {/if}
            <div class="source-list">
              {#each filteredUncategorizedWebsites as sub (sub.id)}
                {@const status = sub.feedUrl ? feedStatusStore.getStatus(sub.feedUrl) : undefined}
                <SourceRow
                  iconUrl={getFaviconUrl(sub)}
                  title={sub.customTitle || sub.title}
                  subtitle={getSubtitle(sub)}
                  hasError={status?.status === 'error' || status?.status === 'circuit-open'}
                  subscribed={true}
                  selected={sub.id != null && selectedIds.has(sub.id)}
                  fallbackIcon="rss"
                  onToggleSelect={() => sub.id && toggleSelect(sub.id)}
                  onEdit={() => handleEdit(sub)}
                  onRefresh={() => fetchSingleFeed(sub, true, articlesStore.savedGuids)}
                  onRemove={() => handleRemove(sub)}
                />
              {/each}
            </div>
          {/if}
        {:else if searchQuery}
          <p class="section-empty">No feeds match “{searchQuery}”.</p>
        {:else}
          <p class="section-empty">
            No RSS feeds yet. Use <strong>Add source → RSS feed</strong> to follow a blog or site.
          </p>
        {/if}
      {/if}
    </section>
  {/if}

  {#if mobileStore.isMobile}
    <MobileBottomBar
      controlsVisible={true}
      currentTitle="Manage Sources"
      onScrollToTop={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      onOpenFeedSwitcher={() => (feedSwitcherOpen = true)}
      onOpenFilterSheet={() => {}}
      hasActiveFilters={false}
      hideFilterButton
    />

    <BottomSheet
      open={feedSwitcherOpen}
      onclose={() => (feedSwitcherOpen = false)}
      title="Switch Feed"
    >
      <MobileFeedSwitcher
        onclose={() => (feedSwitcherOpen = false)}
        currentTitle="Manage Sources"
      />
    </BottomSheet>
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

  .sources-section {
    margin-bottom: 1.25rem;
  }

  .onboarding {
    padding: 0.5rem 0.25rem 0;
    margin-bottom: 1rem;
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

  .select-all-row {
    padding: 0.25rem 0.25rem 0.5rem;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .select-all-text {
    user-select: none;
  }

  .group-count {
    font-weight: var(--weight-regular);
  }

  .source-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    background: var(--color-border);
    border-radius: 12px;
  }

  .source-list > :global(:first-child) {
    border-radius: 12px 12px 0 0;
  }

  .source-list > :global(:last-child) {
    border-radius: 0 0 12px 12px;
  }

  .source-list > :global(:only-child) {
    border-radius: 12px;
  }

  .category-section {
    margin-bottom: 1rem;
  }

  .category-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    color: var(--color-text-secondary);
    margin: 0.75rem 0 0.375rem;
    padding: 0 0.25rem;
  }

  .uncategorized-title {
    margin-top: 1rem;
  }

  .content-type-loading {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    background: var(--color-bg);
  }

  .spinner-small {
    width: 14px;
    height: 14px;
    border: 2px solid var(--color-border);
    border-top-color: var(--color-primary);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .section-empty {
    font-size: var(--text-md);
    color: var(--color-text-secondary);
    line-height: var(--leading-normal);
    margin: 0.25rem 0.25rem 0.5rem;
  }

  .section-empty strong {
    font-weight: var(--weight-semibold);
    color: var(--color-text);
  }
</style>
