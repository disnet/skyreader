<script lang="ts">
  import { api } from '$lib/services/api';
  import { searchBlueskyActors, type BlueskySearchResult } from '$lib/services/blueskySearch';
  import Logo from '$lib/assets/logo.svg';

  let handle = $state('');
  let isLoading = $state(false);
  let error = $state('');

  // Autocomplete state
  let results = $state<BlueskySearchResult[]>([]);
  let isSearching = $state(false);
  let isOpen = $state(false);
  let selectedIndex = $state(-1);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let containerRef: HTMLDivElement | undefined = $state();

  async function search(query: string) {
    if (query.length < 2) {
      results = [];
      isOpen = false;
      return;
    }

    isSearching = true;
    try {
      const searchResults = await searchBlueskyActors(query, 6);
      results = searchResults;
      isOpen = searchResults.length > 0;
      selectedIndex = -1;
    } catch (err) {
      console.error('Search error:', err);
      results = [];
    } finally {
      isSearching = false;
    }
  }

  function handleInput(event: Event) {
    const target = event.target as HTMLInputElement;
    handle = target.value;

    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      search(handle);
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
        if (selectedIndex >= 0 && selectedIndex < results.length) {
          event.preventDefault();
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
    handle = user.handle;
    closeDropdown();
  }

  function closeDropdown() {
    isOpen = false;
    selectedIndex = -1;
    results = [];
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

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    error = '';
    closeDropdown();

    const trimmedHandle = handle.trim();
    if (!trimmedHandle) {
      error = 'Please enter your Bluesky handle';
      return;
    }

    isLoading = true;
    try {
      const { authUrl } = await api.login(trimmedHandle);
      window.location.href = authUrl;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to start login';
      isLoading = false;
    }
  }
</script>

<div class="login-page">
  <div class="login-card card">
    <div class="logo-header">
      <img src={Logo} alt="Skyreader" class="login-logo" />
      <h1>Skyreader</h1>
    </div>

    <p class="tagline">Sign in with your Bluesky account</p>

    <form onsubmit={handleSubmit}>
      <div class="form-group" bind:this={containerRef}>
        <label for="handle">Bluesky Handle</label>
        <div class="input-wrapper">
          <input
            type="text"
            id="handle"
            value={handle}
            oninput={handleInput}
            onkeydown={handleKeydown}
            onfocus={handleFocus}
            placeholder="you.bsky.social"
            disabled={isLoading}
            autocomplete="off"
            autocapitalize="none"
            spellcheck="false"
          />
          {#if isSearching}
            <div class="search-spinner"></div>
          {/if}
        </div>

        {#if isOpen && results.length > 0}
          <div class="dropdown">
            {#each results as user, index (user.did)}
              <button
                type="button"
                class="result-item"
                class:selected={index === selectedIndex}
                onclick={() => selectUser(user)}
                onmouseenter={() => (selectedIndex = index)}
              >
                {#if user.avatar}
                  <img src={user.avatar} alt="" class="avatar" />
                {:else}
                  <div class="avatar placeholder"></div>
                {/if}
                <div class="user-info">
                  <span class="name">{user.displayName || user.handle}</span>
                  {#if user.displayName}
                    <span class="handle">@{user.handle}</span>
                  {/if}
                </div>
              </button>
            {/each}
          </div>
        {/if}
      </div>

      {#if error}
        <div class="error">{error}</div>
      {/if}

      <button type="submit" class="btn btn-primary" disabled={isLoading}>
        {isLoading ? 'Connecting...' : 'Continue'}
      </button>
    </form>

    <a href="/" class="back-link">Back to Home</a>
  </div>
</div>

<style>
  .login-page {
    max-width: 400px;
    margin: 4rem auto;
  }

  .login-card {
    padding: 2rem;
    text-align: center;
  }

  .logo-header {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  .login-logo {
    width: 72px;
    height: 72px;
  }

  .login-card h1 {
    font-size: var(--text-3xl);
    margin: 0;
  }

  .tagline {
    color: var(--color-text-secondary);
    margin-bottom: 1.5rem;
  }

  .form-group {
    text-align: left;
    margin-bottom: 1rem;
    position: relative;
  }

  .form-group label {
    display: block;
    margin-bottom: 0.5rem;
    font-weight: var(--weight-medium);
  }

  .input-wrapper {
    position: relative;
  }

  .form-group input {
    width: 100%;
    padding: 0.75rem;
    padding-right: 2.5rem;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--text-base);
    box-sizing: border-box;
    background: var(--color-bg);
    color: var(--color-text);
  }

  .form-group input:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 3px var(--color-sidebar-active);
  }

  .search-spinner {
    position: absolute;
    right: 0.75rem;
    top: 50%;
    transform: translateY(-50%);
    width: 1rem;
    height: 1rem;
    border: 2px solid var(--color-border);
    border-top-color: var(--color-primary);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to {
      transform: translateY(-50%) rotate(360deg);
    }
  }

  .dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    margin-top: 4px;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    max-height: 280px;
    overflow-y: auto;
    z-index: 100;
  }

  .result-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.625rem 0.75rem;
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

  .avatar {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    flex-shrink: 0;
    object-fit: cover;
  }

  .avatar.placeholder {
    background: var(--color-border);
  }

  .user-info {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .name {
    font-weight: var(--weight-medium);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .handle {
    font-size: var(--text-md);
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .error {
    background: var(--color-error);
    color: white;
    padding: 0.75rem;
    border-radius: 4px;
    margin-bottom: 1rem;
    font-size: var(--text-md);
  }

  .btn-primary {
    width: 100%;
    padding: 0.75rem 1.5rem;
    background: var(--color-primary);
    color: white;
    border: none;
    border-radius: 4px;
    font-size: var(--text-base);
    cursor: pointer;
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--color-primary-dark);
  }

  .btn-primary:disabled {
    opacity: 0.65;
    cursor: not-allowed;
  }

  .back-link {
    display: inline-block;
    margin-top: 1.5rem;
    color: var(--color-text-secondary);
    text-decoration: none;
    font-size: var(--text-md);
  }

  .back-link:hover {
    text-decoration: underline;
  }
</style>
