<script lang="ts">
  import { goto } from '$app/navigation';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { articlesStore } from '$lib/stores/articles.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { fetchSingleFeed } from '$lib/services/feedFetcher';
  import { api } from '$lib/services/api';
  import { syncStore } from '$lib/stores/sync.svelte';
  import Modal from '$lib/components/common/Modal.svelte';

  type Step = 'input' | 'select-feeds';

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
    discoveredFeeds = [];
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

  let isAdding = $state(false);

  async function addFeed(url: string) {
    if (isAdding) return;
    isAdding = true;
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
      isAdding = false;
    }
  }

  function goBackToInput() {
    step = 'input';
    discoveredFeeds = [];
    error = null;
  }
</script>

<Modal {open} onclose={handleClose} title="Add RSS Feed">
  {#if isAtLimit}
    <p class="limit-message">
      You've reached the maximum of {subscriptionsStore.maxSubscriptions} feeds. Remove some feeds to
      add new ones.
    </p>
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
      <div class="search-results">
        {#each discoveredFeeds as url}
          <button class="result-btn" onclick={() => addFeed(url)} disabled={isAdding}>
            <span class="result-info">
              <span class="result-name feed-url">{url}</span>
            </span>
          </button>
        {/each}
      </div>
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
    font-size: 0.875rem;
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

  .section-label {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.03em;
    margin: 0;
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

  @media (max-width: 600px) {
    .search-input {
      font-size: 16px;
    }
  }
</style>
