<script lang="ts">
  import { onMount } from 'svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { articlesStore } from '$lib/stores/articles.svelte';
  import { api } from '$lib/services/api';
  import { fetchSingleFeed } from '$lib/services/feedFetcher';
  import StateView from '$lib/components/common/StateView.svelte';
  import Modal from '$lib/components/common/Modal.svelte';
  import Icon from '$lib/components/Icon.svelte';

  type StandardSub = {
    uri: string;
    publication: {
      uri: string;
      name: string;
      url: string;
      description?: string;
    };
  };

  let standardSubscriptions = $state<StandardSub[]>([]);
  let isLoadingStandard = $state(false);
  let standardError = $state<string | null>(null);
  let addingFeeds = $state<Set<string>>(new Set());
  let addedFeeds = $state<Set<string>>(new Set());
  let feedPickerSub = $state<StandardSub | null>(null);
  let discoveredFeeds = $state<string[]>([]);
  let isAddingAll = $state(false);
  let addAllProgress = $state<{ done: number; total: number } | null>(null);

  function isAlreadySubscribed(pubUrl: string): boolean {
    if (addedFeeds.has(pubUrl)) return true;
    const subs = subscriptionsStore.subscriptions;
    const pubLower = pubUrl.toLowerCase();
    let pubHostname: string | null = null;
    try {
      pubHostname = new URL(pubUrl).hostname;
    } catch {
      // invalid URL, skip hostname matching
    }
    return subs.some((s) => {
      if (s.feedUrl?.toLowerCase() === pubLower) return true;
      if (s.siteUrl?.toLowerCase() === pubLower) return true;
      if (pubHostname && s.feedUrl) {
        try {
          if (new URL(s.feedUrl).hostname === pubHostname) return true;
        } catch {
          /* skip */
        }
        if (s.siteUrl) {
          try {
            if (new URL(s.siteUrl).hostname === pubHostname) return true;
          } catch {
            /* skip */
          }
        }
      }
      return false;
    });
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
    isLoadingStandard = true;
    standardError = null;
    try {
      const pdsUrl = auth.user?.pdsUrl;
      const did = auth.user?.did;
      if (!pdsUrl || !did) {
        standardSubscriptions = [];
        return;
      }

      const params = new URLSearchParams({
        repo: did,
        collection: 'site.standard.graph.subscription',
        limit: '100',
      });
      const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`);
      if (!res.ok) {
        standardSubscriptions = [];
        return;
      }
      const data = (await res.json()) as {
        records: Array<{ uri: string; value: { publication?: string } }>;
      };

      if (data.records.length === 0) {
        standardSubscriptions = [];
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
            publication: {
              uri: entry.pubUri,
              name: pub.name || pub.url,
              url: pub.url,
              description: pub.description,
            },
          };
        })
      );

      standardSubscriptions = results
        .filter((r): r is PromiseFulfilledResult<StandardSub | null> => r.status === 'fulfilled')
        .map((r) => r.value)
        .filter((s): s is StandardSub => s !== null);
      addedFeeds = new Set();
    } catch (e) {
      standardError = e instanceof Error ? e.message : 'Failed to load subscriptions';
    } finally {
      isLoadingStandard = false;
    }
  }

  async function addAndFetch(feedUrl: string, title: string, siteUrl: string) {
    const id = await subscriptionsStore.add(feedUrl, title, { siteUrl });
    const sub = subscriptionsStore.getById(id);
    if (sub) {
      // Fetch feed in background so articles appear immediately
      fetchSingleFeed(sub, true, articlesStore.savedGuids);
    }
    return id;
  }

  async function handleAddSubscription(sub: StandardSub) {
    const pubUrl = sub.publication.url;
    addingFeeds.add(pubUrl);
    addingFeeds = new Set(addingFeeds);

    try {
      const result = await api.discoverFeedsV2(pubUrl);
      const feeds = result.feeds;

      if (feeds.length === 0) {
        standardError = `No RSS feed found for ${sub.publication.name}`;
      } else if (feeds.length === 1) {
        await addAndFetch(feeds[0], sub.publication.name, pubUrl);
        addedFeeds.add(pubUrl);
        addedFeeds = new Set(addedFeeds);
      } else {
        feedPickerSub = sub;
        discoveredFeeds = feeds;
      }
    } catch (e) {
      standardError = e instanceof Error ? e.message : 'Failed to add subscription';
    } finally {
      addingFeeds.delete(pubUrl);
      addingFeeds = new Set(addingFeeds);
    }
  }

  async function handlePickFeed(feedUrl: string) {
    if (!feedPickerSub) return;

    const sub = feedPickerSub;
    const pubUrl = sub.publication.url;
    feedPickerSub = null;
    discoveredFeeds = [];

    addingFeeds.add(pubUrl);
    addingFeeds = new Set(addingFeeds);

    try {
      await addAndFetch(feedUrl, sub.publication.name, pubUrl);
      addedFeeds.add(pubUrl);
      addedFeeds = new Set(addedFeeds);
    } catch (e) {
      standardError = e instanceof Error ? e.message : 'Failed to add subscription';
    } finally {
      addingFeeds.delete(pubUrl);
      addingFeeds = new Set(addingFeeds);
    }
  }

  let unaddedStandardSubs = $derived(
    standardSubscriptions.filter((sub) => !isAlreadySubscribed(sub.publication.url))
  );

  async function handleAddAll() {
    const toAdd = unaddedStandardSubs;
    if (toAdd.length === 0) return;

    isAddingAll = true;
    addAllProgress = { done: 0, total: toAdd.length };
    standardError = null;

    let skipped = 0;
    for (const sub of toAdd) {
      const pubUrl = sub.publication.url;
      try {
        const result = await api.discoverFeedsV2(pubUrl);
        const feeds = result.feeds;

        if (feeds.length >= 1) {
          await addAndFetch(feeds[0], sub.publication.name, pubUrl);
          addedFeeds.add(pubUrl);
          addedFeeds = new Set(addedFeeds);
        } else {
          skipped++;
        }
      } catch {
        skipped++;
      }
      addAllProgress = { done: addAllProgress!.done + 1, total: toAdd.length };
    }

    if (skipped > 0) {
      standardError = `${skipped} subscription${skipped === 1 ? '' : 's'} could not be added (no RSS feed found).`;
    }

    isAddingAll = false;
    addAllProgress = null;
  }

  onMount(() => {
    loadStandardSubscriptions();
  });
</script>

{#if standardError}
  <p class="error">{standardError}</p>
{/if}

<StateView
  isLoading={isLoadingStandard}
  isEmpty={standardSubscriptions.length === 0}
  loadingMessage="Loading subscriptions..."
  emptyTitle="No subscriptions found"
  emptyDescription="Subscribe to publications on standard.site or other AT Protocol publishing tools to see them here."
>
  {#if unaddedStandardSubs.length > 0}
    <div class="subscribe-all-bar">
      <button class="btn btn-primary" disabled={isAddingAll} onclick={handleAddAll}>
        {#if addAllProgress}
          Adding... ({addAllProgress.done}/{addAllProgress.total})
        {:else}
          Add All to Skyreader ({unaddedStandardSubs.length})
        {/if}
      </button>
    </div>
  {/if}

  <div class="subscriptions-list">
    {#each standardSubscriptions as sub (sub.uri)}
      {@const alreadyAdded = isAlreadySubscribed(sub.publication.url)}
      <div class="subscription-row card">
        <div class="subscription-info">
          <h3 class="subscription-name">{sub.publication.name}</h3>
          <a href={sub.publication.url} target="_blank" rel="noopener" class="subscription-url">
            {sub.publication.url}
          </a>
          {#if sub.publication.description}
            <p class="subscription-description">{sub.publication.description}</p>
          {/if}
        </div>
        <div class="subscription-actions">
          {#if alreadyAdded}
            <span class="already-added-badge">
              <Icon name="check" size={14} />
              Added
            </span>
          {:else}
            <button
              class="btn btn-primary"
              disabled={addingFeeds.has(sub.publication.url) || isAddingAll}
              onclick={() => handleAddSubscription(sub)}
            >
              {addingFeeds.has(sub.publication.url) ? 'Finding feed...' : 'Add to Skyreader'}
            </button>
          {/if}
        </div>
      </div>
    {/each}
  </div>
</StateView>

<Modal
  open={feedPickerSub !== null}
  onclose={() => {
    feedPickerSub = null;
    discoveredFeeds = [];
  }}
  title="Choose a Feed"
>
  <div class="feed-picker-content">
    <p>Multiple RSS feeds were found for <strong>{feedPickerSub?.publication.name}</strong>:</p>
    <div class="feed-picker-list">
      {#each discoveredFeeds as feed}
        <button class="feed-picker-option btn btn-outline" onclick={() => handlePickFeed(feed)}>
          {feed}
        </button>
      {/each}
    </div>
  </div>
</Modal>

<style>
  .error {
    color: var(--color-error, #dc3545);
    padding: 1rem;
    background: var(--color-error-bg, #f8d7da);
    border-radius: 8px;
    margin-bottom: 1rem;
  }

  .subscribe-all-bar {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 0.75rem;
  }

  .subscriptions-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .subscription-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem;
    gap: 1rem;
  }

  .subscription-info {
    flex: 1;
    min-width: 0;
  }

  .subscription-name {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: var(--color-text);
  }

  .subscription-url {
    display: block;
    font-size: 0.875rem;
    color: var(--color-text-secondary);
    text-decoration: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-top: 0.25rem;
  }

  .subscription-url:hover {
    color: var(--color-primary);
    text-decoration: underline;
  }

  .subscription-description {
    margin: 0.5rem 0 0;
    font-size: 0.875rem;
    color: var(--color-text-secondary);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .subscription-actions {
    flex-shrink: 0;
  }

  .already-added-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.875rem;
    color: var(--color-success, #28a745);
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-success, #28a745);
    border-radius: 6px;
  }

  .feed-picker-content p {
    margin: 0 0 1rem;
    color: var(--color-text-secondary);
  }

  .feed-picker-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .feed-picker-option {
    text-align: left;
    word-break: break-all;
    font-size: 0.875rem;
  }

  @media (max-width: 600px) {
    .subscription-row {
      flex-direction: column;
      align-items: stretch;
    }

    .subscription-actions {
      display: flex;
    }

    .subscription-actions .btn {
      flex: 1;
    }
  }
</style>
