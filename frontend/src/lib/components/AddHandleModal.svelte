<script lang="ts">
  import { goto } from '$app/navigation';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { socialStore } from '$lib/stores/social.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { searchBlueskyActors, type BlueskySearchResult } from '$lib/services/blueskySearch';
  import { api } from '$lib/services/api';
  import { fetchAllDocuments } from '$lib/services/feedFetcher';
  import { profileService } from '$lib/services/profiles';
  import { syncStore } from '$lib/stores/sync.svelte';
  import { getFaviconUrl } from '$lib/utils/favicon';
  import Modal from '$lib/components/common/Modal.svelte';
  import Icon from '$lib/components/Icon.svelte';

  interface Publication {
    uri: string;
    name: string;
    url: string;
    description?: string;
    iconUrl?: string;
  }

  type Step = 'search' | 'select-content';

  interface Props {
    open: boolean;
    onclose: () => void;
    initialValue?: string;
  }

  let { open, onclose, initialValue = '' }: Props = $props();
  let error = $state<string | null>(null);

  // Search state
  let inputValue = $state('');
  let step = $state<Step>('search');
  let searchResults = $state<BlueskySearchResult[]>([]);
  let isSearching = $state(false);
  let searchTimeout: ReturnType<typeof setTimeout> | undefined;

  // Account content state
  let selectedAccount = $state<BlueskySearchResult | null>(null);
  let isDetecting = $state(false);
  let publications = $state<Publication[]>([]);
  let selectedPublications = $state<Set<string>>(new Set());
  let isSubscribing = $state(false);

  // Unsubscribe tracking: when a subscribed item is de-selected, it's added here
  let unsubscribePublicationUris = $state<Set<string>>(new Set());

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
  let subscribingStandardSub = $state<string | null>(null);

  let subscribedPublisherDids = $derived.by(() => {
    const dids = new Set<string>();
    for (const sub of subscriptionsStore.subscriptions) {
      if (sub.subjectDid) {
        dids.add(sub.subjectDid);
      }
    }
    return dids;
  });

  const isAtLimit = $derived(
    subscriptionsStore.subscriptions.length >= subscriptionsStore.maxSubscriptions
  );

  let subscribedKeys = $derived.by(() => {
    if (!selectedAccount) return new Set<string>();
    const keys = new Set<string>();
    for (const sub of subscriptionsStore.subscriptions) {
      if (sub.subjectDid === selectedAccount.did) {
        if (sub.sourceType === 'atproto.documents') {
          keys.add(sub.feedUrl || 'documents-all');
        }
      }
    }
    return keys;
  });

  // Map content keys → subscription IDs for unsubscribing
  let subscribedSubIds = $derived.by(() => {
    if (!selectedAccount) return new Map<string, number>();
    const map = new Map<string, number>();
    for (const sub of subscriptionsStore.subscriptions) {
      if (sub.subjectDid !== selectedAccount.did) continue;
      if (sub.id === undefined) continue;
      if (sub.sourceType === 'atproto.documents' && sub.feedUrl) {
        map.set(sub.feedUrl, sub.id);
      }
    }
    return map;
  });

  let changeCount = $derived(selectedPublications.size + unsubscribePublicationUris.size);

  // Track icons that failed to load so we can fall back to a placeholder.
  let failedIcons = $state<Set<string>>(new Set());

  // Prefer the publication's own icon, falling back to a favicon derived from its URL.
  function pubIconUrl(pub: { uri: string; url?: string; iconUrl?: string }): string {
    if (failedIcons.has(pub.uri)) return '';
    return pub.iconUrl || (pub.url ? getFaviconUrl(pub.url, 64) : '');
  }

  function handleIconError(uri: string) {
    if (failedIcons.has(uri)) return;
    failedIcons = new Set(failedIcons).add(uri);
  }

  // Pre-fill input when modal opens with an initial value
  $effect(() => {
    if (open && initialValue) {
      inputValue = initialValue;
    }
  });

  function resetAll() {
    inputValue = '';
    step = 'search';
    error = null;
    searchResults = [];
    isSearching = false;
    selectedAccount = null;
    isDetecting = false;
    publications = [];
    selectedPublications = new Set();
    isSubscribing = false;
    unsubscribePublicationUris = new Set();
    if (searchTimeout) clearTimeout(searchTimeout);
  }

  function handleClose() {
    resetAll();
    onclose();
  }

  function handleInput() {
    error = null;
    if (searchTimeout) clearTimeout(searchTimeout);

    const trimmed = inputValue.trim().replace(/^@/, '');
    if (trimmed.length < 2) {
      searchResults = [];
      isSearching = false;
      return;
    }

    if (!syncStore.isOnline) {
      searchResults = [];
      isSearching = false;
      return;
    }

    isSearching = true;
    searchTimeout = setTimeout(async () => {
      try {
        searchResults = await searchBlueskyActors(trimmed, 5);
      } catch {
        searchResults = [];
      } finally {
        isSearching = false;
      }
    }, 300);
  }

  async function selectAccount(account: BlueskySearchResult) {
    selectedAccount = account;
    inputValue = '';
    searchResults = [];
    step = 'select-content';
    isDetecting = true;
    error = null;
    publications = [];
    selectedPublications = new Set();
    unsubscribePublicationUris = new Set();

    try {
      const result = await api.detectContent(account.did);
      publications = result.publications;

      // For a new account, default to selecting everything discoverable.
      // For an account the user already follows, reflect their current choices only;
      // they can opt into additional sources manually.
      const hasExistingSubscriptions = subscribedKeys.size > 0;
      if (!hasExistingSubscriptions) {
        selectedPublications = new Set(result.publications.map((pub) => pub.uri));
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to detect content';
    } finally {
      isDetecting = false;
    }
  }

  function goBackToSearch() {
    step = 'search';
    selectedAccount = null;
    publications = [];
    selectedPublications = new Set();
    unsubscribePublicationUris = new Set();
    error = null;
  }

  function togglePublication(uri: string) {
    if (subscribedKeys.has(uri)) {
      // Already subscribed — toggle unsubscribe
      const next = new Set(unsubscribePublicationUris);
      if (next.has(uri)) {
        next.delete(uri);
      } else {
        next.add(uri);
      }
      unsubscribePublicationUris = next;
      return;
    }
    const next = new Set(selectedPublications);
    if (next.has(uri)) {
      next.delete(uri);
    } else {
      next.add(uri);
    }
    selectedPublications = next;
  }

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
          service?: Array<{
            id: string;
            type: string;
            serviceEndpoint: string;
          }>;
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
          service?: Array<{
            id: string;
            type: string;
            serviceEndpoint: string;
          }>;
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

  async function subscribeStandardSub(sub: StandardSub) {
    if (subscribedPublisherDids.has(sub.publisherDid)) return;
    if (!subscriptionsStore.canAddMore) {
      error = 'Subscription limit reached';
      return;
    }

    error = null;
    subscribingStandardSub = sub.uri;

    try {
      const subId = await subscriptionsStore.add(sub.publication.uri, sub.publication.name, {
        sourceType: 'atproto.documents',
        subjectDid: sub.publisherDid,
        siteUrl: sub.publication.url,
        feedUrl: sub.publication.uri,
      });

      socialStore.loadFeed(true);
      // Fetch this publication's documents now so they appear immediately
      // (also refreshed on the regular cycle).
      void fetchAllDocuments(subscriptionsStore.subscriptions);
      handleClose();
      goto(`/feeds?feed=${subId}`);
      sidebarStore.closeMobile();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to subscribe';
    } finally {
      subscribingStandardSub = null;
    }
  }

  $effect(() => {
    if (open) {
      loadStandardSubscriptions();
      const initialDid = sidebarStore.addFeedModalInitialDid;
      if (initialDid) {
        selectAccount({
          did: initialDid,
          handle: initialDid,
          displayName: undefined,
          avatar: undefined,
        });
        profileService.getProfile(initialDid).then((profile) => {
          if (profile && selectedAccount?.did === initialDid) {
            selectedAccount = {
              ...selectedAccount,
              handle: profile.handle || selectedAccount.handle,
              displayName: profile.displayName,
              avatar: profile.avatar,
            };
          }
        });
      }
    }
  });

  async function handleSubscribe() {
    if (!selectedAccount || changeCount === 0) return;

    error = null;
    isSubscribing = true;
    let firstAddedId: number | null = null;

    try {
      // Unsubscribe from de-selected items first
      for (const pubUri of unsubscribePublicationUris) {
        const id = subscribedSubIds.get(pubUri);
        if (id !== undefined) await subscriptionsStore.remove(id);
      }

      // Subscribe to newly selected items
      if (selectedPublications.size > 0) {
        if (!subscriptionsStore.canAddMore) {
          error = `Subscription limit reached (${subscriptionsStore.maxSubscriptions} max)`;
          return;
        }
      }

      for (const pubUri of selectedPublications) {
        const pub = publications.find((p) => p.uri === pubUri);
        if (!pub) continue;

        if (!subscriptionsStore.canAddMore) {
          error = `Subscription limit reached (${subscriptionsStore.maxSubscriptions} max)`;
          break;
        }

        const subId = await subscriptionsStore.add(pubUri, pub.name || pub.url, {
          sourceType: 'atproto.documents',
          subjectDid: selectedAccount.did,
          siteUrl: pub.url,
          feedUrl: pubUri,
        });
        if (!firstAddedId) firstAddedId = subId;
        if (pub.iconUrl) {
          await subscriptionsStore.updateLocal(subId, {
            customIconUrl: pub.iconUrl,
          });
        }
      }

      socialStore.loadFeed(true);
      // Fetch the new publications' documents now so they appear immediately
      // (also refreshed on the regular cycle).
      void fetchAllDocuments(subscriptionsStore.subscriptions);
      handleClose();

      if (firstAddedId) {
        goto(`/feeds?feed=${firstAddedId}`);
        sidebarStore.closeMobile();
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to update subscriptions';
    } finally {
      isSubscribing = false;
    }
  }
</script>

{#snippet standardSubsList()}
  {#if isLoadingStandardSubs}
    <div class="detecting">
      <span class="spinner"></span>
      <span>Loading subscriptions...</span>
    </div>
  {:else if standardSubs.length > 0}
    <p class="section-label standard-label">
      <Icon name="standard-site" size={13} /> Your standard.site subscriptions
    </p>
    <div class="standard-subs-list">
      {#each standardSubs as sub (sub.uri)}
        {@const isSubscribed = subscribedPublisherDids.has(sub.publisherDid)}
        <div class="standard-sub-row">
          {#if pubIconUrl(sub.publication)}
            <img
              src={pubIconUrl(sub.publication)}
              alt=""
              class="pub-favicon"
              loading="lazy"
              onerror={() => handleIconError(sub.publication.uri)}
            />
          {:else}
            <span class="pub-favicon-placeholder">
              <Icon name="standard-site" size={16} />
            </span>
          {/if}
          <div class="standard-sub-info">
            <span class="standard-sub-name">{sub.publication.name}</span>
            <span class="standard-sub-url">{sub.publication.url}</span>
            {#if sub.publication.description}
              <span class="standard-sub-desc">{sub.publication.description}</span>
            {/if}
          </div>
          {#if isSubscribed}
            <span class="subscribed-badge">Subscribed</span>
          {:else}
            <button
              class="standard-sub-subscribe-btn"
              onclick={() => subscribeStandardSub(sub)}
              disabled={subscribingStandardSub === sub.uri}
            >
              {subscribingStandardSub === sub.uri ? 'Adding...' : 'Subscribe'}
            </button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
{/snippet}

<Modal {open} onclose={handleClose}>
  {#if step === 'search'}
    <div class="modal-content">
      <p class="modal-desc">
        Follow an Atmosphere account (Bluesky, Blacksky, npmx, etc.) to see their published posts
        and publications.
      </p>
      {#if isAtLimit}
        <p class="limit-message">
          You've reached the maximum of {subscriptionsStore.maxSubscriptions} feeds. Remove some feeds
          to add new ones.
        </p>
      {/if}
      <div class="input-group">
        <input
          type="text"
          class="search-input"
          placeholder="@handle or name..."
          bind:value={inputValue}
          oninput={handleInput}
          autofocus
        />
      </div>

      {#if isSearching}
        <p class="search-status">Searching...</p>
      {:else if searchResults.length > 0}
        <div class="search-results">
          {#each searchResults as result (result.did)}
            <button class="result-btn" onclick={() => selectAccount(result)}>
              {#if result.avatar}
                <img src={result.avatar} alt="" class="result-avatar" />
              {:else}
                <span class="result-avatar-placeholder"></span>
              {/if}
              <span class="result-info">
                <span class="result-name">{result.displayName || result.handle}</span>
                <span class="result-handle">@{result.handle}</span>
              </span>
            </button>
          {/each}
        </div>
      {:else if inputValue.trim().length >= 2 && !isSearching}
        <p class="search-status">No results found</p>
      {:else if inputValue.trim().length === 0}
        {@render standardSubsList()}
      {/if}
    </div>
  {:else if step === 'select-content' && selectedAccount}
    <div class="modal-content">
      <button class="back-btn" onclick={goBackToSearch}>&#8249; Back</button>

      <div class="selected-user">
        {#if selectedAccount.avatar}
          <img src={selectedAccount.avatar} alt="" class="selected-avatar" />
        {:else}
          <span class="selected-avatar-placeholder"></span>
        {/if}
        <div class="selected-info">
          <span class="selected-name">{selectedAccount.displayName || selectedAccount.handle}</span>
          <span class="selected-handle">@{selectedAccount.handle}</span>
        </div>
        <a
          class="bsky-profile-link"
          href="https://bsky.app/profile/{selectedAccount.handle}"
          target="_blank"
          rel="noopener noreferrer"
          title="View on Bluesky"
        >
          <svg class="bsky-icon" viewBox="0 0 568 501" fill="none" aria-hidden="true">
            <path
              d="M123.121 33.6637C188.241 82.5526 258.281 181.681 284 234.873C309.719 181.681 379.759 82.5526 444.879 33.6637C491.866 -1.61175 568 -28.9061 568 57.9464C568 75.2916 558.055 203.659 552.222 224.501C531.947 296.954 458.067 315.434 392.347 304.249C507.222 323.8 536.444 388.56 473.333 453.32C353.473 576.312 301.061 422.461 287.631 383.039C285.169 375.812 284.017 372.431 284 375.306C283.983 372.431 282.831 375.812 280.369 383.039C266.939 422.461 214.527 576.312 94.6667 453.32C31.5556 388.56 60.7778 323.8 175.653 304.249C109.933 315.434 36.0534 296.954 15.7778 224.501C9.94493 203.659 0 75.2916 0 57.9464C0 -28.9061 76.1344 -1.61175 123.121 33.6637Z"
            />
          </svg>
        </a>
      </div>

      {#if isDetecting}
        <div class="detecting">
          <span class="spinner"></span>
          <span>Detecting available content...</span>
        </div>
      {:else if publications.length === 0}
        <p class="no-content">
          No publications found for @{selectedAccount.handle}.
        </p>
      {:else}
        <div class="content-list">
          {#each publications as pub (pub.uri)}
            {@const isSubscribed = subscribedKeys.has(pub.uri)}
            {@const unsubscribing = unsubscribePublicationUris.has(pub.uri)}
            {@const isActive = isSubscribed ? !unsubscribing : selectedPublications.has(pub.uri)}
            <button
              class="content-item"
              class:selected={isActive}
              class:is-subscribed={isSubscribed}
              onclick={() => togglePublication(pub.uri)}
            >
              <span class="checkbox" class:checked={isActive}>
                {#if isActive}&#10003;{/if}
              </span>
              {#if pubIconUrl(pub)}
                <img
                  src={pubIconUrl(pub)}
                  alt=""
                  class="pub-favicon"
                  loading="lazy"
                  onerror={() => handleIconError(pub.uri)}
                />
              {:else}
                <span class="pub-favicon-placeholder">
                  <Icon name="standard-site" size={16} />
                </span>
              {/if}
              <span class="content-info">
                <span class="content-name">{pub.name || pub.url}</span>
                {#if pub.url}
                  <span class="content-url">{pub.url}</span>
                {/if}
                {#if pub.description}
                  <span class="content-desc">{pub.description}</span>
                {/if}
              </span>
              {#if isSubscribed && unsubscribing}
                <span class="unsubscribing-badge">Removing</span>
              {:else if isSubscribed}
                <span class="subscribed-badge">Subscribed</span>
              {/if}
            </button>
          {/each}
        </div>

        <button
          class="subscribe-btn"
          onclick={handleSubscribe}
          disabled={changeCount === 0 || isSubscribing}
        >
          {#if isSubscribing}
            Updating...
          {:else}
            Update subscriptions{changeCount > 0 ? ` (${changeCount})` : ''}
          {/if}
        </button>
      {/if}
    </div>
  {/if}

  {#if error}
    <p class="error-message">{error}</p>
  {/if}
</Modal>

<style>
  .modal-content {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-height: 200px;
  }

  .modal-desc {
    margin: 0;
    font-size: var(--text-md);
    color: var(--color-text-secondary);
  }

  .input-group {
    display: flex;
    gap: 0.5rem;
  }

  .search-input {
    flex: 1;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-md);
    outline: none;
    box-sizing: border-box;
  }

  .search-input:focus {
    border-color: var(--color-accent, #0085ff);
  }

  .search-status {
    color: var(--color-text-secondary);
    font-size: var(--text-md);
    text-align: center;
    padding: 0.5rem 0;
  }

  .search-results {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    overflow: hidden;
  }

  .result-btn {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.625rem 0.75rem;
    border: none;
    border-bottom: 1px solid var(--color-border);
    background: transparent;
    cursor: pointer;
    text-align: left;
    color: var(--color-text);
    transition: background-color 0.15s;
  }

  .result-btn:last-child {
    border-bottom: none;
  }

  .result-btn:hover {
    background: var(--color-bg-secondary);
  }

  .result-avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    flex-shrink: 0;
    object-fit: cover;
  }

  .result-avatar-placeholder {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--color-border);
  }

  .result-info {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .result-name {
    font-weight: var(--weight-medium);
    font-size: var(--text-md);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .result-handle {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .back-btn {
    align-self: flex-start;
    padding: 0.25rem 0.5rem;
    border: none;
    background: transparent;
    color: var(--color-text-secondary);
    font-size: var(--text-md);
    cursor: pointer;
  }

  .back-btn:hover {
    color: var(--color-text);
  }

  .selected-user {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem;
    background: var(--color-bg-secondary);
    border-radius: 8px;
    position: relative;
  }

  .selected-avatar {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    flex-shrink: 0;
    object-fit: cover;
  }

  .selected-avatar-placeholder {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--color-border);
  }

  .selected-info {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .selected-name {
    font-weight: var(--weight-medium);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .selected-handle {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .bsky-profile-link {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 36px;
    height: 36px;
    border-radius: 8px;
    margin-left: auto;
    color: var(--color-text-secondary);
    transition:
      background-color 0.15s,
      color 0.15s;
  }

  .bsky-profile-link:hover {
    background: var(--color-bg);
    color: #0085ff;
  }

  .bsky-icon {
    width: 20px;
    height: 20px;
    fill: currentColor;
  }

  .detecting {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 1.5rem 0;
    color: var(--color-text-secondary);
    font-size: var(--text-md);
  }

  .spinner {
    width: 1rem;
    height: 1rem;
    border: 2px solid var(--color-border);
    border-top-color: var(--color-accent, #0085ff);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .content-list {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    overflow: hidden;
  }

  .no-content {
    margin: 0;
    padding: 1rem 0;
    text-align: center;
    font-size: var(--text-md);
    color: var(--color-text-secondary);
  }

  .content-item {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    width: 100%;
    padding: 0.75rem;
    border: none;
    border-bottom: 1px solid var(--color-border);
    background: transparent;
    text-align: left;
    cursor: pointer;
    color: var(--color-text);
    transition: background-color 0.15s;
  }

  .content-item:last-child {
    border-bottom: none;
  }

  .content-item:hover {
    background: var(--color-bg-secondary);
  }

  .checkbox {
    width: 18px;
    height: 18px;
    border: 2px solid var(--color-border);
    border-radius: 4px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: var(--text-xs);
    margin-top: 1px;
    transition:
      background-color 0.15s,
      border-color 0.15s;
  }

  .checkbox.checked {
    background: var(--color-accent, #0085ff);
    border-color: var(--color-accent, #0085ff);
    color: white;
  }

  .pub-favicon {
    width: 20px;
    height: 20px;
    border-radius: 4px;
    flex-shrink: 0;
    object-fit: cover;
    margin-top: 1px;
    background: var(--color-bg-secondary);
  }

  .pub-favicon-placeholder {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 4px;
    flex-shrink: 0;
    margin-top: 1px;
    background: var(--color-bg-secondary);
    color: var(--color-text-tertiary, var(--color-text-secondary));
  }

  .content-info {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
    gap: 0.125rem;
  }

  .content-name {
    font-weight: var(--weight-medium);
    font-size: var(--text-md);
  }

  .content-url {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .content-desc {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .subscribed-badge {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    background: var(--color-bg-secondary);
    padding: 0.125rem 0.5rem;
    border-radius: 4px;
    flex-shrink: 0;
    align-self: center;
  }

  .unsubscribing-badge {
    font-size: var(--text-xs);
    color: var(--color-error);
    background: color-mix(in srgb, var(--color-error) 10%, transparent);
    padding: 0.125rem 0.5rem;
    border-radius: 4px;
    flex-shrink: 0;
    align-self: center;
  }

  .subscribe-btn {
    width: 100%;
    padding: 0.625rem;
    border: none;
    border-radius: 8px;
    background: var(--color-accent, #0085ff);
    color: white;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    cursor: pointer;
    transition: opacity 0.15s;
  }

  .subscribe-btn:hover:not(:disabled) {
    opacity: 0.9;
  }

  .subscribe-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .limit-message {
    color: var(--color-text-secondary);
    text-align: center;
    padding: 1rem;
  }

  .error-message {
    color: var(--color-error);
    font-size: var(--text-md);
    margin-top: 0.5rem;
  }

  .section-label {
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wide);
    margin: 0;
  }

  .standard-label {
    display: flex;
    align-items: center;
    gap: 0.35rem;
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
    color: var(--color-text);
    font: inherit;
  }

  .standard-sub-row:last-child {
    border-bottom: none;
  }

  .standard-sub-subscribe-btn {
    padding: 0.25rem 0.75rem;
    border: none;
    border-radius: 6px;
    background: var(--color-accent, #0085ff);
    color: white;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    cursor: pointer;
    flex-shrink: 0;
    transition: opacity 0.15s;
  }

  .standard-sub-subscribe-btn:hover:not(:disabled) {
    opacity: 0.85;
  }

  .standard-sub-subscribe-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .standard-sub-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
  }

  .standard-sub-name {
    font-size: var(--text-lg);
    font-weight: var(--weight-medium);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .standard-sub-url {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .standard-sub-desc {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    display: -webkit-box;
    -webkit-line-clamp: 1;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  @media (max-width: 600px) {
    .search-input {
      font-size: var(--text-base);
    }
  }
</style>
