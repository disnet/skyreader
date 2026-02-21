<script lang="ts">
  import { searchBlueskyActors, type BlueskySearchResult } from '$lib/services/blueskySearch';
  import { socialStore } from '$lib/stores/social.svelte';
  import { auth } from '$lib/stores/auth.svelte';

  interface Props {
    followedDids: Set<string>;
    onFollow: (did: string) => void;
  }

  let { followedDids, onFollow }: Props = $props();

  let query = $state('');
  let results = $state<BlueskySearchResult[]>([]);
  let isSearching = $state(false);
  let isOpen = $state(false);
  let selectedIndex = $state(-1);
  let showLimitWarning = $state(false);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let containerRef: HTMLDivElement | undefined = $state();
  let inputRef: HTMLInputElement | undefined = $state();

  async function search(searchQuery: string) {
    if (searchQuery.length < 2) {
      results = [];
      isOpen = false;
      return;
    }

    isSearching = true;
    try {
      const searchResults = await searchBlueskyActors(searchQuery, 6);
      results = searchResults;
      isOpen = searchResults.length > 0;
      selectedIndex = -1;
    } catch (error) {
      console.error('Search error:', error);
      results = [];
    } finally {
      isSearching = false;
    }
  }

  function handleInput(event: Event) {
    const target = event.target as HTMLInputElement;
    query = target.value;
    showLimitWarning = false;

    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      search(query);
    }, 300);
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!isOpen || results.length === 0) {
      return;
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        selectedIndex = Math.min(selectedIndex + 1, results.length - 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        selectedIndex = Math.max(selectedIndex - 1, -1);
        break;
      case 'Enter':
        event.preventDefault();
        if (selectedIndex >= 0 && selectedIndex < results.length) {
          selectUser(results[selectedIndex]);
        }
        break;
      case 'Escape':
        event.preventDefault();
        closeDropdown();
        break;
    }
  }

  function selectUser(user: BlueskySearchResult) {
    if (followedDids.has(user.did)) {
      return;
    }

    // Check follow limit
    if (socialStore.isAtFollowLimit) {
      showLimitWarning = true;
      return;
    }

    onFollow(user.did);
    closeDropdown();
  }

  function closeDropdown() {
    isOpen = false;
    selectedIndex = -1;
    query = '';
    results = [];
    showLimitWarning = false;
  }

  function handleClickOutside(event: MouseEvent) {
    if (containerRef && !containerRef.contains(event.target as Node)) {
      closeDropdown();
    }
  }

  function handleFocus() {
    if (results.length > 0) {
      isOpen = true;
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

  $effect(() => {
    return () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    };
  });
</script>

<div class="user-search-compact" bind:this={containerRef}>
  <div class="search-input-wrapper">
    <span class="search-icon">@</span>
    <input
      bind:this={inputRef}
      type="text"
      class="search-input"
      placeholder="Follow user..."
      value={query}
      oninput={handleInput}
      onkeydown={handleKeydown}
      onfocus={handleFocus}
    />
    {#if isSearching}
      <div class="search-spinner"></div>
    {/if}
  </div>

  {#if showLimitWarning}
    <div class="limit-warning">
      Follow limit reached ({socialStore.followLimit} max).
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

  {#if isOpen && results.length > 0}
    <div class="dropdown">
      {#each results as user, index (user.did)}
        {@const isFollowed = followedDids.has(user.did)}
        <button
          class="result-item"
          class:selected={index === selectedIndex}
          class:is-followed={isFollowed}
          onclick={() => selectUser(user)}
          onmouseenter={() => (selectedIndex = index)}
        >
          {#if user.avatar}
            <img src={user.avatar} alt="" class="result-avatar" />
          {:else}
            <div class="result-avatar-placeholder"></div>
          {/if}
          <div class="result-info">
            <span class="result-name">{user.displayName || user.handle}</span>
            <span class="result-handle">@{user.handle}</span>
          </div>
          {#if isFollowed}
            <span class="following-badge">Following</span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .user-search-compact {
    position: relative;
    padding: 0.25rem 0.75rem;
    padding-left: 2.75rem;
  }

  .search-input-wrapper {
    position: relative;
    display: flex;
    align-items: center;
  }

  .search-icon {
    position: absolute;
    left: 0.5rem;
    color: var(--color-text-secondary);
    display: flex;
    align-items: center;
    pointer-events: none;
  }

  .search-input {
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

  .search-input:focus {
    outline: none;
    border-color: var(--color-primary);
  }

  .search-input::placeholder {
    color: var(--color-text-secondary);
  }

  .search-spinner {
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

  .limit-warning {
    margin-top: 0.25rem;
    padding: 0.25rem 0.5rem;
    font-size: 0.75rem;
    color: var(--color-warning, #ff9800);
    background: rgba(255, 152, 0, 0.1);
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
    max-height: 240px;
    overflow-y: auto;
    z-index: 100;
  }

  .result-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.5rem;
    background: none;
    border: none;
    text-align: left;
    cursor: pointer;
    color: var(--color-text);
    font: inherit;
    transition: background-color 0.1s;
  }

  .result-item:first-child {
    border-radius: 7px 7px 0 0;
  }

  .result-item:last-child {
    border-radius: 0 0 7px 7px;
  }

  .result-item:only-child {
    border-radius: 7px;
  }

  .result-item:hover,
  .result-item.selected {
    background: var(--color-bg-secondary);
  }

  .result-item.is-followed {
    cursor: default;
    opacity: 0.6;
  }

  .result-avatar {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .result-avatar-placeholder {
    width: 24px;
    height: 24px;
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
    font-size: 0.8125rem;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .result-handle {
    font-size: 0.75rem;
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .following-badge {
    font-size: 0.625rem;
    padding: 0.125rem 0.375rem;
    background: var(--color-sidebar-active);
    color: var(--color-primary);
    border-radius: 9999px;
    font-weight: 500;
    flex-shrink: 0;
  }
</style>
