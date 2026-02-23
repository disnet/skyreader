<script lang="ts">
  import { searchBlueskyActors, type BlueskySearchResult } from '$lib/services/blueskySearch';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { socialStore } from '$lib/stores/social.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { api } from '$lib/services/api';
  import Modal from '$lib/components/common/Modal.svelte';

  interface Props {
    open: boolean;
    onclose: () => void;
  }

  let { open, onclose }: Props = $props();

  // Step state
  let step = $state<'search' | 'select'>('search');

  // Search state
  let userSearchQuery = $state('');
  let userSearchResults = $state<BlueskySearchResult[]>([]);
  let isUserSearching = $state(false);
  let userSearchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let searchInputEl = $state<HTMLInputElement | null>(null);

  // Selected user state
  let selectedUser = $state<BlueskySearchResult | null>(null);

  // Standard subscriptions state
  type StandardSub = {
    uri: string;
    publisherDid: string;
    publication: {
      uri: string;
      name: string;
      url: string;
      description?: string;
    };
  };

  let standardSubs = $state<StandardSub[]>([]);
  let isLoadingStandardSubs = $state(false);
  let standardSubsLoaded = $state(false);

  // Reactively track which standard sub publisher DIDs already have subscriptions
  let subscribedPublisherDids = $derived.by(() => {
    const dids = new Set<string>();
    for (const sub of subscriptionsStore.subscriptions) {
      if (sub.subjectDid) {
        dids.add(sub.subjectDid);
      }
    }
    return dids;
  });

  function parseAtUri(atUri: string): { did: string; collection: string; rkey: string } | null {
    const match = atUri.match(/^at:\/\/(did:[^/]+)\/([^/]+)\/([^/]+)$/);
    if (!match) return null;
    return { did: match[1], collection: match[2], rkey: match[3] };
  }

  async function resolvePdsUrl(did: string): Promise<string | null> {
    try {
      if (did.startsWith('did:plc:')) {
        const res = await fetch(`https://plc.directory/${did}`);
        if (!res.ok) return null;
        const doc = (await res.json()) as {
          service?: Array<{ id: string; type: string; serviceEndpoint: string }>;
        };
        const svc = doc.service?.find(
          (s) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer'
        );
        return svc?.serviceEndpoint || null;
      } else if (did.startsWith('did:web:')) {
        const domain = did.replace('did:web:', '');
        const res = await fetch(`https://${domain}/.well-known/did.json`);
        if (!res.ok) return null;
        const doc = (await res.json()) as {
          service?: Array<{ id: string; type: string; serviceEndpoint: string }>;
        };
        const svc = doc.service?.find(
          (s) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer'
        );
        return svc?.serviceEndpoint || null;
      }
      return null;
    } catch {
      return null;
    }
  }

  async function loadStandardSubscriptions() {
    if (standardSubsLoaded || isLoadingStandardSubs) return;
    isLoadingStandardSubs = true;
    try {
      const pdsUrl = auth.user?.pdsUrl;
      const did = auth.user?.did;
      if (!pdsUrl || !did) {
        standardSubs = [];
        return;
      }

      const params = new URLSearchParams({
        repo: did,
        collection: 'site.standard.graph.subscription',
        limit: '100',
      });
      const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`);
      if (!res.ok) {
        standardSubs = [];
        return;
      }
      const data = (await res.json()) as {
        records: Array<{ uri: string; value: { publication?: string } }>;
      };

      if (data.records.length === 0) {
        standardSubs = [];
        return;
      }

      const entries = data.records
        .map((r) => ({ uri: r.uri, pubUri: r.value.publication }))
        .filter((e): e is { uri: string; pubUri: string } => !!e.pubUri)
        .map((e) => ({ ...e, parsed: parseAtUri(e.pubUri) }))
        .filter((e): e is typeof e & { parsed: NonNullable<typeof e.parsed> } => !!e.parsed);

      const uniqueDids = [...new Set(entries.map((e) => e.parsed.did))];
      const pdsCache = new Map<string, string | null>();
      await Promise.all(
        uniqueDids.map(async (d) => {
          pdsCache.set(d, await resolvePdsUrl(d));
        })
      );

      const results = await Promise.allSettled(
        entries.map(async (entry): Promise<StandardSub | null> => {
          const pubPds = pdsCache.get(entry.parsed.did);
          if (!pubPds) return null;

          const pubParams = new URLSearchParams({
            repo: entry.parsed.did,
            collection: entry.parsed.collection,
            rkey: entry.parsed.rkey,
          });
          const pubRes = await fetch(`${pubPds}/xrpc/com.atproto.repo.getRecord?${pubParams}`);
          if (!pubRes.ok) return null;

          const pubData = (await pubRes.json()) as {
            value: { name?: string; url?: string; description?: string };
          };
          const pub = pubData.value;
          if (!pub.url) return null;

          return {
            uri: entry.uri,
            publisherDid: entry.parsed.did,
            publication: {
              uri: entry.pubUri,
              name: pub.name || pub.url,
              url: pub.url,
              description: pub.description,
            },
          };
        })
      );

      standardSubs = results
        .filter((r): r is PromiseFulfilledResult<StandardSub | null> => r.status === 'fulfilled')
        .map((r) => r.value)
        .filter((s): s is StandardSub => s !== null);
    } catch {
      // Silently fail - these are just suggestions
    } finally {
      isLoadingStandardSubs = false;
      standardSubsLoaded = true;
    }
  }

  function handleSelectStandardSub(sub: StandardSub) {
    let handle = sub.publisherDid;
    try {
      handle = new URL(sub.publication.url).hostname;
    } catch {
      // use DID as fallback
    }
    selectUser({
      did: sub.publisherDid,
      handle,
      displayName: sub.publication.name,
      avatar: undefined,
    });
  }

  // Content detection state
  let isDetecting = $state(false);
  let detectError = $state<string | null>(null);
  let publications = $state<
    Array<{ uri: string; name: string; url: string; description?: string; iconUrl?: string }>
  >([]);
  let hasShares = $state(false);

  // Selection state
  let selectedPublications = $state<Set<string>>(new Set());
  let sharesSelected = $state(false);

  // Subscribe state
  let isSubscribing = $state(false);
  let subscribeError = $state<string | null>(null);
  let showLimitWarning = $state(false);

  // Check which items are already subscribed
  let subscribedKeys = $derived.by(() => {
    if (!selectedUser) return new Set<string>();
    const keys = new Set<string>();
    for (const sub of subscriptionsStore.subscriptions) {
      if (sub.subjectDid === selectedUser.did) {
        if (sub.sourceType === 'atproto.shares') {
          keys.add('shares');
        } else if (sub.sourceType === 'atproto.documents') {
          // feedUrl stores the publication AT URI for scoped subscriptions
          keys.add(sub.feedUrl || 'documents-all');
        }
      }
    }
    return keys;
  });

  async function searchUsers(query: string) {
    if (query.length < 2) {
      userSearchResults = [];
      return;
    }

    isUserSearching = true;
    try {
      userSearchResults = await searchBlueskyActors(query, 5);
    } catch (error) {
      console.error('Search error:', error);
      userSearchResults = [];
    } finally {
      isUserSearching = false;
    }
  }

  function handleUserSearchInput(event: Event) {
    const target = event.target as HTMLInputElement;
    userSearchQuery = target.value;

    if (userSearchDebounceTimer) {
      clearTimeout(userSearchDebounceTimer);
    }

    userSearchDebounceTimer = setTimeout(() => {
      searchUsers(userSearchQuery);
    }, 300);
  }

  async function selectUser(user: BlueskySearchResult) {
    selectedUser = user;
    step = 'select';
    isDetecting = true;
    detectError = null;
    publications = [];
    hasShares = false;
    selectedPublications = new Set();
    sharesSelected = false;
    subscribeError = null;
    showLimitWarning = false;

    try {
      const result = await api.detectContent(user.did);
      publications = result.publications;
      hasShares = result.hasShares;

      // Pre-select all items that aren't already subscribed
      for (const pub of result.publications) {
        if (!subscribedKeys.has(pub.uri)) {
          selectedPublications.add(pub.uri);
        }
      }
      selectedPublications = new Set(selectedPublications);
      if (result.hasShares && !subscribedKeys.has('shares')) {
        sharesSelected = true;
      }
    } catch (e) {
      detectError = e instanceof Error ? e.message : 'Failed to detect content';
    } finally {
      isDetecting = false;
    }
  }

  function goBackToSearch() {
    step = 'search';
    selectedUser = null;
    publications = [];
    hasShares = false;
    selectedPublications = new Set();
    sharesSelected = false;
    detectError = null;
    subscribeError = null;
    showLimitWarning = false;
  }

  function togglePublication(uri: string) {
    if (subscribedKeys.has(uri)) return;
    const next = new Set(selectedPublications);
    if (next.has(uri)) {
      next.delete(uri);
    } else {
      next.add(uri);
    }
    selectedPublications = next;
  }

  function toggleShares() {
    if (subscribedKeys.has('shares')) return;
    sharesSelected = !sharesSelected;
  }

  let selectedCount = $derived(selectedPublications.size + (sharesSelected ? 1 : 0));

  async function subscribe() {
    if (!selectedUser || selectedCount === 0) return;

    if (!subscriptionsStore.canAddMore) {
      showLimitWarning = true;
      return;
    }

    isSubscribing = true;
    subscribeError = null;
    showLimitWarning = false;

    try {
      // Subscribe to each selected publication
      for (const pubUri of selectedPublications) {
        const pub = publications.find((p) => p.uri === pubUri);
        if (!pub) continue;

        if (!subscriptionsStore.canAddMore) {
          showLimitWarning = true;
          break;
        }

        const subId = await subscriptionsStore.add(pubUri, pub.name || pub.url, {
          sourceType: 'atproto.documents',
          subjectDid: selectedUser.did,
          siteUrl: pub.url,
          feedUrl: pubUri,
        });
        if (pub.iconUrl) {
          await subscriptionsStore.updateLocal(subId, { customIconUrl: pub.iconUrl });
        }
      }

      // Subscribe to shares
      if (sharesSelected && subscriptionsStore.canAddMore) {
        const handle = selectedUser.handle;
        await subscriptionsStore.add(undefined, `Shares from @${handle}`, {
          sourceType: 'atproto.shares',
          subjectDid: selectedUser.did,
        });
      }

      // Reload social feed to pick up backfilled content
      socialStore.loadFeed(true);

      // Close modal after successful subscription
      handleClose();
    } catch (e) {
      subscribeError = e instanceof Error ? e.message : 'Failed to subscribe';
    } finally {
      isSubscribing = false;
    }
  }

  function handleClose() {
    userSearchQuery = '';
    userSearchResults = [];
    step = 'search';
    selectedUser = null;
    publications = [];
    hasShares = false;
    selectedPublications = new Set();
    sharesSelected = false;
    showLimitWarning = false;
    subscribeError = null;
    detectError = null;
    if (userSearchDebounceTimer) {
      clearTimeout(userSearchDebounceTimer);
    }
    onclose();
  }

  // Focus search input and load standard subscriptions when modal opens
  $effect(() => {
    if (open && step === 'search') {
      requestAnimationFrame(() => {
        searchInputEl?.focus();
      });
      loadStandardSubscriptions();
    }
  });
</script>

<Modal
  {open}
  onclose={handleClose}
  title={step === 'search' ? 'Subscribe to Content' : 'Select Content'}
>
  <div class="subscribe-content">
    {#if step === 'search'}
      <!-- Step 1: Search -->
      <div class="search-wrapper">
        <span class="search-icon">@</span>
        <input
          bind:this={searchInputEl}
          type="text"
          class="search-input"
          placeholder="Search Bluesky users..."
          value={userSearchQuery}
          oninput={handleUserSearchInput}
        />
        {#if isUserSearching}
          <span class="search-spinner"></span>
        {/if}
      </div>

      {#if userSearchResults.length > 0}
        <div class="search-results">
          {#each userSearchResults as result (result.did)}
            <button class="search-result" onclick={() => selectUser(result)}>
              {#if result.avatar}
                <img src={result.avatar} alt="" class="result-avatar" />
              {:else}
                <span class="result-avatar-placeholder"></span>
              {/if}
              <span class="result-info">
                <span class="result-name">{result.displayName || result.handle}</span>
                <span class="result-handle">@{result.handle}</span>
              </span>
              <span class="select-arrow">&rsaquo;</span>
            </button>
          {/each}
        </div>
      {:else if userSearchQuery.length >= 2 && !isUserSearching}
        <p class="no-results">No users found</p>
      {:else if userSearchQuery.length === 0}
        {#if isLoadingStandardSubs}
          <div class="detecting">
            <span class="search-spinner detecting-spinner"></span>
            <span>Loading subscriptions...</span>
          </div>
        {:else if standardSubs.length > 0}
          <p class="section-label">Your subscriptions</p>
          <div class="standard-subs-list">
            {#each standardSubs as sub (sub.uri)}
              {@const isSubscribed = subscribedPublisherDids.has(sub.publisherDid)}
              <button class="standard-sub-row" onclick={() => handleSelectStandardSub(sub)}>
                <div class="standard-sub-info">
                  <span class="standard-sub-name">{sub.publication.name}</span>
                  <span class="standard-sub-url">{sub.publication.url}</span>
                  {#if sub.publication.description}
                    <span class="standard-sub-desc">{sub.publication.description}</span>
                  {/if}
                </div>
                {#if isSubscribed}
                  <span class="subscribed-badge">Subscribed</span>
                {/if}
                <span class="select-arrow">&rsaquo;</span>
              </button>
            {/each}
          </div>
          <div class="divider-with-label">
            <span>or search Bluesky users</span>
          </div>
        {:else}
          <p class="hint">Enter a Bluesky handle or name to search</p>
        {/if}
      {/if}
    {:else if step === 'select' && selectedUser}
      <!-- Step 2: Select content -->
      <button class="back-button" onclick={goBackToSearch}> &lsaquo; Back to search </button>

      <div class="selected-user">
        {#if selectedUser.avatar}
          <img src={selectedUser.avatar} alt="" class="selected-avatar" />
        {:else}
          <span class="selected-avatar-placeholder"></span>
        {/if}
        <div class="selected-info">
          <span class="selected-name">{selectedUser.displayName || selectedUser.handle}</span>
          <span class="selected-handle">@{selectedUser.handle}</span>
        </div>
      </div>

      {#if isDetecting}
        <div class="detecting">
          <span class="search-spinner detecting-spinner"></span>
          <span>Detecting available content...</span>
        </div>
      {:else if detectError}
        <div class="error-message">{detectError}</div>
      {:else if publications.length === 0 && !hasShares}
        <p class="no-content">This account doesn't have any Skyreader-compatible content yet.</p>
      {:else}
        <div class="content-list">
          {#each publications as pub (pub.uri)}
            {@const isSubscribed = subscribedKeys.has(pub.uri)}
            <button
              class="content-item"
              class:selected={selectedPublications.has(pub.uri)}
              class:is-subscribed={isSubscribed}
              onclick={() => togglePublication(pub.uri)}
              disabled={isSubscribed}
            >
              <span
                class="checkbox"
                class:checked={selectedPublications.has(pub.uri) || isSubscribed}
              >
                {#if selectedPublications.has(pub.uri) || isSubscribed}
                  &#10003;
                {/if}
              </span>
              <span class="content-info">
                <span class="content-name">{pub.name || pub.url}</span>
                {#if pub.url}
                  <span class="content-url">{pub.url}</span>
                {/if}
                {#if pub.description}
                  <span class="content-desc">{pub.description}</span>
                {/if}
              </span>
              {#if isSubscribed}
                <span class="subscribed-badge">Subscribed</span>
              {/if}
            </button>
          {/each}

          {#if hasShares}
            {@const isSubscribed = subscribedKeys.has('shares')}
            <button
              class="content-item"
              class:selected={sharesSelected}
              class:is-subscribed={isSubscribed}
              onclick={toggleShares}
              disabled={isSubscribed}
            >
              <span class="checkbox" class:checked={sharesSelected || isSubscribed}>
                {#if sharesSelected || isSubscribed}
                  &#10003;
                {/if}
              </span>
              <span class="content-info">
                <span class="content-name">Shared articles</span>
                <span class="content-desc">Articles shared by @{selectedUser.handle}</span>
              </span>
              {#if isSubscribed}
                <span class="subscribed-badge">Subscribed</span>
              {/if}
            </button>
          {/if}
        </div>

        {#if showLimitWarning}
          <div class="limit-warning">
            Subscription limit reached ({subscriptionsStore.maxSubscriptions} max).
            {#if auth.user?.tier !== 'supporter'}
              <a
                href="https://github.com/sponsors/disnet"
                target="_blank"
                rel="noopener noreferrer"
                class="sponsor-link">Become a sponsor</a
              > to get raised limits.
            {/if}
          </div>
        {/if}

        {#if subscribeError}
          <div class="error-message">{subscribeError}</div>
        {/if}

        <button
          class="subscribe-button"
          onclick={subscribe}
          disabled={selectedCount === 0 || isSubscribing}
        >
          {#if isSubscribing}
            Subscribing...
          {:else}
            Subscribe{selectedCount > 0 ? ` (${selectedCount})` : ''}
          {/if}
        </button>
      {/if}
    {/if}
  </div>
</Modal>

<style>
  .subscribe-content {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    min-height: 300px;
  }

  .search-wrapper {
    position: relative;
    display: flex;
    align-items: center;
  }

  .search-icon {
    position: absolute;
    left: 0.75rem;
    color: var(--color-text-secondary);
    font-size: 1rem;
    pointer-events: none;
  }

  .search-input {
    width: 100%;
    padding: 0.75rem 0.75rem 0.75rem 2rem;
    font-size: 1rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-bg-secondary);
    color: var(--color-text);
    font: inherit;
  }

  .search-input:focus {
    outline: none;
    border-color: var(--color-primary);
  }

  .search-input::placeholder {
    color: var(--color-text-secondary);
  }

  .search-spinner {
    position: absolute;
    right: 0.75rem;
    width: 1rem;
    height: 1rem;
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

  .search-results {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    overflow: hidden;
  }

  .search-result {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.75rem;
    background: none;
    border: none;
    border-bottom: 1px solid var(--color-border);
    text-align: left;
    cursor: pointer;
    color: var(--color-text);
    font: inherit;
    transition: background-color 0.1s;
  }

  .search-result:last-child {
    border-bottom: none;
  }

  .search-result:hover {
    background: var(--color-bg-secondary);
  }

  .result-avatar {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    flex-shrink: 0;
    object-fit: cover;
  }

  .result-avatar-placeholder {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: var(--color-border);
    flex-shrink: 0;
  }

  .result-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .result-name {
    font-size: 0.9375rem;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .result-handle {
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .select-arrow {
    font-size: 1.5rem;
    color: var(--color-text-secondary);
    flex-shrink: 0;
    line-height: 1;
  }

  .no-results,
  .hint,
  .no-content {
    text-align: center;
    color: var(--color-text-secondary);
    font-size: 0.875rem;
    padding: 1rem;
  }

  /* Step 2 styles */
  .back-button {
    align-self: flex-start;
    background: none;
    border: none;
    color: var(--color-primary);
    font: inherit;
    font-size: 0.875rem;
    cursor: pointer;
    padding: 0.25rem 0;
  }

  .back-button:hover {
    text-decoration: underline;
  }

  .selected-user {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem;
    background: var(--color-bg-secondary);
    border-radius: 8px;
  }

  .selected-avatar {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    flex-shrink: 0;
    object-fit: cover;
  }

  .selected-avatar-placeholder {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: var(--color-border);
    flex-shrink: 0;
  }

  .selected-info {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .selected-name {
    font-weight: 600;
    font-size: 1rem;
  }

  .selected-handle {
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
  }

  .detecting {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 2rem;
    color: var(--color-text-secondary);
    font-size: 0.875rem;
  }

  .detecting-spinner {
    position: static;
  }

  .content-list {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    overflow: hidden;
  }

  .content-item {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    width: 100%;
    padding: 0.75rem;
    background: none;
    border: none;
    border-bottom: 1px solid var(--color-border);
    text-align: left;
    cursor: pointer;
    color: var(--color-text);
    font: inherit;
    transition: background-color 0.1s;
  }

  .content-item:last-child {
    border-bottom: none;
  }

  .content-item:hover:not(.is-subscribed) {
    background: var(--color-bg-secondary);
  }

  .content-item.is-subscribed {
    cursor: default;
    opacity: 0.6;
  }

  .checkbox {
    width: 20px;
    height: 20px;
    border: 2px solid var(--color-border);
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    font-size: 0.75rem;
    margin-top: 0.125rem;
    transition: all 0.1s;
  }

  .checkbox.checked {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: white;
  }

  .content-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .content-name {
    font-size: 0.9375rem;
    font-weight: 500;
  }

  .content-url {
    font-size: 0.75rem;
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .content-desc {
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .subscribed-badge {
    font-size: 0.75rem;
    padding: 0.25rem 0.5rem;
    background: var(--color-sidebar-active);
    color: var(--color-primary);
    border-radius: 9999px;
    font-weight: 500;
    flex-shrink: 0;
    margin-top: 0.125rem;
  }

  .limit-warning {
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
    color: var(--color-warning, #ff9800);
    background: rgba(255, 152, 0, 0.1);
    border-radius: 6px;
  }

  .sponsor-link {
    color: var(--color-primary);
    text-decoration: none;
  }

  .sponsor-link:hover {
    text-decoration: underline;
  }

  .error-message {
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
    color: var(--color-error, #f44336);
    background: rgba(244, 67, 54, 0.1);
    border-radius: 6px;
  }

  .subscribe-button {
    width: 100%;
    padding: 0.75rem;
    font-size: 1rem;
    font-weight: 500;
    background: var(--color-primary);
    color: white;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font: inherit;
    transition: opacity 0.1s;
  }

  .subscribe-button:hover:not(:disabled) {
    opacity: 0.9;
  }

  .subscribe-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Standard subscriptions styles */
  .section-label {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.03em;
    margin: 0;
  }

  .standard-subs-list {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    overflow: hidden;
    max-height: 280px;
    overflow-y: auto;
  }

  .standard-sub-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.625rem 0.75rem;
    background: none;
    border: none;
    border-bottom: 1px solid var(--color-border);
    text-align: left;
    cursor: pointer;
    color: var(--color-text);
    font: inherit;
    transition: background-color 0.1s;
  }

  .standard-sub-row:last-child {
    border-bottom: none;
  }

  .standard-sub-row:hover {
    background: var(--color-bg-secondary);
  }

  .standard-sub-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
  }

  .standard-sub-name {
    font-size: 0.9375rem;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .standard-sub-url {
    font-size: 0.75rem;
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .standard-sub-desc {
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
    display: -webkit-box;
    -webkit-line-clamp: 1;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .divider-with-label {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    color: var(--color-text-secondary);
    font-size: 0.8125rem;
  }

  .divider-with-label::before,
  .divider-with-label::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--color-border);
  }
</style>
