<script lang="ts">
  // The authenticated app shell. Everything heavy (the IndexedDB data layer via
  // appManager, the Sidebar, the feed stores, @mention polling) lives here so it
  // can be code-split: the root layout imports this component dynamically, only
  // once the user is authenticated. A logged-out visitor never downloads any of it.
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import type { Snippet } from 'svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { appManager } from '$lib/stores/app.svelte';
  import { viewTitleStore } from '$lib/stores/viewTitle.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { preferences } from '$lib/stores/preferences.svelte';
  import { keyboardStore } from '$lib/stores/keyboard.svelte';
  import { savedSearchStore } from '$lib/stores/savedSearch.svelte';
  import { notificationsStore } from '$lib/stores/notifications.svelte';
  import { feedPath, FEEDS_PATH, SAVED_PATH } from '$lib/utils/viewNav';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import KeyboardShortcutsModal from '$lib/components/KeyboardShortcutsModal.svelte';
  import RefreshProgressBar from '$lib/components/RefreshProgressBar.svelte';
  import ShareComposer from '$lib/components/feed/ShareComposer.svelte';
  import IntegrationSaveDialog from '$lib/components/feed/IntegrationSaveDialog.svelte';

  let { children }: { children: Snippet } = $props();

  let pageTitle = $derived.by(() => {
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
      goto(feedPath(targetId));
      return;
    }

    const currentIndex = feedIds.indexOf(currentFeedId);
    if (currentIndex === -1) {
      // Current feed not found in sorted list, go to first
      goto(feedPath(feedIds[0]));
      return;
    }

    const newIndex = (currentIndex + direction + feedIds.length) % feedIds.length;
    goto(feedPath(feedIds[newIndex]));
  }

  // Initialize app data (cache-first hydrate + background refresh).
  // The appManager has an internal phase guard so re-entry is a no-op.
  // Skip on /dev/* — those routes are isolated visual harnesses that run on
  // mock data and must not hit the API (so they're noise-free even when a dev
  // session is present).
  $effect(() => {
    if (browser && !$page.url.pathname.startsWith('/dev')) {
      appManager.initialize();
    }
  });

  // Register global keyboard shortcuts on mount. keyboardStore.register() keys by
  // shortcut, so re-registering on remount (e.g. logout → login) just overwrites.
  // The auth conditions are redundant here (this component only mounts when
  // authenticated) but kept to preserve the original gating semantics.
  onMount(() => {
    // View switching shortcuts
    keyboardStore.register({
      key: '0',
      description: 'Home',
      category: 'Views',
      action: () => goto('/home'),
      condition: () => auth.isAuthenticated,
    });

    keyboardStore.register({
      key: '1',
      description: 'Feeds',
      category: 'Views',
      action: () => goto(FEEDS_PATH),
      condition: () => auth.isAuthenticated,
    });

    keyboardStore.register({
      key: '2',
      description: 'Saved',
      category: 'Views',
      action: () => goto(SAVED_PATH),
      condition: () => auth.isAuthenticated,
    });

    keyboardStore.register({
      key: '3',
      description: 'Linkblog',
      category: 'Views',
      action: () => goto('/linkblog'),
      condition: () => auth.isAuthenticated && !preferences.linkblogDisabled,
    });

    keyboardStore.register({
      key: '4',
      description: 'Highlights',
      category: 'Views',
      action: () => goto('/highlights'),
      condition: () => auth.isAuthenticated,
    });

    keyboardStore.register({
      key: '5',
      description: 'Discover',
      category: 'Views',
      action: () => goto('/discover'),
      condition: () => auth.isAuthenticated,
    });

    keyboardStore.register({
      key: '6',
      description: 'Manage Sources',
      category: 'Views',
      action: () => goto('/sources'),
      condition: () => auth.isAuthenticated,
    });

    keyboardStore.register({
      key: '7',
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

    // Add menu shortcut (Add feed / @handle / Save URL / …)
    keyboardStore.register({
      key: 'a',
      description: 'Toggle add menu',
      category: 'Other',
      action: () => sidebarStore.toggleAddMenu(),
      condition: () => auth.isAuthenticated,
    });

    // Navigation switcher shortcut. In a saved view "/" means what it means
    // everywhere else — search this list — and falls back to the switcher
    // otherwise. Registered once here rather than re-registered per page,
    // because the store keys shortcuts by key: a second '/' registration would
    // clobber this one and take the switcher with it when it unregistered.
    // Gated on `available` (the saved page is mounted *now*) rather than on the
    // view filters, which keep their last value after that page unmounts and
    // would leave the switcher dead on every route after one Saved visit.
    keyboardStore.register({
      key: '/',
      description: 'Search saved / open switcher',
      category: 'Navigation',
      action: () => {
        if (savedSearchStore.available) savedSearchStore.openSearch();
        else sidebarStore.toggleNavigationDropdown();
      },
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

  // Own the @mention badge-polling lifecycle, tied to this shell's lifetime. Both
  // the desktop sidebar bell and the mobile bottom-bar bell are pure consumers; if
  // either component owned start/stop, unmounting it (e.g. the mobile bar when the
  // reader opens) would tear down polling for the other. start() is idempotent;
  // stop() also clears per-account state, so it doubles as logout cleanup.
  $effect(() => {
    if (!browser) return;
    notificationsStore.start();
    return () => notificationsStore.stop();
  });

  // Apply article font preference to document
  $effect(() => {
    if (browser) {
      document.documentElement.setAttribute('data-article-font', preferences.articleFont);
    }
  });

  // Apply article font size preference to document. It's now an arbitrary px
  // value (not a fixed xs…xl scale), so drive the CSS var directly.
  $effect(() => {
    if (browser) {
      document.documentElement.style.setProperty(
        '--article-font-size',
        `${preferences.articleFontSize}px`
      );
    }
  });
</script>

<svelte:window onkeydown={keyboardStore.handleKeydown} />

<svelte:head>
  <title>{pageTitle}</title>
</svelte:head>

<KeyboardShortcutsModal />
<RefreshProgressBar />
<ShareComposer />
<IntegrationSaveDialog />

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
        <button class="dismiss-btn" onclick={() => auth.dismissScopeUpgrade()}>Dismiss</button>
      </div>
    {/if}
    <main>
      {@render children()}
    </main>
  </div>
</div>

<style>
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

  .mobile-menu-btn {
    display: none;
    position: fixed;
    top: 1rem;
    left: 1rem;
    z-index: 45;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font-size: var(--text-2xl);
    cursor: pointer;
    padding: 0.5rem 0.75rem;
    color: var(--color-text);
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  }

  main {
    flex: 1;
    width: 100%;
    padding: 0.5rem;
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
    font-size: var(--text-md);
    text-align: center;
    position: sticky;
    top: 0;
    z-index: 11;
  }

  .scope-upgrade-banner .reauth-link {
    color: inherit;
    font-weight: var(--weight-semibold);
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
    font-size: var(--text-xs);
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
  }
</style>
