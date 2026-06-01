<script lang="ts">
  import { onMount } from 'svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { feedStatusStore } from '$lib/stores/feedStatus.svelte';
  import { unreadCounts } from '$lib/stores/unreadCounts.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { fetchSingleFeed } from '$lib/services/feedFetcher';
  import { articlesStore } from '$lib/stores/articles.svelte';
  import { profileService } from '$lib/services/profiles';
  import { api } from '$lib/services/api';
  import { mobileStore } from '$lib/stores/mediaQuery.svelte';
  import { getSourceDisplay } from '$lib/utils/sourceDisplay';
  import Icon from '$lib/components/Icon.svelte';
  import LinkblogDiscovery from '$lib/components/LinkblogDiscovery.svelte';
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
  let activeTab = $state<'people' | 'websites'>('people');

  function switchTab(tab: 'people' | 'websites') {
    activeTab = tab;
    selectedIds = new Set();
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

  // -- Person groups --
  interface PersonGroup {
    did: string;
    profile: BlueskyProfile | null;
    subscriptions: Subscription[];
    hasDocuments: boolean;
    totalUnread: number;
  }

  let peopleGroups = $derived.by((): PersonGroup[] => {
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
      const hasDocuments = subs.some((s) => s.sourceType === 'atproto.documents');
      const totalUnread = subs.reduce(
        (sum, s) => sum + (s.id ? (unreadCounts.feedCounts.get(s.id) ?? 0) : 0),
        0
      );
      groups.push({
        did,
        profile: profiles.get(did) || null,
        subscriptions: subs,
        hasDocuments,
        totalUnread,
      });
    }

    groups.sort((a, b) => {
      const nameA = a.profile?.displayName || a.profile?.handle || a.did;
      const nameB = b.profile?.displayName || b.profile?.handle || b.did;
      return nameA.localeCompare(nameB);
    });
    return groups;
  });

  let websites = $derived.by(() => {
    return [...subscriptionsStore.subscriptions]
      .filter((s) => !s.sourceType || s.sourceType === 'rss')
      .sort((a, b) => (a.customTitle || a.title).localeCompare(b.customTitle || b.title));
  });

  // Group websites by category
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
      ? peopleGroups.filter((g) => {
          const q = searchQuery.toLowerCase();
          const name = g.profile?.displayName || g.profile?.handle || g.did;
          return name.toLowerCase().includes(q) || g.did.toLowerCase().includes(q);
        })
      : peopleGroups
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
      .map((cat) => ({ ...cat, websites: filterWebsitesBySearch(cat.websites) }))
      .filter((cat) => cat.websites.length > 0)
  );

  let filteredUncategorizedWebsites = $derived(filterWebsitesBySearch(uncategorizedWebsites));

  // -- Selection --
  let allVisibleIds = $derived.by(() => {
    const ids: number[] = [];
    if (activeTab === 'people') {
      for (const g of filteredPeople) {
        for (const s of g.subscriptions) {
          if (s.id) ids.push(s.id);
        }
      }
    } else {
      for (const s of filteredWebsites) {
        if (s.id) ids.push(s.id);
      }
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

  // -- Subscribe/unsubscribe for AT Proto content streams --
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
      await subscriptionsStore.updateLocal(subId, { customIconUrl: pub.iconUrl });
    }
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

  // -- Bulk operations --
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
    await subscriptionsStore.bulkUpdateLocal([...selectedIds], { category: folderName });
    selectedIds = new Set();
  }

  async function removeFromFolder() {
    await subscriptionsStore.bulkUpdateLocal([...selectedIds], { category: null });
    selectedIds = new Set();
  }

  // -- Fetch profiles and detected content on mount --
  onMount(async () => {
    const dids = [
      ...new Set(
        subscriptionsStore.subscriptions.filter((s) => s.subjectDid).map((s) => s.subjectDid!)
      ),
    ];
    if (dids.length === 0) return;

    const cache = loadContentCache();
    const initial = new Map<string, DetectedContent>();
    for (const did of dids) {
      const cached = cache.get(did);
      if (cached) {
        initial.set(did, { ...cached, loading: false });
      }
    }
    detectedContent = initial;

    const fetched = await profileService.getProfiles(dids);
    profiles = fetched;

    for (const did of dids) {
      if (!detectedContent.has(did)) {
        const next = new Map(detectedContent);
        next.set(did, {
          publications: [],
          loading: true,
        });
        detectedContent = next;
      }

      api
        .detectContent(did)
        .then((result) => {
          const content = {
            publications: result.publications,
          };
          saveContentCache(did, content);
          const updated = new Map(detectedContent);
          updated.set(did, { ...content, loading: false });
          detectedContent = updated;
        })
        .catch(() => {
          if (!detectedContent.has(did)) {
            const updated = new Map(detectedContent);
            updated.set(did, {
              publications: [],
              loading: false,
            });
            detectedContent = updated;
          }
        });
    }
  });
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

  <!-- Tab bar -->
  <div class="tab-bar">
    <button class="tab" class:active={activeTab === 'people'} onclick={() => switchTab('people')}>
      <Icon name="users" size={16} />
      People
      {#if peopleGroups.length > 0}
        <span class="tab-count">{peopleGroups.length}</span>
      {/if}
    </button>
    <button
      class="tab"
      class:active={activeTab === 'websites'}
      onclick={() => switchTab('websites')}
    >
      <Icon name="globe" size={16} />
      Websites
      {#if websites.length > 0}
        <span class="tab-count">{websites.length}</span>
      {/if}
    </button>
  </div>

  <!-- People tab -->
  {#if activeTab === 'people'}
    {#if filteredPeople.length > 0}
      <a class="discover-link" href="/sources/discover">
        <Icon name="users" size={14} />
        Discover linkblogs to follow
        <Icon name="chevron-right" size={14} />
      </a>
      <div class="select-all-row">
        <label class="checkbox-label">
          <input type="checkbox" checked={allSelected} onchange={toggleSelectAll} />
          <span class="select-all-text">Select all</span>
        </label>
      </div>

      <div class="source-list">
        {#each filteredPeople as group (group.did)}
          {@const detected = detectedContent.get(group.did)}
          {@const handle = getPersonHandle(group)}
          {@const avatarUrl = group.profile?.avatar ?? null}

          <SourceGroupHeader
            {avatarUrl}
            displayName={getPersonName(group)}
            {handle}
            totalUnread={group.totalUnread}
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

          <!-- Subscribed content streams -->
          {#each group.subscriptions as sub (sub.rkey)}
            {@const display = getSourceDisplay(sub.sourceType, sub.feedUrl)}
            {@const subUnread = sub.id ? (unreadCounts.feedCounts.get(sub.id) ?? 0) : 0}
            <SourceRow
              iconUrl={sub.customIconUrl || avatarUrl}
              iconRound={!sub.customIconUrl}
              title={sub.customTitle || sub.title}
              subtitle={'@' + handle}
              sourceLabel={display.label}
              pillClass={display.pillClass}
              unreadCount={subUnread}
              subscribed={true}
              selected={sub.id != null && selectedIds.has(sub.id)}
              fallbackIcon={display.iconName}
              onToggleSelect={() => sub.id && toggleSelect(sub.id)}
              onRemove={() => handleRemove(sub)}
              onEdit={sub.sourceType === 'atproto.documents' ? () => handleEdit(sub) : null}
            />
          {/each}

          <!-- Unsubscribed content streams -->
          {#if detected && !detected.loading}
            {#each detected.publications as pub (pub.uri)}
              {#if !group.subscriptions.some((s) => s.sourceType === 'atproto.documents' && s.feedUrl === pub.uri)}
                <SourceRow
                  iconUrl={pub.iconUrl || avatarUrl}
                  iconRound={!pub.iconUrl}
                  title={pub.name || pub.url}
                  subtitle={pub.description || pub.url}
                  sourceLabel="Publication"
                  pillClass="pill-publication"
                  subscribed={false}
                  fallbackIcon="standard-site"
                  onSubscribe={() => subscribePublication(group.did, pub)}
                />
              {/if}
            {/each}
          {/if}

          {#if detected?.loading}
            <div class="content-type-loading">
              <span class="spinner-small"></span>
              <span>Detecting content...</span>
            </div>
          {/if}
        {/each}
      </div>
    {:else if searchQuery}
      <div class="empty-state">
        <p>No people match "{searchQuery}"</p>
      </div>
    {:else}
      <div class="people-onboarding">
        <p class="onboarding-lead">
          Follow a @handle to get started — or follow the linkblogs of people you already know on
          Bluesky:
        </p>
        <LinkblogDiscovery variant="friends" />
        <a class="discover-link standalone" href="/sources/discover">
          Browse all linkblogs
          <Icon name="chevron-right" size={14} />
        </a>
      </div>
    {/if}
  {/if}

  <!-- Websites tab -->
  {#if activeTab === 'websites'}
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
              {@const display = getSourceDisplay(sub.sourceType, sub.feedUrl)}
              {@const feedCount = sub.id ? (unreadCounts.feedCounts.get(sub.id) ?? 0) : 0}
              {@const status = sub.feedUrl ? feedStatusStore.getStatus(sub.feedUrl) : undefined}
              <SourceRow
                iconUrl={getFaviconUrl(sub)}
                title={sub.customTitle || sub.title}
                subtitle={getSubtitle(sub)}
                sourceLabel={display.label}
                pillClass={display.pillClass}
                unreadCount={feedCount}
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
            {@const display = getSourceDisplay(sub.sourceType, sub.feedUrl)}
            {@const feedCount = sub.id ? (unreadCounts.feedCounts.get(sub.id) ?? 0) : 0}
            {@const status = sub.feedUrl ? feedStatusStore.getStatus(sub.feedUrl) : undefined}
            <SourceRow
              iconUrl={getFaviconUrl(sub)}
              title={sub.customTitle || sub.title}
              subtitle={getSubtitle(sub)}
              sourceLabel={display.label}
              pillClass={display.pillClass}
              unreadCount={feedCount}
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
    {:else}
      <div class="empty-state">
        {#if searchQuery}
          <p>No websites match "{searchQuery}"</p>
        {:else}
          <p>No websites yet. Add an RSS feed to get started.</p>
        {/if}
      </div>
    {/if}
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

  .tab-bar {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--color-border);
    margin-bottom: 1rem;
  }

  .tab {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.625rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--color-text-secondary);
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    transition:
      color 0.15s,
      border-color 0.15s;
  }

  .tab:hover {
    color: var(--color-text-primary);
  }

  .tab.active {
    color: var(--color-primary);
    border-bottom-color: var(--color-primary);
  }

  .tab-count {
    font-size: 0.75rem;
    font-weight: 400;
    color: var(--color-text-secondary);
  }

  .tab.active .tab-count {
    color: var(--color-primary);
  }

  .select-all-row {
    padding: 0 0.25rem 0.5rem;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-size: 0.75rem;
    color: var(--color-text-secondary);
  }

  .select-all-text {
    user-select: none;
  }

  .group-count {
    font-weight: 400;
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
    font-size: 0.75rem;
    font-weight: 600;
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
    font-size: 0.75rem;
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

  .empty-state {
    text-align: center;
    padding: 3rem 1rem;
    color: var(--color-text-secondary);
    font-size: 0.875rem;
  }

  .discover-link {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--color-primary);
    text-decoration: none;
    padding: 0.5rem 0;
  }

  .discover-link:hover {
    text-decoration: underline;
  }

  .discover-link.standalone {
    margin-top: 0.75rem;
  }

  .people-onboarding {
    padding: 0.5rem 0 2rem;
  }

  .onboarding-lead {
    font-size: 0.875rem;
    color: var(--color-text-secondary);
    line-height: 1.5;
    margin: 0 0 1rem;
    max-width: 52ch;
  }
</style>
