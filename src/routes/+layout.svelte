<script lang="ts">
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { preferences } from '$lib/stores/preferences.svelte';
  import { keyboardStore } from '$lib/stores/keyboard.svelte';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import KeyboardShortcutsModal from '$lib/components/KeyboardShortcutsModal.svelte';
  import Logo from '$lib/assets/logo.svg';
  import '../app.css';

  let { children } = $props();

  // Helper functions for feed/user cycling
  function getCurrentFeedId(): number | null {
    const feedParam = $page.url.searchParams.get('feed');
    return feedParam ? parseInt(feedParam) : null;
  }

  function getCurrentSharerId(): string | null {
    return $page.url.searchParams.get('sharer');
  }

  function cycleFeeds(direction: 1 | -1) {
    // Use sorted feed IDs from sidebar store (matches visual order)
    const feedIds = sidebarStore.sortedFeedIds;
    if (feedIds.length === 0) return;

    const currentFeedId = getCurrentFeedId();
    if (currentFeedId === null) {
      // Not on a feed view, go to first/last feed
      const targetId = direction === 1 ? feedIds[0] : feedIds[feedIds.length - 1];
      goto(`/?feed=${targetId}`);
      return;
    }

    const currentIndex = feedIds.indexOf(currentFeedId);
    if (currentIndex === -1) {
      // Current feed not found in sorted list, go to first
      goto(`/?feed=${feedIds[0]}`);
      return;
    }

    const newIndex = (currentIndex + direction + feedIds.length) % feedIds.length;
    goto(`/?feed=${feedIds[newIndex]}`);
  }

  function cycleUsers(direction: 1 | -1) {
    // Use sorted user DIDs from sidebar store (matches visual order)
    const userDids = sidebarStore.sortedUserDids;
    if (userDids.length === 0) return;

    const currentSharerId = getCurrentSharerId();
    if (currentSharerId === null) {
      // Not on a sharer view, go to first/last user
      const targetDid = direction === 1 ? userDids[0] : userDids[userDids.length - 1];
      goto(`/?sharer=${targetDid}`);
      return;
    }

    const currentIndex = userDids.indexOf(currentSharerId);
    if (currentIndex === -1) {
      // Current user not found in sorted list, go to first
      goto(`/?sharer=${userDids[0]}`);
      return;
    }

    const newIndex = (currentIndex + direction + userDids.length) % userDids.length;
    goto(`/?sharer=${userDids[newIndex]}`);
  }

  // Determine whether to cycle feeds or users based on current view
  function cycleSidebar(direction: 1 | -1) {
    const feedParam = $page.url.searchParams.get('feed');
    const sharerParam = $page.url.searchParams.get('sharer');
    const followingParam = $page.url.searchParams.get('following');

    // If on a specific sharer or following view, cycle users
    if (sharerParam || followingParam) {
      cycleUsers(direction);
    } else {
      // Otherwise cycle feeds
      cycleFeeds(direction);
    }
  }

  // Register global keyboard shortcuts on mount
  onMount(() => {
    // View switching shortcuts
    keyboardStore.register({
      key: '1',
      description: 'All',
      category: 'Views',
      action: () => goto('/'),
      condition: () => auth.isAuthenticated,
    });

    keyboardStore.register({
      key: '2',
      description: 'Starred',
      category: 'Views',
      action: () => goto('/?starred=true'),
      condition: () => auth.isAuthenticated,
    });

    keyboardStore.register({
      key: '3',
      description: 'Shared',
      category: 'Views',
      action: () => goto('/?shared=true'),
      condition: () => auth.isAuthenticated,
    });

    keyboardStore.register({
      key: '4',
      description: 'Feeds',
      category: 'Views',
      action: () => goto('/?feeds=true'),
      condition: () => auth.isAuthenticated,
    });

    keyboardStore.register({
      key: '5',
      description: 'Following',
      category: 'Views',
      action: () => goto('/?following=true'),
      condition: () => auth.isAuthenticated,
    });

    keyboardStore.register({
      key: '6',
      description: 'Discover',
      category: 'Views',
      action: () => goto('/discover'),
      condition: () => auth.isAuthenticated,
    });

    keyboardStore.register({
      key: '0',
      description: 'Settings',
      category: 'Views',
      action: () => goto('/settings'),
      condition: () => auth.isAuthenticated,
    });

    // Feed/user cycling shortcuts
    keyboardStore.register({
      key: '[',
      description: 'Previous feed/user',
      category: 'Feed/User',
      action: () => cycleSidebar(-1),
      condition: () => auth.isAuthenticated,
    });

    keyboardStore.register({
      key: ']',
      description: 'Next feed/user',
      category: 'Feed/User',
      action: () => cycleSidebar(1),
      condition: () => auth.isAuthenticated,
    });

    // Add feed shortcut
    keyboardStore.register({
      key: 'a',
      description: 'Add feed',
      category: 'Other',
      action: () => sidebarStore.openAddFeedModal(),
      condition: () => auth.isAuthenticated,
    });

    // Font size shortcuts (use resulting character from Shift+key)
    keyboardStore.register({
      key: '+',
      shift: true,
      description: 'Increase font size',
      category: 'Article',
      action: () => preferences.increaseFontSize(),
      condition: () => auth.isAuthenticated,
    });

    keyboardStore.register({
      key: '_',
      shift: true,
      description: 'Decrease font size',
      category: 'Article',
      action: () => preferences.decreaseFontSize(),
      condition: () => auth.isAuthenticated,
    });

    keyboardStore.register({
      key: ')',
      shift: true,
      description: 'Reset font size',
      category: 'Article',
      action: () => preferences.resetFontSize(),
      condition: () => auth.isAuthenticated,
    });
  });

  // Apply article font preference to document
  $effect(() => {
    if (browser) {
      document.documentElement.setAttribute('data-article-font', preferences.articleFont);
    }
  });

  // Apply article font size preference to document
  $effect(() => {
    if (browser) {
      document.documentElement.setAttribute('data-article-font-size', preferences.articleFontSize);
    }
  });
</script>

<svelte:window onkeydown={keyboardStore.handleKeydown} />

<svelte:head>
  <title>Skyreader</title>
  <meta name="description" content="A decentralized RSS reader built on AT Protocol" />
  <link rel="icon" type="image/svg+xml" href={Logo} />
  <link rel="manifest" href="/manifest.json" />
  <meta name="theme-color" content="#4A9FD4" />
</svelte:head>

<KeyboardShortcutsModal />

<div class="app">
  {#if !auth.isLoading}
    {#if auth.isAuthenticated}
      <Sidebar />
      <button class="mobile-menu-btn" onclick={() => sidebarStore.toggleMobile()} aria-label="Open menu">
        &#x2630;
      </button>
      <div class="main-wrapper" class:sidebar-collapsed={sidebarStore.isCollapsed}>
        <main>
          {@render children()}
        </main>
      </div>
    {:else}
      <header class="header-full">
        <div class="header-content">
          <a href="/" class="logo">
            <img src={Logo} alt="" class="logo-icon" />
            <span>Skyreader</span>
          </a>
          <a href="https://github.com/disnet/skyreader/issues" class="feedback-link" target="_blank" rel="noopener noreferrer">Feedback ↗</a>
          <a href="/auth/login" class="login-btn">Login</a>
        </div>
      </header>

      <main class="main-full">
        {@render children()}
      </main>
    {/if}
  {:else}
    <div class="loading">Loading...</div>
  {/if}
</div>

<style>
  .app {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  /* Main wrapper with sidebar margin */
  .main-wrapper {
    margin-left: var(--sidebar-width, 260px);
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    transition: margin-left 0.2s ease;
  }

  .main-wrapper.sidebar-collapsed {
    margin-left: var(--sidebar-collapsed-width, 60px);
  }

  .header-full {
    background: var(--color-bg-secondary, #f5f5f5);
    border-bottom: 1px solid var(--color-border, #e0e0e0);
    padding: 0.75rem 1rem;
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .header-content {
    max-width: 1200px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .mobile-menu-btn {
    display: none;
    position: fixed;
    top: 1rem;
    left: 1rem;
    z-index: 45;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font-size: 1.25rem;
    cursor: pointer;
    padding: 0.5rem 0.75rem;
    color: var(--color-text);
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  }

  .logo {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: 700;
    font-size: 1.25rem;
    color: var(--color-primary, #0066cc);
    text-decoration: none;
  }

  .logo-icon {
    width: 28px;
    height: 28px;
  }

  .feedback-link {
    color: var(--color-text-secondary, #666);
    text-decoration: none;
    font-size: 0.875rem;
    margin-left: auto;
  }

  .feedback-link:hover {
    color: var(--color-primary, #0066cc);
    text-decoration: underline;
  }

  .login-btn {
    background: var(--color-primary, #0066cc);
    color: white;
    padding: 0.5rem 1rem;
    border-radius: 6px;
    text-decoration: none;
  }

  .login-btn:hover {
    background: var(--color-primary-dark, #0052a3);
  }

  main {
    flex: 1;
    max-width: 900px;
    width: 100%;
    margin: 0 auto;
    padding: 1rem;
  }

  .main-full {
    flex: 1;
    max-width: 1200px;
    width: 100%;
    margin: 0 auto;
    padding: 1rem;
  }

  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    font-size: 1.25rem;
    color: var(--color-text-secondary, #666);
  }

  @media (max-width: 768px) {
    .main-wrapper {
      margin-left: 0;
    }

    .main-wrapper.sidebar-collapsed {
      margin-left: 0;
    }

    /* Hide floating hamburger - mobile header in page handles this now */
    .mobile-menu-btn {
      display: none;
    }
  }
</style>
