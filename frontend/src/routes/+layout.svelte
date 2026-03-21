<script lang="ts">
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { viewTitleStore } from '$lib/stores/viewTitle.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { preferences } from '$lib/stores/preferences.svelte';
  import { keyboardStore } from '$lib/stores/keyboard.svelte';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import KeyboardShortcutsModal from '$lib/components/KeyboardShortcutsModal.svelte';
  import Toast from '$lib/components/Toast.svelte';
  import RefreshProgressBar from '$lib/components/RefreshProgressBar.svelte';
  import Logo from '$lib/assets/logo.svg';
  import '../app.css';

  let { children } = $props();
  let updateAvailable = $state(false);
  let updating = $state(false);
  let waitingWorker: ServiceWorker | null = null;

  let pageTitle = $derived.by(() => {
    if (!auth.isAuthenticated) return 'Skyreader';
    const count = viewTitleStore.unreadCount;
    const view = viewTitleStore.current;
    const suffix = view ? `${view} - Skyreader` : 'Skyreader';
    return count > 0 ? `(${count}) ${suffix}` : suffix;
  });

  // Helper function for feed cycling
  function cycleFeeds(direction: 1 | -1) {
    // Use sorted feed IDs from sidebar store (matches visual order)
    const feedIds = sidebarStore.sortedFeedIds;
    if (feedIds.length === 0) return;

    const feedParam = $page.url.searchParams.get('feed');
    const currentFeedId = feedParam ? parseInt(feedParam) : null;
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

  function applyUpdate() {
    updating = true;
    waitingWorker?.postMessage({ type: 'SKIP_WAITING' });
  }

  // Detect new service worker versions
  onMount(() => {
    if (!browser || !('serviceWorker' in navigator)) return;

    // In dev mode, clean up any stale SW registrations and bail out.
    // Vite serves a new SW on every load, which causes an infinite
    // controllerchange → reload loop if a registration persists.
    if (import.meta.env.DEV) {
      navigator.serviceWorker.getRegistrations().then((registrations) => {
        registrations.forEach((reg) => reg.unregister());
      });
      return;
    }

    // Reload when the new SW takes control (after SKIP_WAITING → skipWaiting → activate → clients.claim)
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      window.location.reload();
    });

    navigator.serviceWorker.ready.then((registration) => {
      if (registration.waiting) {
        waitingWorker = registration.waiting;
        updateAvailable = true;
      }

      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            waitingWorker = newWorker;
            updateAvailable = true;
          }
        });
      });

      // Check for updates when the tab regains focus
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          registration.update();
        }
      });
    });
  });

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
      description: 'Saved',
      category: 'Views',
      action: () => goto('/?saved=true'),
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
      description: 'Toggle Feeds section',
      category: 'Views',
      action: () => sidebarStore.toggleSection('feeds'),
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
      description: 'Previous feed',
      category: 'Feed',
      action: () => cycleFeeds(-1),
      condition: () => auth.isAuthenticated,
    });

    keyboardStore.register({
      key: ']',
      description: 'Next feed',
      category: 'Feed',
      action: () => cycleFeeds(1),
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

    // Navigation switcher shortcut
    keyboardStore.register({
      key: '/',
      description: 'Open switcher',
      category: 'Navigation',
      action: () => sidebarStore.toggleNavigationDropdown(),
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
  <title>{pageTitle}</title>
  <meta name="description" content="A decentralized RSS reader built on AT Protocol" />
  <link rel="icon" type="image/svg+xml" href={Logo} />
  <link rel="manifest" href="/manifest.json" />
  <meta name="theme-color" content="#4A9FD4" />
</svelte:head>

<KeyboardShortcutsModal />
<Toast />
<RefreshProgressBar />

{#if updateAvailable}
  <div class="update-banner">
    {#if updating}
      <span>Updating...</span>
    {:else}
      <span>A new version of Skyreader is available.</span>
      <button class="update-btn" onclick={applyUpdate}> Update </button>
    {/if}
  </div>
{/if}

<div class="app">
  {#if !auth.isLoading}
    {#if auth.isAuthenticated}
      <div class="app-container">
        <Sidebar />
        <button
          class="mobile-menu-btn"
          onclick={() => sidebarStore.toggleMobile()}
          aria-label="Open menu"
        >
          &#x2630;
        </button>
        <div class="main-wrapper">
          {#if auth.scopeUpgradeRequired}
            <div class="scope-upgrade-banner">
              <span
                >Your session was created with outdated permissions. Please
                <button
                  class="reauth-link"
                  onclick={async () => {
                    await auth.logout();
                    goto('/auth/login');
                  }}>log in again</button
                > to restore full functionality.</span
              >
              <button class="dismiss-btn" onclick={() => auth.dismissScopeUpgrade()}>Dismiss</button
              >
            </div>
          {/if}
          <main>
            {@render children()}
          </main>
        </div>
      </div>
    {:else}
      <header class="header-full">
        <div class="header-content">
          <a href="/" class="logo">
            <img src={Logo} alt="" class="logo-icon" />
            <span>Skyreader</span>
          </a>
          <a
            href="https://github.com/disnet/skyreader/issues"
            class="feedback-link"
            target="_blank"
            rel="noopener noreferrer">Feedback ↗</a
          >
          <a href="/auth/login" class="login-btn">Login</a>
        </div>
      </header>

      <main class="main-full">
        {@render children()}
      </main>
      <footer class="app-footer">
        <a href="/terms">Terms</a>
        <span class="separator">·</span>
        <a href="mailto:abuse@skyreader.app">Report Abuse</a>
        <span class="separator">·</span>
        <a
          href="https://github.com/disnet/skyreader/issues"
          target="_blank"
          rel="noopener noreferrer">Feedback</a
        >
      </footer>
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

  /* Centered container for sidebar + main content */
  .app-container {
    display: flex;
    max-width: 1200px;
    width: 100%;
    margin: 0 auto;
    min-height: 100vh;
  }

  /* Main wrapper next to sidebar — z-index ensures fixed overlays
     (e.g. fullscreen reader at z-index:100) stack above the sticky sidebar (z-index:50) */
  .main-wrapper {
    flex: 1;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    min-width: 0;
    position: relative;
    z-index: 51;
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
    width: 100%;
    padding: 0.5rem;
  }

  .main-full {
    flex: 1;
    max-width: 1200px;
    width: 100%;
    margin: 0 auto;
    padding: 0.5rem;
  }

  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    font-size: 1.25rem;
    color: var(--color-text-secondary, #666);
  }

  .app-footer {
    padding: 1.5rem 1rem;
    text-align: center;
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
    border-top: 1px solid var(--color-border);
    max-width: 1200px;
    margin: auto auto 0;
    width: 100%;
  }

  .app-footer a {
    color: var(--color-text-secondary);
    text-decoration: none;
  }

  .app-footer a:hover {
    color: var(--color-primary);
    text-decoration: underline;
  }

  .app-footer .separator {
    margin: 0 0.5rem;
  }

  .update-banner {
    position: fixed;
    bottom: 1rem;
    left: 50%;
    transform: translateX(-50%);
    background: var(--color-primary, #0066cc);
    color: white;
    padding: 0.625rem 1rem;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    font-size: 0.875rem;
    text-align: center;
    border-radius: 999px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
    z-index: 200;
    white-space: nowrap;
  }

  .update-btn {
    background: white;
    color: var(--color-primary, #0066cc);
    border: none;
    border-radius: 999px;
    padding: 0.25rem 0.75rem;
    cursor: pointer;
    font-size: 0.8125rem;
    font-weight: 600;
    white-space: nowrap;
  }

  .update-btn:hover {
    background: rgba(255, 255, 255, 0.9);
  }

  .scope-upgrade-banner {
    background: var(--color-warning-bg, #fff3cd);
    color: var(--color-warning-text, #856404);
    border-bottom: 1px solid var(--color-warning-border, #ffc107);
    padding: 0.625rem 1rem;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    font-size: 0.875rem;
    text-align: center;
    position: sticky;
    top: 0;
    z-index: 11;
  }

  .scope-upgrade-banner .reauth-link {
    color: inherit;
    font-weight: 600;
    text-decoration: underline;
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-size: inherit;
    cursor: pointer;
  }

  .scope-upgrade-banner .dismiss-btn {
    background: none;
    border: 1px solid var(--color-warning-text, #856404);
    color: inherit;
    border-radius: 4px;
    padding: 0.25rem 0.5rem;
    cursor: pointer;
    font-size: 0.75rem;
    white-space: nowrap;
  }

  .scope-upgrade-banner .dismiss-btn:hover {
    background: rgba(0, 0, 0, 0.05);
  }

  @media (max-width: 1000px) {
    .app-container {
      flex-direction: column;
    }

    /* Hide floating hamburger - mobile header in page handles this now */
    .mobile-menu-btn {
      display: none;
    }

    .update-banner {
      bottom: auto;
      top: 0;
      left: 0;
      transform: none;
      width: 100%;
      border-radius: 0;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    }
  }
</style>
