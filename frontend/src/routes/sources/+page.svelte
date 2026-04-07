<script lang="ts">
  import { onMount } from 'svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { feedStatusStore } from '$lib/stores/feedStatus.svelte';
  import { unreadCounts } from '$lib/stores/unreadCounts.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { filteredViewsStore } from '$lib/stores/filteredViews.svelte';
  import { fetchSingleFeed } from '$lib/services/feedFetcher';
  import { articlesStore } from '$lib/stores/articles.svelte';
  import { profileService } from '$lib/services/profiles';
  import { api } from '$lib/services/api';
  import { mobileStore } from '$lib/stores/mediaQuery.svelte';
  import { rssSourceKey, sharesSourceKey, documentsSourceKey } from '$lib/utils/sourceKeys';
  import { getSourceDisplay } from '$lib/utils/sourceDisplay';
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
    shareCount: number;
    freestandingDocumentCount: number;
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
    hasShares: boolean;
    hasDocuments: boolean;
    totalUnread: number;
  }

  let peopleGroups = $derived.by((): PersonGroup[] => {
    const byDid = new Map<string, Subscription[]>();
    for (const sub of subscriptionsStore.subscriptions) {
      if (!sub.subjectDid) continue;
      if (
        sub.sourceType === 'atproto.shares' ||
        sub.sourceType === 'atproto.documents' ||
        sub.sourceType === 'atproto.collection'
      ) {
        const existing = byDid.get(sub.subjectDid) || [];
        existing.push(sub);
        byDid.set(sub.subjectDid, existing);
      }
    }

    const groups: PersonGroup[] = [];
    for (const [did, subs] of byDid) {
      const hasShares = subs.some((s) => s.sourceType === 'atproto.shares');
      const hasDocuments = subs.some((s) => s.sourceType === 'atproto.documents');
      const totalUnread = subs.reduce(
        (sum, s) => sum + (s.id ? (unreadCounts.feedCounts.get(s.id) ?? 0) : 0),
        0
      );
      groups.push({
        did,
        profile: profiles.get(did) || null,
        subscriptions: subs,
        hasShares,
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

  // -- Selection --
  let allVisibleIds = $derived.by(() => {
    const ids: number[] = [];
    for (const g of filteredPeople) {
      for (const s of g.subscriptions) {
        if (s.id) ids.push(s.id);
      }
    }
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

  // -- Subscribe/unsubscribe for AT Proto content streams --
  function getPersonHandle(group: PersonGroup): string {
    return group.profile?.handle || group.did;
  }

  function getPersonName(group: PersonGroup): string {
    return group.profile?.displayName || group.profile?.handle || group.did;
  }

  async function subscribeShares(did: string, handle: string) {
    await subscriptionsStore.add(undefined, `Shares from @${handle}`, {
      sourceType: 'atproto.shares',
      subjectDid: did,
    });
  }

  async function subscribeFreestandingDocs(did: string, handle: string) {
    await subscriptionsStore.add('__freestanding__', `Documents from @${handle}`, {
      sourceType: 'atproto.documents',
      subjectDid: did,
      feedUrl: '__freestanding__',
    });
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
    if (!url || url === '__freestanding__') return null;
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

  async function assignToChannel(channelId: number) {
    const channel = filteredViewsStore.getById(channelId);
    if (!channel) return;

    const currentKeys = new Set(channel.sourceKeys || []);
    for (const id of selectedIds) {
      const sub = subscriptionsStore.getById(id);
      if (!sub?.rkey) continue;
      if (!sub.sourceType || sub.sourceType === 'rss') {
        currentKeys.add(rssSourceKey(sub.rkey));
      } else if (sub.sourceType === 'atproto.shares' && sub.subjectDid) {
        currentKeys.add(sharesSourceKey(sub.subjectDid));
      } else if (sub.sourceType === 'atproto.documents' && sub.subjectDid) {
        currentKeys.add(documentsSourceKey(sub.subjectDid));
      }
    }

    await filteredViewsStore.update(channelId, {
      sourceMode: 'include',
      sourceKeys: [...currentKeys],
    });
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
          shareCount: 0,
          freestandingDocumentCount: 0,
          loading: true,
        });
        detectedContent = next;
      }

      api
        .detectContent(did)
        .then((result) => {
          const content = {
            publications: result.publications,
            shareCount: result.shareCount,
            freestandingDocumentCount: result.freestandingDocumentCount,
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
              shareCount: 0,
              freestandingDocumentCount: 0,
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
      channels={filteredViewsStore.views}
      onAssignToChannel={assignToChannel}
      onBulkDelete={bulkDelete}
      onClearSelection={() => (selectedIds = new Set())}
    />
  {/if}

  {#if filteredPeople.length > 0 || filteredWebsites.length > 0}
    <div class="select-all-row">
      <label class="checkbox-label">
        <input type="checkbox" checked={allSelected} onchange={toggleSelectAll} />
        <span class="select-all-text">Select all</span>
      </label>
    </div>
  {/if}

  <!-- People section -->
  {#if filteredPeople.length > 0}
    <section class="source-group">
      <h2 class="group-title">
        <Icon name="users" size={16} />
        People
        <span class="group-count">{filteredPeople.length}</span>
      </h2>
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
              onEdit={sub.sourceType === 'atproto.documents' && sub.feedUrl !== '__freestanding__'
                ? () => handleEdit(sub)
                : null}
            />
          {/each}

          <!-- Unsubscribed content streams -->
          {#if !group.hasShares}
            <SourceRow
              iconUrl={avatarUrl}
              iconRound={true}
              title="Skyreader Shares"
              subtitle={detected && !detected.loading && detected.shareCount > 0
                ? `Articles they share and recommend (${detected.shareCount})`
                : 'Articles they share and recommend on Skyreader'}
              sourceLabel="Shares"
              pillClass="pill-shares"
              subscribed={false}
              fallbackIcon="share"
              onSubscribe={() => subscribeShares(group.did, handle)}
            />
          {/if}

          {#if detected && !detected.loading}
            {#if !group.subscriptions.some((s) => s.sourceType === 'atproto.documents' && s.feedUrl === '__freestanding__') && detected.freestandingDocumentCount > 0}
              <SourceRow
                iconUrl={avatarUrl}
                iconRound={true}
                title="Documents"
                subtitle="Free-standing documents by @{handle} ({detected.freestandingDocumentCount})"
                sourceLabel="Documents"
                pillClass="pill-documents"
                subscribed={false}
                fallbackIcon="file-text"
                onSubscribe={() => subscribeFreestandingDocs(group.did, handle)}
              />
            {/if}

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
                  fallbackIcon="newspaper"
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
    </section>
  {/if}

  <!-- Websites section -->
  {#if filteredWebsites.length > 0}
    <section class="source-group">
      <h2 class="group-title">
        <Icon name="globe" size={16} />
        Websites
        <span class="group-count">{filteredWebsites.length}</span>
      </h2>
      <div class="source-list">
        {#each filteredWebsites as sub (sub.id)}
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
    </section>
  {/if}

  {#if filteredPeople.length === 0 && filteredWebsites.length === 0}
    <div class="empty-state">
      {#if searchQuery}
        <p>No sources match "{searchQuery}"</p>
      {:else}
        <p>No sources yet. Add an RSS feed or follow a @handle to get started.</p>
      {/if}
    </div>
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
    padding: 3.5rem 1rem 1.5rem;
  }

  @media (max-width: 1000px) {
    .sources-page {
      padding-top: 0.5rem;
      padding-bottom: calc(var(--bottom-bar-height) + var(--safe-area-bottom) + 1rem);
    }
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

  .source-group {
    margin-bottom: 1.5rem;
  }

  .group-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8125rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--color-text-secondary);
    margin: 0 0 0.5rem;
    padding: 0 0.25rem;
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
</style>
