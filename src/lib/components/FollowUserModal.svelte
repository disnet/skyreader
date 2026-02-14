<script lang="ts">
  import { searchBlueskyActors, type BlueskySearchResult } from '$lib/services/blueskySearch';
  import { socialStore } from '$lib/stores/social.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import Modal from '$lib/components/common/Modal.svelte';

  interface Props {
    open: boolean;
    onclose: () => void;
  }

  let { open, onclose }: Props = $props();

  let userSearchQuery = $state('');
  let userSearchResults = $state<BlueskySearchResult[]>([]);
  let isUserSearching = $state(false);
  let userSearchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let showFollowLimitWarning = $state(false);
  let searchInputEl = $state<HTMLInputElement | null>(null);

  // Set of DIDs that user is already following
  let followedDids = $derived(new Set(socialStore.followedUsers.map((u) => u.did)));

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
    showFollowLimitWarning = false;

    if (userSearchDebounceTimer) {
      clearTimeout(userSearchDebounceTimer);
    }

    userSearchDebounceTimer = setTimeout(() => {
      searchUsers(userSearchQuery);
    }, 300);
  }

  async function followUser(did: string) {
    if (followedDids.has(did)) return;

    if (socialStore.isAtFollowLimit) {
      showFollowLimitWarning = true;
      return;
    }

    const success = await socialStore.followUser(did);
    if (success) {
      await socialStore.loadFollowedUsers();
      userSearchQuery = '';
      userSearchResults = [];
    }
  }

  function handleClose() {
    userSearchQuery = '';
    userSearchResults = [];
    showFollowLimitWarning = false;
    if (userSearchDebounceTimer) {
      clearTimeout(userSearchDebounceTimer);
    }
    onclose();
  }

  // Focus search input when modal opens
  $effect(() => {
    if (open) {
      requestAnimationFrame(() => {
        searchInputEl?.focus();
      });
    }
  });
</script>

<Modal {open} onclose={handleClose} title="Follow User">
  <div class="follow-user-content">
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

    {#if showFollowLimitWarning}
      <div class="follow-limit-warning">
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

    {#if userSearchResults.length > 0}
      <div class="search-results">
        {#each userSearchResults as result (result.did)}
          {@const isFollowed = followedDids.has(result.did)}
          <button
            class="search-result"
            class:is-followed={isFollowed}
            onclick={() => followUser(result.did)}
            disabled={isFollowed}
          >
            {#if result.avatar}
              <img src={result.avatar} alt="" class="result-avatar" />
            {:else}
              <span class="result-avatar-placeholder"></span>
            {/if}
            <span class="result-info">
              <span class="result-name">{result.displayName || result.handle}</span>
              <span class="result-handle">@{result.handle}</span>
            </span>
            {#if isFollowed}
              <span class="following-badge">Following</span>
            {:else}
              <span class="follow-btn">Follow</span>
            {/if}
          </button>
        {/each}
      </div>
    {:else if userSearchQuery.length >= 2 && !isUserSearching}
      <p class="no-results">No users found</p>
    {:else if userSearchQuery.length === 0}
      <p class="hint">Enter a Bluesky handle or name to search</p>
    {/if}
  </div>
</Modal>

<style>
  .follow-user-content {
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

  .follow-limit-warning {
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

  .search-result:hover:not(.is-followed) {
    background: var(--color-bg-secondary);
  }

  .search-result.is-followed {
    cursor: default;
    opacity: 0.7;
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

  .following-badge {
    font-size: 0.75rem;
    padding: 0.25rem 0.5rem;
    background: var(--color-sidebar-active);
    color: var(--color-primary);
    border-radius: 9999px;
    font-weight: 500;
    flex-shrink: 0;
  }

  .follow-btn {
    font-size: 0.8125rem;
    padding: 0.375rem 0.75rem;
    background: var(--color-primary);
    color: white;
    border-radius: 9999px;
    font-weight: 500;
    flex-shrink: 0;
  }

  .no-results,
  .hint {
    text-align: center;
    color: var(--color-text-secondary);
    font-size: 0.875rem;
    padding: 1rem;
  }
</style>
