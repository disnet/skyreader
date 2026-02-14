<script lang="ts">
  import { api } from '$lib/services/api';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { articlesStore } from '$lib/stores/articles.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { fetchSingleFeed } from '$lib/services/feedFetcher';
  import Icon from '../Icon.svelte';

  let feedUrl = $state('');
  let isAdding = $state(false);
  let error = $state<string | null>(null);
  let discoveredFeeds = $state<string[]>([]);
  let isOpen = $state(false);
  let selectedIndex = $state(-1);
  let containerRef: HTMLDivElement | undefined = $state();
  let inputRef: HTMLInputElement | undefined = $state();

  const isAtLimit = $derived(
    subscriptionsStore.subscriptions.length >= subscriptionsStore.maxSubscriptions
  );

  async function addFeed() {
    if (!feedUrl.trim() || isAdding) return;

    if (isAtLimit) {
      error = `Feed limit reached (${subscriptionsStore.maxSubscriptions} max)`;
      return;
    }

    error = null;
    isAdding = true;
    discoveredFeeds = [];

    try {
      const result = await api.discoverFeedsV2(feedUrl.trim());
      if (result.feeds.length === 0) {
        error = 'No feeds found at this URL';
      } else if (result.feeds.length === 1) {
        await selectFeed(result.feeds[0]);
      } else {
        discoveredFeeds = result.feeds;
        isOpen = true;
        selectedIndex = -1;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to discover feeds';
    } finally {
      isAdding = false;
    }
  }

  async function selectFeed(url: string) {
    error = null;
    isAdding = true;

    try {
      // Add subscription with URL as temporary title
      const tempTitle = new URL(url).hostname;
      const id = await subscriptionsStore.add(url, tempTitle, {});
      const sub = subscriptionsStore.getById(id);

      // Reset form immediately
      reset();

      // Fetch feed in background (updates title and loads articles)
      if (sub) {
        fetchSingleFeed(sub, true, articlesStore.starredGuids).then(async (result) => {
          // Update subscription with feed metadata from V2 response
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
      isAdding = false;
    }
  }

  function reset() {
    feedUrl = '';
    isAdding = false;
    error = null;
    discoveredFeeds = [];
    isOpen = false;
    selectedIndex = -1;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !isOpen) {
      event.preventDefault();
      addFeed();
      return;
    }

    if (!isOpen || discoveredFeeds.length === 0) {
      return;
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        selectedIndex = Math.min(selectedIndex + 1, discoveredFeeds.length - 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        selectedIndex = Math.max(selectedIndex - 1, -1);
        break;
      case 'Enter':
        event.preventDefault();
        if (selectedIndex >= 0 && selectedIndex < discoveredFeeds.length) {
          selectFeed(discoveredFeeds[selectedIndex]);
        }
        break;
      case 'Escape':
        event.preventDefault();
        isOpen = false;
        selectedIndex = -1;
        break;
    }
  }

  function handleClickOutside(event: MouseEvent) {
    if (containerRef && !containerRef.contains(event.target as Node)) {
      isOpen = false;
      selectedIndex = -1;
    }
  }

  $effect(() => {
    if (isOpen) {
      document.addEventListener('click', handleClickOutside);
      return () => {
        document.removeEventListener('click', handleClickOutside);
      };
    }
  });
</script>

<div class="feed-add-compact" bind:this={containerRef}>
  <div class="input-wrapper">
    <span class="input-icon">
      <Icon name="rss" size={14} />
    </span>
    <input
      bind:this={inputRef}
      type="text"
      class="feed-input"
      placeholder="Add website or RSS feed..."
      bind:value={feedUrl}
      onkeydown={handleKeydown}
      disabled={isAdding}
    />
    {#if isAdding}
      <div class="spinner"></div>
    {/if}
  </div>

  {#if error}
    <div class="error-message">
      {error}
      {#if isAtLimit && auth.user?.tier !== 'supporter'}
        <a
          href="https://github.com/sponsors/disnet"
          target="_blank"
          rel="noopener noreferrer"
          class="sponsor-link">Become a sponsor</a
        > to get raised limits.
      {/if}
    </div>
  {/if}

  {#if isOpen && discoveredFeeds.length > 0}
    <div class="dropdown">
      <div class="dropdown-header">Multiple feeds found:</div>
      {#each discoveredFeeds as url, index (url)}
        <button
          class="feed-option"
          class:selected={index === selectedIndex}
          onclick={() => selectFeed(url)}
          onmouseenter={() => (selectedIndex = index)}
          disabled={isAdding}
        >
          {url}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .feed-add-compact {
    position: relative;
    padding: 0.25rem 0.75rem;
    padding-left: 1.5rem;
  }

  .input-wrapper {
    position: relative;
    display: flex;
    align-items: center;
  }

  .input-icon {
    position: absolute;
    left: 0.5rem;
    color: var(--color-text-secondary);
    display: flex;
    align-items: center;
    pointer-events: none;
  }

  .feed-input {
    width: 100%;
    padding: 0.375rem 0.5rem;
    padding-left: 1.75rem;
    font-size: 0.8125rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-text);
    transition: border-color 0.15s;
  }

  .feed-input:focus {
    outline: none;
    border-color: var(--color-primary);
  }

  .feed-input::placeholder {
    color: var(--color-text-secondary);
  }

  .feed-input:disabled {
    opacity: 0.6;
  }

  .spinner {
    position: absolute;
    right: 0.5rem;
    width: 0.75rem;
    height: 0.75rem;
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

  .error-message {
    margin-top: 0.25rem;
    padding: 0.25rem 0.5rem;
    font-size: 0.75rem;
    color: var(--color-error, #f44336);
    background: rgba(244, 67, 54, 0.1);
    border-radius: 4px;
  }

  .sponsor-link {
    color: var(--color-primary);
    text-decoration: none;
  }

  .sponsor-link:hover {
    text-decoration: underline;
  }

  .dropdown {
    position: absolute;
    top: 100%;
    left: 0.75rem;
    right: 0.75rem;
    margin-top: 4px;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 4px 12px var(--color-shadow, rgba(0, 0, 0, 0.15));
    max-height: 200px;
    overflow-y: auto;
    z-index: 100;
  }

  .dropdown-header {
    padding: 0.5rem;
    font-size: 0.75rem;
    color: var(--color-text-secondary);
    border-bottom: 1px solid var(--color-border);
  }

  .feed-option {
    display: block;
    width: 100%;
    padding: 0.5rem;
    background: none;
    border: none;
    text-align: left;
    cursor: pointer;
    color: var(--color-text);
    font: inherit;
    font-size: 0.75rem;
    word-break: break-all;
    transition: background-color 0.1s;
  }

  .feed-option:hover,
  .feed-option.selected {
    background: var(--color-bg-secondary);
  }

  .feed-option:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .feed-option:last-child {
    border-radius: 0 0 7px 7px;
  }
</style>
