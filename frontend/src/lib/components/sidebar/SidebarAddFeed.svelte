<script lang="ts">
  import { goto } from '$app/navigation';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { articlesStore } from '$lib/stores/articles.svelte';
  import { socialStore } from '$lib/stores/social.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { fetchSingleFeed, fetchAllDocuments } from '$lib/services/feedFetcher';
  import { searchBlueskyActors, type BlueskySearchResult } from '$lib/services/blueskySearch';
  import { api } from '$lib/services/api';
  import {
    crossTypeDuplicatesForAdded,
    type CrossTypeDuplicate,
  } from '$lib/services/subscriptionDedup';
  import { dismissUnifyHost } from '$lib/services/unifyDismiss';
  import UnifyNotice from '../UnifyNotice.svelte';
  import Icon from '../Icon.svelte';

  interface Publication {
    uri: string;
    name: string;
    url: string;
    description?: string;
    iconUrl?: string;
  }

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

  type Mode =
    | 'idle'
    | 'searching-actors'
    | 'discovering-feeds'
    | 'select-feeds'
    | 'select-content'
    | 'unify';

  let inputValue = $state('');
  let mode = $state<Mode>('idle');
  let error = $state<string | null>(null);
  let inputFocused = $state(false);

  // Bluesky search state
  let searchResults = $state<BlueskySearchResult[]>([]);
  let searchTimeout: ReturnType<typeof setTimeout> | undefined;

  // Feed discovery state
  let discoveredFeeds = $state<string[]>([]);

  // Account content state
  let selectedAccount = $state<BlueskySearchResult | null>(null);
  let isDetecting = $state(false);
  let publications = $state<Publication[]>([]);
  let selectedPublications = $state<Set<string>>(new Set());
  let isSubscribing = $state(false);

  // Unify state: after an add that duplicates an existing source (same site via
  // both RSS and standard.site), pause in 'unify' mode so the user can keep one
  // or both. unifyKeptFeedId is the feed to open once resolved.
  let unifyPairs = $state<CrossTypeDuplicate[]>([]);
  let unifyKeptFeedId = $state<number | null>(null);

  // Standard subscriptions state
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

  let inputEl: HTMLInputElement | undefined = $state();
  let dropdownEl: HTMLDivElement | undefined = $state();

  // Track subscribed keys for the selected account
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

  let selectedCount = $derived(selectedPublications.size);

  function looksLikeUrl(value: string): boolean {
    const trimmed = value.trim();
    return (
      trimmed.startsWith('http://') ||
      trimmed.startsWith('https://') ||
      (trimmed.includes('.') && !trimmed.includes(' ') && trimmed.length > 4)
    );
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

  let subscribingStandardSub = $state<string | null>(null);

  // Cross-type duplicate pairs the just-added subs form with existing sources.
  // crossTypeDuplicatesForAdded derives each added sub's hosts from the sub
  // itself (its feedUrl host is set immediately, even before siteUrl resolves),
  // so this matches identically to the /sources scan. Deduped to one notice per
  // shared host — UnifyNotice is keyed and dismissed per host.
  function detectUnifyPairs(added: Array<{ id: number }>): CrossTypeDuplicate[] {
    const subs = subscriptionsStore.subscriptions;
    const byHost = new Map<string, CrossTypeDuplicate>();
    for (const { id } of added) {
      const sub = subscriptionsStore.getById(id);
      if (!sub) continue;
      for (const pair of crossTypeDuplicatesForAdded(subs, sub)) {
        if (!byHost.has(pair.host)) byHost.set(pair.host, pair);
      }
    }
    return [...byHost.values()];
  }

  // After adding, either pause on the unify notice or open the kept feed.
  function settleAdd(pairs: CrossTypeDuplicate[], keptId: number | null) {
    if (pairs.length > 0) {
      // Clear the other dropdown sections so only the unify notice shows.
      searchResults = [];
      discoveredFeeds = [];
      publications = [];
      selectedPublications = new Set();
      selectedAccount = null;
      unifyPairs = pairs;
      unifyKeptFeedId = keptId;
      mode = 'unify';
      return;
    }
    reset();
    if (keptId != null) goto(`/feeds?feed=${keptId}`);
    sidebarStore.closeMobile();
    inputFocused = false;
  }

  // Resolve one unify pair; when the last is handled, open the surviving feed.
  async function resolveUnify(
    pair: CrossTypeDuplicate,
    action: 'keep-rss' | 'keep-standard' | 'keep-both'
  ) {
    let removedId: number | null = null;
    if (action === 'keep-rss') {
      removedId = pair.standard.id ?? null;
      if (removedId != null) await subscriptionsStore.remove(removedId);
      unifyKeptFeedId = pair.rss.id ?? unifyKeptFeedId;
    } else if (action === 'keep-standard') {
      removedId = pair.rss.id ?? null;
      if (removedId != null) await subscriptionsStore.remove(removedId);
      unifyKeptFeedId = pair.standard.id ?? unifyKeptFeedId;
    } else {
      dismissUnifyHost(pair.host);
    }
    // Drop the resolved pair, every pair on a host we just dismissed, and any
    // pair left dangling because it referenced the sub we removed (a host can
    // carry more than one feed of the same side).
    unifyPairs = unifyPairs.filter(
      (p) =>
        p !== pair &&
        (action !== 'keep-both' || p.host !== pair.host) &&
        (removedId == null || (p.rss.id !== removedId && p.standard.id !== removedId))
    );
    if (unifyPairs.length === 0) {
      const id = unifyKeptFeedId;
      reset();
      if (id != null) goto(`/feeds?feed=${id}`);
      sidebarStore.closeMobile();
      inputFocused = false;
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
      void fetchAllDocuments(subscriptionsStore.subscriptions);
      settleAdd(detectUnifyPairs([{ id: subId }]), subId);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to subscribe';
    } finally {
      subscribingStandardSub = null;
    }
  }

  function handleFocus() {
    inputFocused = true;
    loadStandardSubscriptions();
  }

  function reset() {
    inputValue = '';
    mode = 'idle';
    error = null;
    searchResults = [];
    discoveredFeeds = [];
    selectedAccount = null;
    isDetecting = false;
    publications = [];
    selectedPublications = new Set();
    isSubscribing = false;
    unifyPairs = [];
    unifyKeptFeedId = null;
    if (searchTimeout) clearTimeout(searchTimeout);
  }

  function handleInput() {
    error = null;

    if (searchTimeout) clearTimeout(searchTimeout);

    const trimmed = inputValue.trim();
    if (trimmed.length < 2) {
      searchResults = [];
      mode = 'idle';
      return;
    }

    // If it looks like a URL, don't search actors
    if (looksLikeUrl(trimmed)) {
      searchResults = [];
      mode = 'idle';
      return;
    }

    // Search for bluesky actors
    mode = 'searching-actors';
    searchTimeout = setTimeout(async () => {
      try {
        searchResults = await searchBlueskyActors(trimmed, 5);
      } catch {
        searchResults = [];
      } finally {
        if (mode === 'searching-actors') {
          mode = searchResults.length > 0 ? 'searching-actors' : 'idle';
        }
      }
    }, 300);
  }

  async function handleSubmit() {
    const trimmed = inputValue.trim();
    if (!trimmed) return;

    // If it looks like a URL or we're in idle mode with text, try feed discovery
    error = null;
    mode = 'discovering-feeds';
    discoveredFeeds = [];

    try {
      // Ensure the URL has a protocol
      let url = trimmed;
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
      }

      const result = await api.discoverFeedsV2(url);
      if (result.feeds.length === 0) {
        error = 'No feeds found at this URL';
        mode = 'idle';
      } else if (result.feeds.length === 1) {
        await addFeed(result.feeds[0]);
      } else {
        discoveredFeeds = result.feeds;
        mode = 'select-feeds';
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to discover feeds';
      mode = 'idle';
    }
  }

  async function addFeed(url: string) {
    error = null;
    try {
      const tempTitle = new URL(url).hostname;
      const id = await subscriptionsStore.add(url, tempTitle, {});
      const sub = subscriptionsStore.getById(id);

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

      settleAdd(detectUnifyPairs([{ id }]), id);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to add feed';
      mode = 'idle';
    }
  }

  async function selectAccount(account: BlueskySearchResult) {
    selectedAccount = account;
    inputValue = '';
    searchResults = [];
    mode = 'select-content';
    isDetecting = true;
    error = null;
    publications = [];
    selectedPublications = new Set();

    try {
      const result = await api.detectContent(account.did);
      publications = result.publications;

      // Pre-select unsubscribed items
      for (const pub of result.publications) {
        if (!subscribedKeys.has(pub.uri)) {
          selectedPublications.add(pub.uri);
        }
      }
      selectedPublications = new Set(selectedPublications);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to detect content';
    } finally {
      isDetecting = false;
    }
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

  async function handleSubscribe() {
    if (!selectedAccount || selectedCount === 0) return;
    if (!subscriptionsStore.canAddMore) {
      error = 'Subscription limit reached';
      return;
    }

    error = null;
    isSubscribing = true;
    let firstAddedId: number | null = null;
    const added: Array<{ id: number }> = [];

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
        added.push({ id: subId });
        if (!firstAddedId) firstAddedId = subId;
        if (pub.iconUrl) {
          await subscriptionsStore.updateLocal(subId, {
            customIconUrl: pub.iconUrl,
          });
        }
      }

      socialStore.loadFeed(true);
      void fetchAllDocuments(subscriptionsStore.subscriptions);
      settleAdd(detectUnifyPairs(added), firstAddedId);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to subscribe';
    } finally {
      isSubscribing = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      reset();
      inputEl?.blur();
    }
  }

  function handleClickOutside(e: MouseEvent) {
    if (
      dropdownEl &&
      !dropdownEl.contains(e.target as Node) &&
      inputEl &&
      !inputEl.contains(e.target as Node)
    ) {
      inputFocused = false;
      if (mode === 'searching-actors') {
        searchResults = [];
        mode = 'idle';
      }
    }
  }

  $effect(() => {
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  });

  let showStandardSubs = $derived(
    inputFocused &&
      mode === 'idle' &&
      inputValue.trim().length === 0 &&
      (isLoadingStandardSubs || standardSubs.length > 0)
  );

  let showDropdown = $derived(
    searchResults.length > 0 ||
      discoveredFeeds.length > 0 ||
      mode === 'select-content' ||
      mode === 'discovering-feeds' ||
      mode === 'unify' ||
      showStandardSubs
  );
</script>

<div class="sidebar-add-feed">
  <form
    class="add-feed-form"
    onsubmit={(e) => {
      e.preventDefault();
      handleSubmit();
    }}
  >
    <input
      bind:this={inputEl}
      type="text"
      class="add-feed-input"
      placeholder="Add feed, URL, or @handle..."
      bind:value={inputValue}
      oninput={handleInput}
      onkeydown={handleKeydown}
      onfocus={handleFocus}
      disabled={mode === 'discovering-feeds' || mode === 'select-content'}
    />
    {#if inputValue || mode !== 'idle'}
      <button type="button" class="clear-btn" onclick={reset} title="Clear">
        <Icon name="x" size={12} strokeWidth={2.5} />
      </button>
    {/if}
  </form>

  {#if error}
    <div class="inline-error">{error}</div>
  {/if}

  {#if showDropdown}
    <div class="dropdown" bind:this={dropdownEl}>
      {#if mode === 'unify'}
        <div class="unify-dropdown">
          {#each unifyPairs as pair (`${pair.host}:${pair.rss.id}:${pair.standard.id}`)}
            <UnifyNotice
              {pair}
              onKeepRss={() => resolveUnify(pair, 'keep-rss')}
              onKeepStandard={() => resolveUnify(pair, 'keep-standard')}
              onKeepBoth={() => resolveUnify(pair, 'keep-both')}
            />
          {/each}
        </div>
      {:else if showStandardSubs}
        {#if isLoadingStandardSubs}
          <div class="dropdown-status">
            <span class="spinner"></span>
            <span>Loading subscriptions...</span>
          </div>
        {:else}
          <div class="dropdown-label standard-label">
            <Icon name="standard-site" size={12} /> Your standard.site subscriptions
          </div>
          {#each standardSubs as sub (sub.uri)}
            {@const isSubscribed = subscribedPublisherDids.has(sub.publisherDid)}
            <div class="dropdown-item standard-sub-item">
              <span class="standard-sub-info">
                <span class="standard-sub-name">{sub.publication.name}</span>
                <span class="standard-sub-url">{sub.publication.url}</span>
              </span>
              {#if isSubscribed}
                <span class="sub-badge">Subscribed</span>
              {:else}
                <button
                  class="sub-subscribe-btn"
                  onclick={() => subscribeStandardSub(sub)}
                  disabled={subscribingStandardSub === sub.uri}
                >
                  {subscribingStandardSub === sub.uri ? '...' : 'Subscribe'}
                </button>
              {/if}
            </div>
          {/each}
        {/if}
      {/if}

      {#if mode === 'discovering-feeds'}
        <div class="dropdown-status">
          <span class="spinner"></span>
          <span>Discovering feeds...</span>
        </div>
      {/if}

      {#if searchResults.length > 0}
        {#each searchResults as result (result.did)}
          <button class="dropdown-item actor-item" onclick={() => selectAccount(result)}>
            {#if result.avatar}
              <img src={result.avatar} alt="" class="actor-avatar" />
            {:else}
              <span class="actor-avatar-placeholder"></span>
            {/if}
            <span class="actor-info">
              <span class="actor-name">{result.displayName || result.handle}</span>
              <span class="actor-handle">@{result.handle}</span>
            </span>
          </button>
        {/each}
      {/if}

      {#if discoveredFeeds.length > 1}
        <div class="dropdown-label">Multiple feeds found:</div>
        {#each discoveredFeeds as url}
          <button class="dropdown-item feed-item" onclick={() => addFeed(url)}>
            <Icon name="rss" size={14} />
            <span class="feed-url">{url}</span>
          </button>
        {/each}
      {/if}

      {#if mode === 'select-content' && selectedAccount}
        <div class="content-section">
          <div class="content-header">
            <button class="back-link" onclick={reset}>
              <Icon name="arrow-left" size={14} strokeWidth={2} />
              Back
            </button>
            <div class="content-account">
              {#if selectedAccount.avatar}
                <img src={selectedAccount.avatar} alt="" class="actor-avatar-sm" />
              {/if}
              <span class="actor-handle-sm">@{selectedAccount.handle}</span>
            </div>
          </div>

          {#if isDetecting}
            <div class="dropdown-status">
              <span class="spinner"></span>
              <span>Detecting content...</span>
            </div>
          {:else if publications.length === 0}
            <div class="no-content">
              No publications found for @{selectedAccount.handle}.
            </div>
          {:else}
            <div class="content-group">
              {#each publications as pub (pub.uri)}
                {@const isSubscribed = subscribedKeys.has(pub.uri)}
                <button
                  class="dropdown-item content-item"
                  class:selected={selectedPublications.has(pub.uri)}
                  class:is-subscribed={isSubscribed}
                  onclick={() => togglePublication(pub.uri)}
                  disabled={isSubscribed}
                >
                  <span
                    class="check"
                    class:checked={selectedPublications.has(pub.uri) || isSubscribed}
                  >
                    {#if selectedPublications.has(pub.uri) || isSubscribed}&#10003;{/if}
                  </span>
                  <span class="content-info">
                    <span class="content-name">{pub.name || pub.url}</span>
                    {#if pub.description}
                      <span class="content-desc">{pub.description}</span>
                    {/if}
                  </span>
                  {#if isSubscribed}
                    <span class="sub-badge">Subscribed</span>
                  {/if}
                </button>
              {/each}
            </div>

            {#if selectedCount > 0}
              <button class="subscribe-btn" onclick={handleSubscribe} disabled={isSubscribing}>
                {isSubscribing ? 'Subscribing...' : `Subscribe (${selectedCount})`}
              </button>
            {/if}
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .sidebar-add-feed {
    position: relative;
    padding: 0.25rem 0.25rem 0.125rem;
  }

  .add-feed-form {
    display: flex;
    align-items: center;
    position: relative;
  }

  .add-feed-input {
    width: 100%;
    padding: 0.375rem 1.5rem 0.375rem 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-sm);
    outline: none;
    box-sizing: border-box;
    transition: border-color 0.15s;
  }

  .add-feed-input::placeholder {
    color: var(--color-text-secondary);
    opacity: 0.7;
    font-size: var(--text-xs);
  }

  .add-feed-input:focus {
    border-color: var(--color-accent, #0085ff);
  }

  .clear-btn {
    position: absolute;
    right: 0.25rem;
    top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.125rem;
    color: var(--color-text-secondary);
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
  }

  .clear-btn:hover {
    color: var(--color-text);
  }

  .inline-error {
    font-size: var(--text-xs);
    color: var(--color-error, #e53e3e);
    padding: 0.125rem 0.5rem;
    margin-top: 0.125rem;
  }

  .dropdown {
    position: absolute;
    left: 0.25rem;
    right: 0.25rem;
    top: 100%;
    z-index: 100;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
    max-height: 320px;
    overflow-y: auto;
    margin-top: 0.25rem;
  }

  .unify-dropdown {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.5rem;
  }

  .dropdown-status {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    padding: 0.625rem 0.5rem;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }

  .dropdown-label {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    padding: 0.375rem 0.625rem 0.125rem;
    font-weight: var(--weight-medium);
  }

  .standard-label {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .dropdown-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.5rem 0.625rem;
    border: none;
    border-bottom: 1px solid var(--color-border);
    background: transparent;
    cursor: pointer;
    text-align: left;
    color: var(--color-text);
    font: inherit;
    transition: background-color 0.1s;
  }

  .dropdown-item:last-child {
    border-bottom: none;
  }

  .dropdown-item:hover:not(:disabled) {
    background: var(--color-bg-hover, rgba(0, 0, 0, 0.04));
  }

  .dropdown-item.is-subscribed {
    opacity: 0.5;
    cursor: default;
  }

  /* Actor items */
  .actor-avatar {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    flex-shrink: 0;
    object-fit: cover;
  }

  .actor-avatar-placeholder {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--color-border);
  }

  .actor-info {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .actor-name {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .actor-handle {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Standard sub items */
  .standard-sub-item {
    align-items: center;
    cursor: default;
  }

  .standard-sub-info {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
    gap: 0.0625rem;
  }

  .standard-sub-name {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .standard-sub-url {
    font-size: var(--text-2xs);
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sub-subscribe-btn {
    padding: 0.125rem 0.5rem;
    border: none;
    border-radius: 4px;
    background: var(--color-accent, #0085ff);
    color: white;
    font-size: var(--text-2xs);
    font-weight: var(--weight-medium);
    cursor: pointer;
    flex-shrink: 0;
    transition: opacity 0.15s;
  }

  .sub-subscribe-btn:hover:not(:disabled) {
    opacity: 0.85;
  }

  .sub-subscribe-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Feed URL items */
  .feed-url {
    font-size: var(--text-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  /* Content selection */
  .content-section {
    display: flex;
    flex-direction: column;
  }

  .content-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.625rem;
    border-bottom: 1px solid var(--color-border);
  }

  .back-link {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
    padding: 0.125rem 0.25rem;
    border-radius: 4px;
  }

  .back-link:hover {
    color: var(--color-text);
  }

  .content-account {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-width: 0;
  }

  .actor-avatar-sm {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    flex-shrink: 0;
    object-fit: cover;
  }

  .actor-handle-sm {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .content-item {
    align-items: flex-start;
  }

  .check {
    width: 14px;
    height: 14px;
    border: 1.5px solid var(--color-border);
    border-radius: 3px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: var(--text-3xs);
    margin-top: 1px;
    transition:
      background-color 0.15s,
      border-color 0.15s;
  }

  .check.checked {
    background: var(--color-accent, #0085ff);
    border-color: var(--color-accent, #0085ff);
    color: white;
  }

  .content-info {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
    gap: 0.0625rem;
  }

  .content-name {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }

  .content-desc {
    font-size: var(--text-2xs);
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .content-group {
    border: 1px solid var(--color-border);
    border-radius: 6px;
    margin: 0.25rem 0.375rem;
    overflow: hidden;
  }

  .no-content {
    padding: 0.625rem 0.5rem;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    text-align: center;
  }

  .content-group .dropdown-item {
    border-bottom: 1px solid var(--color-border);
  }

  .content-group .dropdown-item:last-child {
    border-bottom: none;
  }

  .sub-badge {
    font-size: var(--text-3xs);
    color: var(--color-text-secondary);
    background: var(--color-bg-secondary);
    padding: 0.0625rem 0.375rem;
    border-radius: 3px;
    flex-shrink: 0;
  }

  .subscribe-btn {
    margin: 0.375rem 0.5rem;
    padding: 0.375rem 0.5rem;
    border: none;
    border-radius: 6px;
    background: var(--color-accent, #0085ff);
    color: white;
    font-size: var(--text-xs);
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

  .spinner {
    width: 0.75rem;
    height: 0.75rem;
    border: 1.5px solid var(--color-border);
    border-top-color: var(--color-accent, #0085ff);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-color-scheme: dark) {
    .dropdown {
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }

    .dropdown-item:hover:not(:disabled) {
      background: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
    }
  }
</style>
