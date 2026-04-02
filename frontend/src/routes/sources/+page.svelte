<script lang="ts">
  import { goto } from '$app/navigation';
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
  import Icon from '$lib/components/Icon.svelte';
  import FeedPageHeader from '$lib/components/feed/FeedPageHeader.svelte';
  import MobileBottomBar from '$lib/components/feed/MobileBottomBar.svelte';
  import MobileFeedSwitcher from '$lib/components/feed/MobileFeedSwitcher.svelte';
  import BottomSheet from '$lib/components/common/BottomSheet.svelte';
  import EditFeedModal from '$lib/components/EditFeedModal.svelte';
  import AddFeedModal from '$lib/components/AddFeedModal.svelte';
  import AddHandleModal from '$lib/components/AddHandleModal.svelte';
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

  let feedSwitcherOpen = $state(false);

  let searchQuery = $state('');
  let editingSubscription = $state<Subscription | null>(null);
  let editModalOpen = $state(false);
  let selectedIds = $state<Set<number>>(new Set());
  let profiles = $state<Map<string, BlueskyProfile>>(new Map());
  let assignChannelOpen = $state(false);
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

  // Group AT Protocol subscriptions by person (DID)
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

  // Filtering
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

  // Selection helpers
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
    if (allSelected) {
      selectedIds = new Set();
    } else {
      selectedIds = new Set(allVisibleIds);
    }
  }

  function toggleSelect(id: number) {
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    selectedIds = next;
  }

  function togglePersonSelect(group: PersonGroup) {
    const ids = group.subscriptions.map((s) => s.id!).filter(Boolean);
    const allIn = ids.every((id) => selectedIds.has(id));
    const next = new Set(selectedIds);
    if (allIn) {
      ids.forEach((id) => next.delete(id));
    } else {
      ids.forEach((id) => next.add(id));
    }
    selectedIds = next;
  }

  // Toggle subscription for a specific content stream
  async function toggleShares(group: PersonGroup) {
    const existing = group.subscriptions.find((s) => s.sourceType === 'atproto.shares');
    if (existing?.id) {
      await subscriptionsStore.remove(existing.id);
    } else {
      await subscriptionsStore.add(undefined, `Shares from @${getPersonHandle(group)}`, {
        sourceType: 'atproto.shares',
        subjectDid: group.did,
      });
    }
  }

  async function toggleFreestandingDocs(group: PersonGroup) {
    const existing = group.subscriptions.find(
      (s) => s.sourceType === 'atproto.documents' && s.feedUrl === '__freestanding__'
    );
    if (existing?.id) {
      await subscriptionsStore.remove(existing.id);
    } else {
      await subscriptionsStore.add(
        '__freestanding__',
        `Documents from @${getPersonHandle(group)}`,
        {
          sourceType: 'atproto.documents',
          subjectDid: group.did,
          feedUrl: '__freestanding__',
        }
      );
    }
  }

  async function togglePublication(group: PersonGroup, pub: DetectedPublication) {
    const existing = group.subscriptions.find(
      (s) => s.sourceType === 'atproto.documents' && s.feedUrl === pub.uri
    );
    if (existing?.id) {
      await subscriptionsStore.remove(existing.id);
    } else {
      const subId = await subscriptionsStore.add(pub.uri, pub.name || pub.url, {
        sourceType: 'atproto.documents',
        subjectDid: group.did,
        siteUrl: pub.url,
        feedUrl: pub.uri,
      });
      if (pub.iconUrl) {
        await subscriptionsStore.updateLocal(subId, { customIconUrl: pub.iconUrl });
      }
    }
  }

  function getSubscriptionForFeedUrl(
    group: PersonGroup,
    feedUrl: string
  ): Subscription | undefined {
    return group.subscriptions.find(
      (s) => s.sourceType === 'atproto.documents' && s.feedUrl === feedUrl
    );
  }

  // Bulk operations
  async function bulkDelete() {
    const count = selectionCount;
    if (!confirm(`Remove ${count} source${count > 1 ? 's' : ''}?`)) return;
    const ids = [...selectedIds];
    for (const id of ids) {
      await subscriptionsStore.remove(id);
    }
    selectedIds = new Set();
  }

  function bulkAssignToChannel() {
    assignChannelOpen = !assignChannelOpen;
  }

  async function assignToChannel(channelId: number) {
    const channel = filteredViewsStore.getById(channelId);
    if (!channel) return;

    const currentKeys = new Set(channel.sourceKeys || []);
    for (const id of selectedIds) {
      const sub = subscriptionsStore.getById(id);
      if (!sub) continue;
      if (!sub.sourceType || sub.sourceType === 'rss') {
        currentKeys.add(rssSourceKey(id));
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
    assignChannelOpen = false;
    selectedIds = new Set();
  }

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

  function getPersonName(group: PersonGroup): string {
    return group.profile?.displayName || group.profile?.handle || group.did;
  }

  function getPersonHandle(group: PersonGroup): string {
    return group.profile?.handle || group.did;
  }

  // Fetch profiles and detected content on mount
  onMount(async () => {
    const dids = [
      ...new Set(
        subscriptionsStore.subscriptions.filter((s) => s.subjectDid).map((s) => s.subjectDid!)
      ),
    ];
    if (dids.length === 0) return;

    // 1. Immediately populate from cache
    const cache = loadContentCache();
    const initial = new Map<string, DetectedContent>();
    for (const did of dids) {
      const cached = cache.get(did);
      if (cached) {
        initial.set(did, { ...cached, loading: false });
      }
    }
    detectedContent = initial;

    // Fetch profiles
    const fetched = await profileService.getProfiles(dids);
    profiles = fetched;

    // 2. Refresh from API in background
    for (const did of dids) {
      // Mark as loading only if we don't already have cached data
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
          // On failure, keep cached data if we have it
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
  <div class="sources-toolbar">
    <div class="search-wrapper">
      <Icon name="search" size={16} />
      <input
        type="text"
        bind:value={searchQuery}
        placeholder="Search sources..."
        class="search-input"
      />
    </div>
    <button class="add-btn" onclick={() => sidebarStore.openAddFeedModal()}>
      <Icon name="plus" size={16} />
      <span>Add RSS</span>
    </button>
    <button class="add-btn" onclick={() => sidebarStore.openAddHandleModal()}>
      <Icon name="at-sign" size={16} />
      <span>Add @handle</span>
    </button>
  </div>

  <!-- Bulk action bar -->
  {#if selectionCount > 0}
    <div class="bulk-bar">
      <span class="bulk-count">{selectionCount} selected</span>
      <div class="bulk-actions">
        <div class="assign-wrapper">
          <button class="bulk-btn" onclick={bulkAssignToChannel}>
            <Icon name="filter" size={14} />
            Add to channel
          </button>
          {#if assignChannelOpen && filteredViewsStore.views.length > 0}
            <div class="assign-dropdown">
              {#each filteredViewsStore.views as view (view.id)}
                <button
                  class="assign-item"
                  onclick={() => view.id != null && assignToChannel(view.id)}
                >
                  {view.name}
                </button>
              {/each}
            </div>
          {/if}
        </div>
        <button class="bulk-btn danger" onclick={bulkDelete}>
          <Icon name="trash" size={14} />
          Remove
        </button>
      </div>
      <button class="bulk-clear" onclick={() => (selectedIds = new Set())}>
        <Icon name="x" size={14} />
      </button>
    </div>
  {/if}

  <!-- Select all -->
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
          {@const sharesSub = group.subscriptions.find((s) => s.sourceType === 'atproto.shares')}
          {@const freestandingSub = group.subscriptions.find(
            (s) => s.sourceType === 'atproto.documents' && s.feedUrl === '__freestanding__'
          )}
          {@const sharesUnread = sharesSub?.id
            ? (unreadCounts.feedCounts.get(sharesSub.id) ?? 0)
            : 0}
          {@const freestandingUnread = freestandingSub?.id
            ? (unreadCounts.feedCounts.get(freestandingSub.id) ?? 0)
            : 0}
          <div class="person-card">
            <div class="person-header">
              <div class="source-icon">
                {#if group.profile?.avatar}
                  <img src={group.profile.avatar} alt="" class="avatar" />
                {:else}
                  <Icon name="user" size={16} />
                {/if}
              </div>
              <div class="source-info">
                <span class="source-title">{getPersonName(group)}</span>
                <span class="source-meta">@{getPersonHandle(group)}</span>
              </div>
              <div class="source-actions">
                <button
                  class="action-btn danger"
                  onclick={async () => {
                    if (confirm(`Remove all subscriptions for ${getPersonName(group)}?`)) {
                      await Promise.all(
                        group.subscriptions
                          .filter((s) => s.id != null)
                          .map((s) => subscriptionsStore.remove(s.id!))
                      );
                    }
                  }}
                  title="Remove all"
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
            </div>
            <div class="person-content-types">
              {#if detected?.loading}
                <div class="content-type-loading">
                  <span class="spinner-small"></span>
                  <span>Detecting content...</span>
                </div>
              {:else}
                <!-- Shares -->
                <div class="content-type-row">
                  <label class="row-checkbox">
                    <input
                      type="checkbox"
                      checked={sharesSub?.id != null && selectedIds.has(sharesSub.id)}
                      disabled={!sharesSub?.id}
                      onchange={() => sharesSub?.id && toggleSelect(sharesSub.id)}
                    />
                  </label>
                  <div class="content-type-info">
                    <div class="content-type-label">
                      <Icon name="share" size={14} />
                      <span class="content-type-name">Skyreader Shares</span>
                      {#if detected && detected.shareCount > 0}
                        <span class="content-count">({detected.shareCount})</span>
                      {/if}
                      {#if sharesUnread > 0}
                        <span class="unread-badge">{sharesUnread}</span>
                      {/if}
                    </div>
                    <span class="content-type-desc"
                      >Articles they share and recommend on Skyreader</span
                    >
                  </div>
                  <button
                    class="subscribed-toggle"
                    class:active={group.hasShares}
                    onclick={() => toggleShares(group)}
                    title={group.hasShares ? 'Unsubscribe from shares' : 'Subscribe to shares'}
                  >
                    <span class="toggle-track">
                      <span class="toggle-thumb"></span>
                    </span>
                    <span class="toggle-label">{group.hasShares ? 'Subscribed' : 'Subscribe'}</span>
                  </button>
                </div>

                <!-- Freestanding documents -->
                {#if freestandingSub || (detected && detected.freestandingDocumentCount > 0)}
                  <div class="content-type-row">
                    <label class="row-checkbox">
                      <input
                        type="checkbox"
                        checked={freestandingSub?.id != null && selectedIds.has(freestandingSub.id)}
                        disabled={!freestandingSub?.id}
                        onchange={() => freestandingSub?.id && toggleSelect(freestandingSub.id)}
                      />
                    </label>
                    <div class="content-type-info">
                      <div class="content-type-label">
                        <Icon name="file-text" size={14} />
                        <span class="content-type-name">Documents</span>
                        {#if detected && detected.freestandingDocumentCount > 0}
                          <span class="content-count">({detected.freestandingDocumentCount})</span>
                        {/if}
                        {#if freestandingUnread > 0}
                          <span class="unread-badge">{freestandingUnread}</span>
                        {/if}
                      </div>
                      <span class="content-type-desc"
                        >Free-standing documents by @{getPersonHandle(group)}</span
                      >
                    </div>
                    <button
                      class="subscribed-toggle"
                      class:active={!!freestandingSub}
                      onclick={() => toggleFreestandingDocs(group)}
                      title={freestandingSub
                        ? 'Unsubscribe from documents'
                        : 'Subscribe to documents'}
                    >
                      <span class="toggle-track">
                        <span class="toggle-thumb"></span>
                      </span>
                      <span class="toggle-label"
                        >{freestandingSub ? 'Subscribed' : 'Subscribe'}</span
                      >
                    </button>
                  </div>
                {/if}

                <!-- Publications -->
                {#if detected && detected.publications.length > 0}
                  {#each detected.publications as pub (pub.uri)}
                    {@const pubSub = getSubscriptionForFeedUrl(group, pub.uri)}
                    {@const pubUnread = pubSub?.id
                      ? (unreadCounts.feedCounts.get(pubSub.id) ?? 0)
                      : 0}
                    <div class="content-type-row">
                      <label class="row-checkbox">
                        <input
                          type="checkbox"
                          checked={pubSub?.id != null && selectedIds.has(pubSub.id)}
                          disabled={!pubSub?.id}
                          onchange={() => pubSub?.id && toggleSelect(pubSub.id)}
                        />
                      </label>
                      <div class="content-type-info">
                        <div class="content-type-label">
                          {#if pub.iconUrl}
                            <img src={pub.iconUrl} alt="" class="pub-icon" />
                          {:else}
                            <Icon name="newspaper" size={14} />
                          {/if}
                          <span class="content-type-name">{pub.name || pub.url}</span>
                          {#if pubUnread > 0}
                            <span class="unread-badge">{pubUnread}</span>
                          {/if}
                        </div>
                        {#if pub.description}
                          <span class="content-type-desc">{pub.description}</span>
                        {:else if pub.url}
                          <span class="content-type-desc">{pub.url}</span>
                        {/if}
                      </div>
                      <button
                        class="subscribed-toggle"
                        class:active={!!pubSub}
                        onclick={() => togglePublication(group, pub)}
                        title={pubSub ? `Unsubscribe from ${pub.name}` : `Subscribe to ${pub.name}`}
                      >
                        <span class="toggle-track">
                          <span class="toggle-thumb"></span>
                        </span>
                        <span class="toggle-label">{pubSub ? 'Subscribed' : 'Subscribe'}</span>
                      </button>
                    </div>
                  {/each}
                {/if}
              {/if}
            </div>
          </div>
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
          {@const favicon = getFaviconUrl(sub)}
          {@const feedCount = sub.id ? (unreadCounts.feedCounts.get(sub.id) ?? 0) : 0}
          {@const status = sub.feedUrl ? feedStatusStore.getStatus(sub.feedUrl) : undefined}
          <div class="source-row">
            <label class="row-checkbox">
              <input
                type="checkbox"
                checked={sub.id != null && selectedIds.has(sub.id)}
                onchange={() => sub.id && toggleSelect(sub.id)}
              />
            </label>
            <div class="source-icon">
              {#if favicon}
                <img src={favicon} alt="" class="favicon" />
              {:else}
                <Icon name="rss" size={16} />
              {/if}
            </div>
            <div class="source-info">
              <span class="source-title">{sub.customTitle || sub.title}</span>
              <span class="source-meta">
                {#if sub.siteUrl}
                  {new URL(sub.siteUrl).hostname}
                {:else if sub.feedUrl}
                  {new URL(sub.feedUrl).hostname}
                {/if}
              </span>
            </div>
            {#if status?.status === 'error' || status?.status === 'circuit-open'}
              <span class="error-badge" title="Feed error">
                <Icon name="alert-triangle" size={14} />
              </span>
            {/if}
            {#if feedCount > 0}
              <span class="unread-badge">{feedCount}</span>
            {/if}
            <div class="source-actions">
              <button class="action-btn" onclick={() => handleEdit(sub)} title="Edit">
                <Icon name="edit" size={14} />
              </button>
              <button
                class="action-btn"
                onclick={() => fetchSingleFeed(sub, true, articlesStore.savedGuids)}
                title="Refresh"
              >
                <Icon name="refresh-cw" size={14} />
              </button>
              <button class="action-btn danger" onclick={() => handleRemove(sub)} title="Remove">
                <Icon name="trash" size={14} />
              </button>
            </div>
          </div>
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

  .sources-toolbar {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-bottom: 1rem;
  }

  @media (max-width: 1000px) {
    .sources-page {
      padding-top: 0.5rem;
      padding-bottom: calc(var(--bottom-bar-height) + var(--safe-area-bottom) + 1rem);
    }
  }

  .search-wrapper {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: var(--color-bg-secondary, rgba(0, 0, 0, 0.04));
    border-radius: 8px;
    padding: 0.5rem 0.75rem;
    color: var(--color-text-secondary);
  }

  .search-input {
    flex: 1;
    border: none;
    background: none;
    font: inherit;
    font-size: 0.875rem;
    color: var(--color-text);
    outline: none;
  }

  .search-input::placeholder {
    color: var(--color-text-secondary);
  }

  .add-btn {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: none;
    cursor: pointer;
    font-size: 0.8125rem;
    color: var(--color-text);
    white-space: nowrap;
  }

  .add-btn:hover {
    background: var(--color-bg-hover);
  }

  /* Bulk action bar */
  .bulk-bar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
    background: var(--color-primary);
    color: #fff;
    border-radius: 10px;
    margin-bottom: 1rem;
    font-size: 0.8125rem;
  }

  .bulk-count {
    font-weight: 500;
  }

  .bulk-actions {
    display: flex;
    gap: 0.375rem;
    flex: 1;
  }

  .bulk-btn {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0.5rem;
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 6px;
    background: none;
    color: #fff;
    cursor: pointer;
    font-size: 0.75rem;
  }

  .bulk-btn:hover {
    background: rgba(255, 255, 255, 0.15);
  }

  .bulk-btn.danger:hover {
    background: rgba(220, 38, 38, 0.3);
  }

  .bulk-clear {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.7);
    cursor: pointer;
    padding: 0.25rem;
    display: flex;
    align-items: center;
    border-radius: 4px;
  }

  .bulk-clear:hover {
    color: #fff;
  }

  .assign-wrapper {
    position: relative;
  }

  .assign-dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    margin-top: 0.25rem;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    padding: 0.25rem;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    z-index: 100;
    min-width: 160px;
  }

  .assign-item {
    display: block;
    width: 100%;
    padding: 0.375rem 0.5rem;
    border: none;
    background: none;
    text-align: left;
    cursor: pointer;
    font-size: 0.8125rem;
    color: var(--color-text);
    border-radius: 4px;
  }

  .assign-item:hover {
    background: var(--color-bg-hover);
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

  /* Source groups */
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
    overflow: hidden;
  }

  .source-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem 0.75rem;
    background: var(--color-bg);
    transition: background-color 0.15s;
  }

  .source-row:hover {
    background: var(--color-bg-hover, rgba(0, 0, 0, 0.02));
  }

  .row-checkbox {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    cursor: pointer;
  }

  .row-checkbox input {
    cursor: pointer;
  }

  .source-icon {
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-secondary);
  }

  .favicon {
    width: 20px;
    height: 20px;
    border-radius: 4px;
  }

  .avatar {
    width: 24px;
    height: 24px;
    border-radius: 50%;
  }

  .source-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .source-title {
    font-size: 0.875rem;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .source-meta {
    font-size: 0.75rem;
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Person card layout */
  .person-card {
    background: var(--color-bg);
    padding: 0.75rem;
  }

  .person-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.625rem;
  }

  .person-content-types {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding-left: 2.25rem;
  }

  .content-type-row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.375rem 0.5rem;
    border-radius: 8px;
    background: var(--color-bg-secondary, rgba(0, 0, 0, 0.02));
  }

  .content-type-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .content-type-label {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--color-text);
  }

  .content-type-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .content-type-desc {
    font-size: 0.6875rem;
    color: var(--color-text-secondary);
    line-height: 1.3;
  }

  .content-count {
    font-weight: 400;
    color: var(--color-text-secondary);
    font-size: 0.75rem;
  }

  .pub-icon {
    width: 14px;
    height: 14px;
    border-radius: 3px;
    flex-shrink: 0;
  }

  .content-type-loading {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem;
    font-size: 0.75rem;
    color: var(--color-text-secondary);
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

  /* Subscribe toggle switch */
  .subscribed-toggle {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    background: none;
    border: none;
    cursor: pointer;
    flex-shrink: 0;
    padding: 0.25rem;
  }

  .toggle-track {
    display: block;
    width: 28px;
    height: 16px;
    border-radius: 8px;
    background: var(--color-border);
    position: relative;
    transition: background-color 0.2s;
  }

  .subscribed-toggle.active .toggle-track {
    background: var(--color-primary);
  }

  .toggle-thumb {
    display: block;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: white;
    position: absolute;
    top: 2px;
    left: 2px;
    transition: transform 0.2s;
  }

  .subscribed-toggle.active .toggle-thumb {
    transform: translateX(12px);
  }

  .toggle-label {
    font-size: 0.6875rem;
    color: var(--color-text-secondary);
    white-space: nowrap;
  }

  .subscribed-toggle.active .toggle-label {
    color: var(--color-primary);
  }

  .unread-badge {
    flex-shrink: 0;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--color-primary);
    background: rgba(0, 102, 204, 0.1);
    padding: 0.125rem 0.375rem;
    border-radius: 10px;
  }

  .error-badge {
    flex-shrink: 0;
    color: var(--color-error, #dc2626);
    display: flex;
    align-items: center;
  }

  .source-actions {
    display: flex;
    gap: 0.25rem;
    opacity: 0;
    transition: opacity 0.15s;
  }

  .source-row:hover .source-actions {
    opacity: 1;
  }

  .action-btn {
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.25rem;
    border-radius: 4px;
    color: var(--color-text-secondary);
    display: flex;
    align-items: center;
  }

  .action-btn:hover {
    background: var(--color-bg-hover);
    color: var(--color-text);
  }

  .action-btn.danger:hover {
    color: var(--color-error, #dc2626);
  }

  .empty-state {
    text-align: center;
    padding: 3rem 1rem;
    color: var(--color-text-secondary);
    font-size: 0.875rem;
  }

  @media (max-width: 640px) {
    .source-actions {
      opacity: 1;
    }

    .sources-toolbar {
      flex-wrap: wrap;
    }

    .add-btn span {
      display: none;
    }

    .person-content-types {
      padding-left: 0;
    }

    .content-type-row {
      flex-wrap: wrap;
    }

    .toggle-label {
      display: none;
    }
  }

  @media (prefers-color-scheme: dark) {
    .content-type-row {
      background: var(--color-bg-secondary, rgba(255, 255, 255, 0.04));
    }

    .source-row:hover,
    .person-card:hover {
      background: var(--color-bg-hover, rgba(255, 255, 255, 0.03));
    }

    .search-wrapper {
      background: var(--color-bg-secondary, rgba(255, 255, 255, 0.06));
    }

    .assign-dropdown {
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }
  }
</style>
