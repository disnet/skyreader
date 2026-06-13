<script lang="ts">
  import { page } from '$app/stores';
  import { api } from '$lib/services/api';
  import { searchBlueskyActors, type BlueskySearchResult } from '$lib/services/blueskySearch';
  import Icon from '$lib/components/Icon.svelte';
  import Logo from '$lib/assets/logo.svg';

  let handle = $state('');
  let isLoading = $state(false);
  let error = $state('');

  // Explainer + sign-up UI state
  let explainerOpen = $state(false);
  let signupOpen = $state(false);
  let signupRef: HTMLDivElement | undefined = $state();

  // Account providers in the Atmosphere. Each is a PDS/entryway host: signing up
  // runs OAuth against it, so the user creates an account there and is redirected
  // back here logged in. Bluesky is the default.
  const providers = [
    { name: 'Bluesky', pds: 'https://bsky.social', note: 'Most popular, easiest start' },
    { name: 'Eurosky', pds: 'https://eurosky.social', note: 'Hosted in the EU' },
    { name: 'Blacksky', pds: 'https://blacksky.app', note: 'Community-run' },
  ];

  async function startSignup(pds: string) {
    error = '';
    signupOpen = false;
    isLoading = true;
    try {
      const returnUrl = $page.url.searchParams.get('returnUrl') || undefined;
      const { authUrl } = await api.signup(pds, returnUrl);
      window.location.href = authUrl;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to start sign up';
      isLoading = false;
    }
  }

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

  function handleSignupClickOutside(event: MouseEvent) {
    if (signupRef && !signupRef.contains(event.target as Node)) {
      signupOpen = false;
    }
  }

  $effect(() => {
    if (signupOpen) {
      document.addEventListener('click', handleSignupClickOutside);
      return () => {
        document.removeEventListener('click', handleSignupClickOutside);
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
      // Carry ?returnUrl through OAuth so deep links (e.g. /follow) resume after
      // login. The backend validates it against open-redirects.
      const returnUrl = $page.url.searchParams.get('returnUrl') || undefined;
      const { authUrl } = await api.login(trimmedHandle, returnUrl);
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

    <p class="tagline">Log in with your Atmosphere account</p>

    <button
      type="button"
      class="explainer-toggle"
      aria-expanded={explainerOpen}
      onclick={() => (explainerOpen = !explainerOpen)}
    >
      What's an Atmosphere account?
      <Icon name={explainerOpen ? 'chevron-up' : 'chevron-down'} size={14} />
    </button>

    {#if explainerOpen}
      <p class="explainer">
        It's your login for the open network Skyreader runs on. Your account lives with a provider
        you choose, not locked inside one app, so your reading life travels with you. Bluesky is the
        most popular provider, but any will work.
      </p>
    {/if}

    <form onsubmit={handleSubmit}>
      <div class="form-group" bind:this={containerRef}>
        <label for="handle">Your handle</label>
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
        {isLoading ? 'Connecting...' : 'Log in'}
      </button>
    </form>

    <div class="signup">
      <p class="signup-prompt">New to the Atmosphere?</p>
      <div class="signup-split" bind:this={signupRef}>
        <button
          type="button"
          class="signup-main"
          disabled={isLoading}
          onclick={() => startSignup(providers[0].pds)}
        >
          Sign up with {providers[0].name}
        </button>
        <button
          type="button"
          class="signup-caret"
          aria-label="Other providers"
          aria-expanded={signupOpen}
          disabled={isLoading}
          onclick={() => (signupOpen = !signupOpen)}
        >
          <Icon name="chevron-down" size={16} />
        </button>

        {#if signupOpen}
          <div class="signup-dropdown">
            {#each providers as provider (provider.pds)}
              <button type="button" class="provider-item" onclick={() => startSignup(provider.pds)}>
                <div class="provider-info">
                  <span class="provider-name">{provider.name}</span>
                  <span class="provider-note">{provider.note}</span>
                </div>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </div>

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
    margin-bottom: 0.5rem;
  }

  .explainer-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    margin: 0 auto 1.25rem;
    padding: 0.25rem 0.5rem;
    background: none;
    border: none;
    color: var(--color-primary);
    font: inherit;
    font-size: var(--text-md);
    cursor: pointer;
  }

  .explainer-toggle:hover {
    text-decoration: underline;
  }

  .explainer {
    text-align: left;
    margin: 0 0 1.5rem;
    padding: 0.875rem 1rem;
    background: var(--color-bg-secondary);
    border-radius: 8px;
    color: var(--color-text-secondary);
    font-size: var(--text-md);
    line-height: 1.5;
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

  .signup {
    margin-top: 1.5rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--color-border);
  }

  .signup-prompt {
    margin: 0 0 0.75rem;
    color: var(--color-text-secondary);
    font-size: var(--text-md);
  }

  .signup-split {
    position: relative;
    display: flex;
    gap: 1px;
  }

  .signup-main {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    padding: 0.75rem 1rem;
    background: var(--color-bg);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px 0 0 4px;
    font: inherit;
    font-size: var(--text-base);
    font-weight: var(--weight-medium);
    cursor: pointer;
  }

  .signup-caret {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 0.625rem;
    background: var(--color-bg);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-left: none;
    border-radius: 0 4px 4px 0;
    cursor: pointer;
  }

  .signup-main:hover:not(:disabled),
  .signup-caret:hover:not(:disabled) {
    background: var(--color-bg-secondary);
  }

  .signup-main:disabled,
  .signup-caret:disabled {
    opacity: 0.65;
    cursor: not-allowed;
  }

  .signup-dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    margin-top: 4px;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    overflow: hidden;
    z-index: 100;
  }

  .provider-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    width: 100%;
    padding: 0.625rem 0.875rem;
    background: none;
    border: none;
    color: var(--color-text);
    font: inherit;
    cursor: pointer;
    transition: background-color 0.1s;
  }

  .provider-item:hover {
    background: var(--color-bg-secondary);
  }

  .provider-info {
    display: flex;
    flex-direction: column;
    text-align: left;
    min-width: 0;
  }

  .provider-name {
    font-weight: var(--weight-medium);
  }

  .provider-note {
    font-size: var(--text-md);
    color: var(--color-text-secondary);
  }

  .signup-hint {
    margin: 0.75rem 0 0;
    color: var(--color-text-secondary);
    font-size: var(--text-md);
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
