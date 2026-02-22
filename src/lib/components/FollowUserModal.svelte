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

  // Focus search input when modal opens
  $effect(() => {
    if (open && step === 'search') {
      requestAnimationFrame(() => {
        searchInputEl?.focus();
      });
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
        <p class="hint">Enter a Bluesky handle or name to search</p>
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
</style>
