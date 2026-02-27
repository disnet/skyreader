<script lang="ts">
  import { goto } from '$app/navigation';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { articlesStore } from '$lib/stores/articles.svelte';
  import { socialStore } from '$lib/stores/social.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { fetchSingleFeed } from '$lib/services/feedFetcher';
  import { searchBlueskyActors, type BlueskySearchResult } from '$lib/services/blueskySearch';
  import { api } from '$lib/services/api';
  import { profileService } from '$lib/services/profiles';
  import Modal from '$lib/components/common/Modal.svelte';

  interface Publication {
    uri: string;
    name: string;
    url: string;
    description?: string;
    iconUrl?: string;
  }

  type Step = 'input' | 'select-feeds' | 'select-content';

  interface Props {
    open: boolean;
    onclose: () => void;
  }

  let { open, onclose }: Props = $props();
  let error = $state<string | null>(null);

  // Unified input state
  let inputValue = $state('');
  let step = $state<Step>('input');
  let isDiscovering = $state(false);

  // Bluesky search state
  let searchResults = $state<BlueskySearchResult[]>([]);
  let isSearching = $state(false);
  let searchTimeout: ReturnType<typeof setTimeout> | undefined;

  // Feed discovery state
  let discoveredFeeds = $state<string[]>([]);

  // Account content state
  let selectedAccount = $state<BlueskySearchResult | null>(null);
  let isDetecting = $state(false);
  let publications = $state<Publication[]>([]);
  let shareCount = $state(0);
  let freestandingDocumentCount = $state(0);
  let selectedPublications = $state<Set<string>>(new Set());
  let sharesSelected = $state(false);
  let freestandingDocsSelected = $state(false);
  let isSubscribing = $state(false);

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
        if (sub.sourceType === 'atproto.shares') {
          keys.add('shares');
        } else if (sub.sourceType === 'atproto.documents') {
          if (sub.feedUrl === '__freestanding__') {
            keys.add('__freestanding__');
          } else {
            keys.add(sub.feedUrl || 'documents-all');
          }
        }
      }
    }
    return keys;
  });

  let selectedCount = $derived(
    selectedPublications.size + (sharesSelected ? 1 : 0) + (freestandingDocsSelected ? 1 : 0)
  );

  function looksLikeUrl(value: string): boolean {
    const trimmed = value.trim();
    return (
      trimmed.startsWith('http://') ||
      trimmed.startsWith('https://') ||
      (trimmed.includes('.') && !trimmed.includes(' ') && trimmed.length > 4)
    );
  }

  function resetAll() {
    inputValue = '';
    step = 'input';
    error = null;
    isDiscovering = false;
    searchResults = [];
    isSearching = false;
    discoveredFeeds = [];
    selectedAccount = null;
    isDetecting = false;
    publications = [];
    shareCount = 0;
    freestandingDocumentCount = 0;
    selectedPublications = new Set();
    sharesSelected = false;
    freestandingDocsSelected = false;
    isSubscribing = false;
    if (searchTimeout) clearTimeout(searchTimeout);
  }

  function handleClose() {
    resetAll();
    onclose();
  }

  function handleInput() {
    error = null;
    if (searchTimeout) clearTimeout(searchTimeout);

    const trimmed = inputValue.trim();
    if (trimmed.length < 2) {
      searchResults = [];
      isSearching = false;
      return;
    }

    if (looksLikeUrl(trimmed)) {
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

  async function handleSubmit() {
    const trimmed = inputValue.trim();
    if (!trimmed) return;

    error = null;
    isDiscovering = true;
    discoveredFeeds = [];

    try {
      let url = trimmed;
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
      }

      const result = await api.discoverFeedsV2(url);
      if (result.feeds.length === 0) {
        error = 'No feeds found at this URL';
        isDiscovering = false;
      } else if (result.feeds.length === 1) {
        await addFeed(result.feeds[0]);
      } else {
        discoveredFeeds = result.feeds;
        step = 'select-feeds';
        isDiscovering = false;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to discover feeds';
      isDiscovering = false;
    }
  }

  async function addFeed(url: string) {
    error = null;
    try {
      const tempTitle = new URL(url).hostname;
      const id = await subscriptionsStore.add(url, tempTitle, {});
      const sub = subscriptionsStore.getById(id);

      handleClose();
      goto(`/?feed=${id}`);
      sidebarStore.closeMobile();

      if (sub) {
        fetchSingleFeed(sub, true, articlesStore.savedGuids).then(async (result) => {
          if (result.success && result.title) {
            try {
              await subscriptionsStore.update(id, {
                title: result.title,
                siteUrl: result.siteUrl,
              });
            } catch {
              // Ignore errors updating title
            }
          }
        });
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to add feed';
      isDiscovering = false;
    }
  }

  async function selectAccount(account: BlueskySearchResult) {
    selectedAccount = account;
    inputValue = '';
    searchResults = [];
    step = 'select-content';
    isDetecting = true;
    error = null;
    publications = [];
    shareCount = 0;
    freestandingDocumentCount = 0;
    selectedPublications = new Set();
    sharesSelected = false;
    freestandingDocsSelected = false;

    try {
      const result = await api.detectContent(account.did);
      publications = result.publications;
      shareCount = result.shareCount;
      freestandingDocumentCount = result.freestandingDocumentCount;

      for (const pub of result.publications) {
        if (!subscribedKeys.has(pub.uri)) {
          selectedPublications.add(pub.uri);
        }
      }
      selectedPublications = new Set(selectedPublications);
      if (result.shareCount > 0 && !subscribedKeys.has('shares')) {
        sharesSelected = true;
      }
      if (result.freestandingDocumentCount > 0 && !subscribedKeys.has('__freestanding__')) {
        freestandingDocsSelected = true;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to detect content';
    } finally {
      isDetecting = false;
    }
  }

  function goBackToInput() {
    step = 'input';
    selectedAccount = null;
    publications = [];
    shareCount = 0;
    freestandingDocumentCount = 0;
    selectedPublications = new Set();
    sharesSelected = false;
    freestandingDocsSelected = false;
    discoveredFeeds = [];
    error = null;
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

  function toggleFreestandingDocs() {
    if (subscribedKeys.has('__freestanding__')) return;
    freestandingDocsSelected = !freestandingDocsSelected;
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

  let subscribingStandardSub = $state<string | null>(null);

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
      handleClose();
      goto(`/?feed=${subId}`);
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
      // If opened with a specific DID, skip straight to content detection
      const initialDid = sidebarStore.addFeedModalInitialDid;
      if (initialDid) {
        // Start content detection immediately with DID as placeholder handle
        selectAccount({
          did: initialDid,
          handle: initialDid,
          displayName: undefined,
          avatar: undefined,
        });
        // Resolve profile in background to update display name/avatar
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
    if (!selectedAccount || selectedCount === 0) return;

    if (!subscriptionsStore.canAddMore) {
      error = 'Subscription limit reached';
      return;
    }

    error = null;
    isSubscribing = true;
    let firstAddedId: number | null = null;

    try {
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
          await subscriptionsStore.updateLocal(subId, { customIconUrl: pub.iconUrl });
        }
      }

      if (freestandingDocsSelected && subscriptionsStore.canAddMore) {
        const docsId = await subscriptionsStore.add(
          '__freestanding__',
          `Documents from @${selectedAccount.handle}`,
          {
            sourceType: 'atproto.documents',
            subjectDid: selectedAccount.did,
            feedUrl: '__freestanding__',
          }
        );
        if (!firstAddedId) firstAddedId = docsId;
      }

      if (sharesSelected && subscriptionsStore.canAddMore) {
        const sharesId = await subscriptionsStore.add(
          undefined,
          `Shares from @${selectedAccount.handle}`,
          {
            sourceType: 'atproto.shares',
            subjectDid: selectedAccount.did,
          }
        );
        if (!firstAddedId) firstAddedId = sharesId;
      }

      socialStore.loadFeed(true);
      handleClose();

      if (firstAddedId) {
        goto(`/?feed=${firstAddedId}`);
        sidebarStore.closeMobile();
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to subscribe';
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
    <p class="section-label">Your standard.site subscriptions</p>
    <div class="standard-subs-list">
      {#each standardSubs as sub (sub.uri)}
        {@const isSubscribed = subscribedPublisherDids.has(sub.publisherDid)}
        <div class="standard-sub-row">
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

<Modal {open} onclose={handleClose} title="Add subscription">
  {#if isAtLimit}
    <p class="limit-message">
      You've reached the maximum of {subscriptionsStore.maxSubscriptions} feeds. Remove some feeds to
      add new ones.
    </p>
  {:else if step === 'input'}
    <div class="modal-content">
      <form
        onsubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
      >
        <div class="input-group">
          <input
            type="text"
            class="search-input"
            placeholder="Add RSS feed, Website URL, @handle..."
            bind:value={inputValue}
            oninput={handleInput}
            disabled={isDiscovering}
          />
          <button type="submit" class="add-btn" disabled={isDiscovering || !inputValue.trim()}>
            {isDiscovering ? 'Adding...' : 'Add'}
          </button>
        </div>
      </form>

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
      {:else if inputValue.trim().length >= 2 && !looksLikeUrl(inputValue.trim()) && !isSearching}
        <p class="search-status">No results found</p>
      {:else if inputValue.trim().length === 0}
        {@render standardSubsList()}
        {#if !isLoadingStandardSubs && standardSubs.length === 0}
          <p class="search-hint">Enter a feed URL, website, or Bluesky handle</p>
        {/if}
      {/if}
    </div>
  {:else if step === 'select-feeds'}
    <div class="modal-content">
      <button class="back-btn" onclick={goBackToInput}>&#8249; Back</button>
      <p class="section-label">Multiple feeds found — select one:</p>
      <div class="search-results">
        {#each discoveredFeeds as url}
          <button class="result-btn" onclick={() => addFeed(url)}>
            <span class="result-info">
              <span class="result-name feed-url">{url}</span>
            </span>
          </button>
        {/each}
      </div>
    </div>
  {:else if step === 'select-content' && selectedAccount}
    <div class="modal-content">
      <button class="back-btn" onclick={goBackToInput}>&#8249; Back</button>

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
      </div>

      {#if isDetecting}
        <div class="detecting">
          <span class="spinner"></span>
          <span>Detecting available content...</span>
        </div>
      {:else}
        <div class="content-list">
          <button
            class="content-item"
            class:selected={freestandingDocsSelected}
            class:is-subscribed={subscribedKeys.has('__freestanding__')}
            onclick={toggleFreestandingDocs}
            disabled={subscribedKeys.has('__freestanding__')}
          >
            <span
              class="checkbox"
              class:checked={freestandingDocsSelected || subscribedKeys.has('__freestanding__')}
            >
              {#if freestandingDocsSelected || subscribedKeys.has('__freestanding__')}&#10003;{/if}
            </span>
            <span class="content-info">
              <span class="content-name"
                >Documents <span class="content-count">({freestandingDocumentCount})</span></span
              >
              <span class="content-desc">Free-standing documents by @{selectedAccount.handle}</span>
            </span>
            {#if subscribedKeys.has('__freestanding__')}
              <span class="subscribed-badge">Subscribed</span>
            {/if}
          </button>

          <button
            class="content-item"
            class:selected={sharesSelected}
            class:is-subscribed={subscribedKeys.has('shares')}
            onclick={toggleShares}
            disabled={subscribedKeys.has('shares')}
          >
            <span class="checkbox" class:checked={sharesSelected || subscribedKeys.has('shares')}>
              {#if sharesSelected || subscribedKeys.has('shares')}&#10003;{/if}
            </span>
            <span class="content-info">
              <span class="content-name"
                >Shared articles <span class="content-count">({shareCount})</span></span
              >
              <span class="content-desc">Articles shared by @{selectedAccount.handle}</span>
            </span>
            {#if subscribedKeys.has('shares')}
              <span class="subscribed-badge">Subscribed</span>
            {/if}
          </button>
        </div>

        {#if publications.length > 0}
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
                  {#if selectedPublications.has(pub.uri) || isSubscribed}&#10003;{/if}
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
          </div>
        {/if}

        <button
          class="subscribe-btn"
          onclick={handleSubscribe}
          disabled={selectedCount === 0 || isSubscribing}
        >
          {#if isSubscribing}
            Subscribing...
          {:else}
            Subscribe{selectedCount > 0 ? ` (${selectedCount})` : ''}
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
    font-size: 0.875rem;
    outline: none;
    box-sizing: border-box;
  }

  .search-input:focus {
    border-color: var(--color-accent, #0085ff);
  }

  .add-btn {
    padding: 0.625rem 1rem;
    border: none;
    border-radius: 8px;
    background: var(--color-accent, #0085ff);
    color: white;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    flex-shrink: 0;
    transition: opacity 0.15s;
  }

  .add-btn:hover:not(:disabled) {
    opacity: 0.9;
  }

  .add-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .search-status,
  .search-hint {
    color: var(--color-text-secondary);
    font-size: 0.875rem;
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
    font-weight: 500;
    font-size: 0.875rem;
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

  .feed-url {
    font-weight: 400;
    word-break: break-all;
    white-space: normal;
  }

  .back-btn {
    align-self: flex-start;
    padding: 0.25rem 0.5rem;
    border: none;
    background: transparent;
    color: var(--color-text-secondary);
    font-size: 0.875rem;
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
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
    padding: 1.5rem 0;
    color: var(--color-text-secondary);
    font-size: 0.875rem;
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

  .no-content {
    color: var(--color-text-secondary);
    font-size: 0.875rem;
    text-align: center;
    padding: 1rem 0;
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

  .content-item:hover:not(:disabled) {
    background: var(--color-bg-secondary);
  }

  .content-item.is-subscribed {
    opacity: 0.6;
    cursor: default;
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
    font-size: 0.75rem;
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

  .content-info {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
    gap: 0.125rem;
  }

  .content-name {
    font-weight: 500;
    font-size: 0.875rem;
  }

  .content-url {
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .content-desc {
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
  }

  .content-count {
    font-weight: 400;
    color: var(--color-text-secondary);
  }

  .subscribed-badge {
    font-size: 0.75rem;
    color: var(--color-text-secondary);
    background: var(--color-bg-secondary);
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
    font-size: 0.875rem;
    font-weight: 500;
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
    font-size: 0.875rem;
    margin-top: 0.5rem;
  }

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
    font-size: 0.8125rem;
    font-weight: 500;
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

  @media (max-width: 600px) {
    .search-input {
      font-size: 16px; /* Prevents iOS zoom on focus */
    }
  }
</style>
