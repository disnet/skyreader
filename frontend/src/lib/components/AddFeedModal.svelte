<script lang="ts">
  import { goto } from '$app/navigation';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { articlesStore } from '$lib/stores/articles.svelte';
  import { socialStore } from '$lib/stores/social.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { fetchSingleFeed, fetchAllDocuments } from '$lib/services/feedFetcher';
  import { api } from '$lib/services/api';
  import { syncStore } from '$lib/stores/sync.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import {
    crossTypeDuplicatesForAdded,
    type CrossTypeDuplicate,
  } from '$lib/services/subscriptionDedup';
  import { dismissUnifyHost } from '$lib/services/unifyDismiss';
  import Modal from '$lib/components/common/Modal.svelte';
  import UnifyNotice from '$lib/components/UnifyNotice.svelte';
  import LimitNotice from '$lib/components/LimitNotice.svelte';
  import { feedLimitLine } from '$lib/utils/limitCopy';
  import Icon from '$lib/components/Icon.svelte';

  type Step = 'input' | 'select-feeds' | 'unify';

  interface StandardSite {
    did: string;
    publicationUri: string;
    name: string;
    url?: string;
    description?: string;
    iconUrl?: string;
  }

  interface Props {
    open: boolean;
    onclose: () => void;
    initialValue?: string;
  }

  let { open, onclose, initialValue = '' }: Props = $props();
  let error = $state<string | null>(null);

  let inputValue = $state('');
  let step = $state<Step>('input');
  let isDiscovering = $state(false);
  let discoveredFeeds = $state<string[]>([]);
  let standardSite = $state<StandardSite | null>(null);

  // After an add that turns out to duplicate an existing source (the same site
  // followed by both RSS and standard.site), we hold here so the user can keep
  // one or both before leaving. `unifyKeptFeedId` is the feed to open once
  // resolved, updated to whichever sub survives each choice.
  let unifyPairs = $state<CrossTypeDuplicate[]>([]);
  let unifyKeptFeedId = $state<number | null>(null);

  const isAtLimit = $derived(
    subscriptionsStore.subscriptions.length >= subscriptionsStore.maxSubscriptions
  );

  // Pre-fill input when modal opens with an initial value
  $effect(() => {
    if (open && initialValue) {
      inputValue = initialValue;
    }
  });

  function resetAll() {
    inputValue = '';
    step = 'input';
    error = null;
    isDiscovering = false;
    isAdding = false;
    discoveredFeeds = [];
    standardSite = null;
    unifyPairs = [];
    unifyKeptFeedId = null;
  }

  function handleClose() {
    resetAll();
    onclose();
  }

  async function handleSubmit() {
    const trimmed = inputValue.trim();
    if (!trimmed) return;

    if (!syncStore.isOnline) {
      error = 'You are offline. Connect to the internet to add feeds.';
      return;
    }

    error = null;
    isDiscovering = true;
    discoveredFeeds = [];
    standardSite = null;

    try {
      let url = trimmed;
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
      }

      const result = await api.discoverFeedsV2(url);
      const site = result.standardSite ?? null;
      const feeds = result.feeds;
      // standard.site is the preferred option, so it counts ahead of RSS/Atom feeds.
      const candidateCount = (site ? 1 : 0) + feeds.length;

      if (candidateCount === 0) {
        error = 'No feeds found at this URL';
        isDiscovering = false;
      } else if (candidateCount === 1) {
        if (site) {
          await addStandardSite(site);
        } else {
          await addFeed(feeds[0]);
        }
      } else {
        standardSite = site;
        discoveredFeeds = feeds;
        step = 'select-feeds';
        isDiscovering = false;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to discover feeds';
      isDiscovering = false;
    }
  }

  let isAdding = $state(false);

  // Open the just-added feed and close, unless the add duplicates an existing
  // source on a shared host — then pause on the unify step instead. The added
  // sub already carries its feedUrl (and, for standard.site, its siteUrl), so
  // crossTypeDuplicatesForAdded derives the host from the sub itself.
  function finishAdd(id: number) {
    const sub = subscriptionsStore.getById(id);
    const pairs = sub ? crossTypeDuplicatesForAdded(subscriptionsStore.subscriptions, sub) : [];
    if (pairs.length > 0) {
      unifyPairs = pairs;
      unifyKeptFeedId = id;
      step = 'unify';
      isAdding = false;
      return;
    }
    handleClose();
    goto(`/feeds?feed=${id}`);
    sidebarStore.closeMobile();
  }

  async function addFeed(url: string) {
    if (isAdding) return;
    isAdding = true;
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

      finishAdd(id);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to add feed';
      isDiscovering = false;
      isAdding = false;
    }
  }

  async function addStandardSite(site: StandardSite) {
    if (isAdding) return;
    isAdding = true;
    error = null;
    try {
      const id = await subscriptionsStore.add(site.publicationUri, site.name, {
        sourceType: 'atproto.documents',
        subjectDid: site.did,
        siteUrl: site.url,
        feedUrl: site.publicationUri,
      });

      if (site.iconUrl) {
        try {
          await subscriptionsStore.updateLocal(id, {
            customIconUrl: site.iconUrl,
          });
        } catch {
          // Ignore errors setting the icon
        }
      }

      socialStore.loadFeed(true);
      // Fetch this publication's documents now so they appear immediately
      // (also refreshed on the regular cycle).
      void fetchAllDocuments(subscriptionsStore.subscriptions);
      finishAdd(id);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to add subscription';
      isDiscovering = false;
      isAdding = false;
    }
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
      handleClose();
      if (id != null) goto(`/feeds?feed=${id}`);
      sidebarStore.closeMobile();
    }
  }

  function goBackToInput() {
    step = 'input';
    discoveredFeeds = [];
    standardSite = null;
    error = null;
  }
</script>

<Modal {open} onclose={handleClose} title="Add RSS Feed">
  {#if step === 'unify'}
    <div class="modal-content">
      {#each unifyPairs as pair (`${pair.host}:${pair.rss.id}:${pair.standard.id}`)}
        <UnifyNotice
          {pair}
          onKeepRss={() => resolveUnify(pair, 'keep-rss')}
          onKeepStandard={() => resolveUnify(pair, 'keep-standard')}
          onKeepBoth={() => resolveUnify(pair, 'keep-both')}
        />
      {/each}
    </div>
  {:else if auth.isGuest}
    <div class="modal-content">
      <p class="modal-desc">
        Adding a feed needs an account. The starter channels stay where they are, and everything you
        have read or saved here comes with you.
      </p>
      <a class="signin-btn" href="/auth/login?returnUrl=/feeds" onclick={handleClose}>Sign in</a>
    </div>
  {:else if isAtLimit}
    <div class="limit-wrap">
      <LimitNotice kind="feeds">
        <p>{feedLimitLine(subscriptionsStore.maxSubscriptions)}</p>
        <p class="limit-aside">Parked feeds stay saved to your account, nothing is deleted.</p>
      </LimitNotice>
    </div>
  {:else if step === 'input'}
    <div class="modal-content">
      <p class="modal-desc">Enter an RSS/Atom feed URL or a website URL to discover feeds.</p>
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
            placeholder="https://example.com/feed.xml"
            bind:value={inputValue}
            disabled={isDiscovering}
            autofocus
          />
          <button type="submit" class="add-btn" disabled={isDiscovering || !inputValue.trim()}>
            {isDiscovering ? 'Adding...' : 'Add'}
          </button>
        </div>
      </form>
    </div>
  {:else if step === 'select-feeds'}
    <div class="modal-content">
      <button class="back-btn" onclick={goBackToInput}>&#8249; Back</button>
      <p class="section-label">Multiple feeds found — select one:</p>
      {#if standardSite}
        <button
          class="result-btn standard-btn"
          onclick={() => standardSite && addStandardSite(standardSite)}
          disabled={isAdding}
        >
          {#if standardSite.iconUrl}
            <img class="result-icon" src={standardSite.iconUrl} alt="" />
          {/if}
          <span class="result-info">
            <span class="result-name">
              {standardSite.name}
              <span class="badge"><Icon name="standard-site" size={12} />standard.site</span>
            </span>
            {#if standardSite.url}
              <span class="result-sub feed-url">{standardSite.url}</span>
            {/if}
          </span>
        </button>
        {#if discoveredFeeds.length > 0}
          <p class="section-label">Or subscribe via RSS/Atom:</p>
        {/if}
      {/if}
      {#if discoveredFeeds.length > 0}
        <div class="search-results">
          {#each discoveredFeeds as url}
            <button class="result-btn" onclick={() => addFeed(url)} disabled={isAdding}>
              <span class="result-info">
                <span class="result-name feed-url">{url}</span>
              </span>
            </button>
          {/each}
        </div>
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
    min-height: 100px;
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

  .add-btn {
    padding: 0.625rem 1rem;
    border: none;
    border-radius: 8px;
    background: var(--color-accent, #0085ff);
    color: white;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
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

  /* One Blue (DESIGN.md): --color-primary, not the undefined --color-accent
     the buttons above fall back from. */
  .signin-btn {
    align-self: flex-start;
    padding: 0.625rem 1rem;
    border-radius: 8px;
    background: var(--color-primary, #0066cc);
    color: white;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    text-decoration: none;
    transition: opacity 0.15s;
  }

  .signin-btn:hover {
    opacity: 0.9;
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

  .result-btn:hover:not(:disabled) {
    background: var(--color-bg-secondary);
  }

  .result-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .standard-btn {
    border: 1px solid var(--color-accent, #0085ff);
    border-radius: 8px;
    background: color-mix(in srgb, var(--color-accent, #0085ff) 8%, transparent);
  }

  .standard-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-accent, #0085ff) 14%, transparent);
  }

  .result-icon {
    width: 24px;
    height: 24px;
    border-radius: 6px;
    object-fit: cover;
    flex-shrink: 0;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    margin-left: 0.4rem;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    background: var(--color-accent, #0085ff);
    color: white;
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    vertical-align: middle;
  }

  .result-sub {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
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

  .feed-url {
    font-weight: var(--weight-regular);
    word-break: break-all;
    white-space: normal;
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

  .section-label {
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wide);
    margin: 0;
  }

  .limit-wrap {
    padding: 1rem;
  }

  .limit-aside {
    color: var(--color-text-secondary);
  }

  .error-message {
    color: var(--color-error);
    font-size: var(--text-md);
    margin-top: 0.5rem;
  }

  @media (max-width: 600px) {
    .search-input {
      font-size: var(--text-base);
    }
  }
</style>
