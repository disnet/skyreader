<script lang="ts">
  // The authenticated app shell. Everything heavy (the IndexedDB data layer via
  // appManager, the Sidebar, the feed stores, @mention polling) lives here so it
  // can be code-split: the root layout imports this component dynamically, only
  // once the user is authenticated. A logged-out visitor never downloads any of it.
  import { browser } from '$app/environment';
  import { afterNavigate, beforeNavigate, goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import type { Snippet } from 'svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { appManager } from '$lib/stores/app.svelte';
  import { viewTitleStore } from '$lib/stores/viewTitle.svelte';
  import { sidebarStore, RAIL_MIN_WIDTH, RAIL_MAX_WIDTH } from '$lib/stores/sidebar.svelte';
  import { preferences } from '$lib/stores/preferences.svelte';
  import { keyboardStore } from '$lib/stores/keyboard.svelte';
  import { highlightReviewStore } from '$lib/stores/highlightReview.svelte';
  import { savedSearchStore } from '$lib/stores/savedSearch.svelte';
  import { notificationsStore } from '$lib/stores/notifications.svelte';
  import { feedPath, FEEDS_PATH, SAVED_PATH } from '$lib/utils/viewNav';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import { APP_SCROLL_ID, appScrollElement, SHELL_FRAME_QUERY } from '$lib/utils/appScroll';
  import { SHELL_TOOLBAR_ID } from '$lib/actions/shell-toolbar';
  import KeyboardShortcutsModal from '$lib/components/KeyboardShortcutsModal.svelte';
  import RefreshProgressBar from '$lib/components/RefreshProgressBar.svelte';
  import ShareComposer from '$lib/components/feed/ShareComposer.svelte';
  import IntegrationSaveDialog from '$lib/components/feed/IntegrationSaveDialog.svelte';
  import SembleConnectionDialog from '$lib/components/feed/SembleConnectionDialog.svelte';
  import SyncLimitBanner from '$lib/components/SyncLimitBanner.svelte';

  let { children }: { children: Snippet } = $props();

  let pageTitle = $derived.by(() => {
    // An open article names the tab (and so the history entry and any link
    // preview) on its own — no unread count in front of what you're reading.
    const override = viewTitleStore.override;
    if (override) return `${override} - Skyreader`;
    const count = viewTitleStore.unreadCount;
    const view = viewTitleStore.current;
    const suffix = view ? `${view} - Skyreader` : 'Skyreader';
    return count > 0 ? `(${count}) ${suffix}` : suffix;
  });

  // Scroll restoration for the shell pane.
  //
  // Above the breakpoint `<main id="app-scroll">` is the scroller and it lives
  // in the layout, so it survives every client-side navigation with its
  // scrollTop intact. SvelteKit's own restoration only moves `window.scrollY`,
  // which is inert there — without this, leaving a feed halfway down lands you
  // halfway down the next page, and Back never returns you to your place.
  // Shallow routing (the reader overlay) doesn't reach these hooks, so the
  // reader keeps its own save/restore in useReaderStack.
  //
  // Mirrors what the router does for the window: forward navigation starts at
  // the top, Back/Forward returns to where that entry was left.
  const paneScrollTops = new Map<string, number>();

  beforeNavigate(({ from }) => {
    const pane = appScrollElement();
    if (pane && from) paneScrollTops.set(from.url.href, pane.scrollTop);
  });

  afterNavigate(({ to, type }) => {
    const pane = appScrollElement();
    if (!pane) return;
    const restored = type === 'popstate' && to ? paneScrollTops.get(to.url.href) : undefined;
    pane.scrollTop = restored ?? 0;
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

    // Gated on the corpus like every other Review entry point: a new account
    // pressing 8 would otherwise land on a page with nothing to deal.
    keyboardStore.register({
      key: '8',
      description: 'Review highlights',
      category: 'Views',
      action: () => goto('/highlights/review'),
      condition: () => auth.isAuthenticated && highlightReviewStore.hasHighlights,
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

  // ── Resizing the navigation rail ─────────────────────────────────────
  //
  // The rail's width is a user setting (persisted in the sidebar store), applied
  // as --sidebar-width on the document. That's the same token the frame's grid
  // sizes its first column from, so one variable moves the rail, the toolbar's
  // first segment, and everything else that insets by the rail (the share
  // composer drawer, the sources bulk bar) together.
  //
  // Written on the document rather than on .app-shell so the fixed-position
  // consumers, which are not inside it, still see it. The /dev harness sets its
  // own value on <body>, which is nearer, so it keeps winning.
  $effect(() => {
    if (!browser) return;
    document.documentElement.style.setProperty('--sidebar-width', `${sidebarStore.railWidth}px`);
    return () => document.documentElement.style.removeProperty('--sidebar-width');
  });

  function startRailResize(event: PointerEvent) {
    if (event.button !== 0) return;
    const handle = event.currentTarget as HTMLElement;
    const startX = event.clientX;
    const startWidth = sidebarStore.railWidth;

    // Capture so the drag survives the pointer crossing into the card (or off
    // the window entirely) — without it the rail would stick the moment the
    // cursor outran it.
    handle.setPointerCapture(event.pointerId);
    // Suppresses the rail's own width transition and holds the resize cursor
    // for the whole gesture, wherever the pointer is. See app.css.
    document.documentElement.classList.add('is-rail-resizing');
    event.preventDefault();

    const move = (e: PointerEvent) => sidebarStore.setRailWidth(startWidth + e.clientX - startX);
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      document.documentElement.classList.remove('is-rail-resizing');
      sidebarStore.commitRailWidth();
    };

    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  // The standard window-splitter keys, so the rail is reachable without a
  // pointer. Stopped from propagating because the same arrows turn pages in the
  // reader and step the review deck, both of which listen on the window.
  function handleRailKeydown(event: KeyboardEvent) {
    const step = event.shiftKey ? 48 : 16;
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = sidebarStore.railWidth - step;
    else if (event.key === 'ArrowRight') next = sidebarStore.railWidth + step;
    else if (event.key === 'Home') next = RAIL_MIN_WIDTH;
    else if (event.key === 'End') next = RAIL_MAX_WIDTH;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    sidebarStore.setRailWidth(next);
    sidebarStore.commitRailWidth();
  }

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

  // Flag the document for as long as this shell is mounted.
  //
  // The framed layout's outermost half has to live on html/body — only they can
  // stop the *document* scrolling, and only the document's background bleeds
  // under the browser chrome and into the overscroll gutter. But app.css is
  // shared with the logged-out marketing pages, /terms, /privacy and the /dev
  // harness, which are ordinary window-scrolling documents. This class is what
  // keeps those rules to the app. See "The framed shell is pinned" in app.css.
  $effect(() => {
    if (!browser) return;
    document.documentElement.classList.add('has-app-shell');
    return () => document.documentElement.classList.remove('has-app-shell');
  });

  // Carry the frame's ground colour into `theme-color`.
  //
  // Above the breakpoint the app sits on --color-canvas, not on the body's
  // white. Safari paints its address bar — and an installed PWA's status bar —
  // from theme-color, so app.html's white/near-black pair draws a mismatched
  // band above a grey frame, and the ground stops at the shell instead of
  // running full bleed. Below the breakpoint the app really is Surface edge to
  // edge and the authored values are the right ones, so they're restored.
  //
  // Retint the existing tags rather than appending one: a browser takes the
  // FIRST theme-color whose media matches, and app.html's light/dark pair
  // already matches, so an appended tag would never win. All of them get the
  // same value — the token has already resolved for whichever scheme the
  // browser is in, which is the same scheme it picks the tag by. Reading the
  // live token rather than restating the hex keeps this from drifting off
  // app.css.
  $effect(() => {
    if (!browser) return;
    const framed = window.matchMedia(SHELL_FRAME_QUERY);
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    const tags = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
    const authored = tags.map((tag) => tag.content);
    const restore = () => tags.forEach((tag, i) => (tag.content = authored[i]));

    const sync = () => {
      if (!framed.matches) return restore();
      const canvas = getComputedStyle(document.documentElement)
        .getPropertyValue('--color-canvas')
        .trim();
      if (canvas) tags.forEach((tag) => (tag.content = canvas));
    };

    sync();
    framed.addEventListener('change', sync);
    scheme.addEventListener('change', sync);
    return () => {
      framed.removeEventListener('change', sync);
      scheme.removeEventListener('change', sync);
      restore();
    };
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
<SembleConnectionDialog />

<div class="app-shell">
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

  <SyncLimitBanner />

  <div class="shell-frame">
    <!-- The toolbar strip: the current page's own control bar, on the ground
         above the card. Pages move their bar in here with the `shellToolbar`
         action; the slot is empty until they do. Over the rail the strip is the
         rail's own top — the account row heads it (see .shell-rail). -->
    <div class="shell-toolbar" id={SHELL_TOOLBAR_ID}></div>

    <div class="shell-rail">
      <Sidebar />
    </div>

    <!-- The rail's drag handle. It lives in the frame's column gap rather than
         on either edge, so neither the rail nor the card owns it.
         A focusable `separator` is the ARIA window-splitter pattern and *is*
         interactive; the linter's table only knows the static kind. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="shell-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={sidebarStore.railWidth}
      aria-valuemin={RAIL_MIN_WIDTH}
      aria-valuemax={RAIL_MAX_WIDTH}
      tabindex="0"
      title="Drag to resize (double-click to reset)"
      onpointerdown={startRailResize}
      onkeydown={handleRailKeydown}
      ondblclick={() => sidebarStore.resetRailWidth()}
    ></div>

    <button
      class="mobile-menu-btn"
      onclick={() => sidebarStore.toggleMobile()}
      aria-label="Open menu"
    >
      &#x2630;
    </button>

    <div class="shell-card">
      <main id={APP_SCROLL_ID} class="shell-scroll">
        {@render children()}
      </main>
    </div>
  </div>
</div>

<style>
  /* ── The shell frame ─────────────────────────────────────────────
     Above 1000px the app is a framed workspace: a recessed ground
     (--color-canvas) carrying a navigation rail and a toolbar strip,
     with the content in a white card pinned to the viewport. The card
     is the scroll container (#app-scroll), so its edges never move —
     which is the whole point of the frame, and the reason the toolbar
     lives out here on the ground instead of inside the card.

     At 1000px and below this all switches off: block flow, window
     scroll, no frame. The mobile bottom bar and pull-to-refresh both
     depend on the window scrolling, and an inner scroll container
     would also stop iOS collapsing its URL bar. See appScroll.ts. */
  .app-shell {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .shell-frame {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  /* Toolbar strip and rail handle exist only in the framed layout. */
  .shell-toolbar,
  .shell-resizer {
    display: none;
  }

  .shell-scroll {
    flex: 1;
    width: 100%;
    padding: 0.5rem;
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

  @media (min-width: 1001px) {
    .app-shell {
      height: 100vh;
      height: 100dvh;
      min-height: 0;
      background: var(--color-canvas);
      overflow: hidden;
    }

    /* One grid owns both rows: the toolbar strip and the workspace
       beneath it share the same two columns, so the page's control bar
       lands in exactly the column its content occupies.

       The ground is painted on the document (app.css) so it bleeds under the
       browser chrome and the safe areas; this padding is what keeps the toolbar
       and the card out of them. The top edge takes no --shell-gap of its own —
       the strip sits on the viewport's top edge, inset only by the status bar. */
    .shell-frame {
      display: grid;
      grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
      grid-template-rows: auto minmax(0, 1fr);
      column-gap: var(--shell-gap);
      padding: var(--safe-area-top) calc(var(--shell-gap) + var(--safe-area-right))
        calc(var(--shell-gap) + var(--safe-area-bottom))
        calc(var(--shell-gap) + var(--safe-area-left));
    }

    /* Above the sidebar (z-index 50) so the page bar's navigation dropdown
       opens over the rail; below the reading overlay (z-index 100), which
       is meant to cover the whole frame. The card deliberately takes no
       z-index — a stacking context here would trap that overlay. */
    .shell-toolbar {
      grid-area: 1 / 2;
      display: flex;
      flex-direction: column;
      justify-content: flex-start;
      min-height: var(--shell-bar-height);
      min-width: 0;
      position: relative;
      z-index: 60;
    }

    /* The rail spans the toolbar row as well as the workspace row, so its own
       first item — the account row — heads the frame where the wordmark used to,
       level with the page's control bar beside it. Both rows are at least
       --shell-bar-height and centre their contents, which is what keeps the two
       on one line even when the page's bar grows a second row. */
    .shell-rail {
      grid-area: 1 / 1 / 3 / 2;
      min-height: 0;
      min-width: 0;
    }

    /* Sized to the gap but drawn wider than it, centred on it: the gap is
       8px, which is a line to look at and not a target to hit. The overhang
       lands on the card's scrollbar gutter and the rail's padding, so it
       covers nothing clickable — but it does have to sit above the rail
       (z-index 50) to receive the press, and below the toolbar (60). */
    .shell-resizer {
      display: block;
      grid-area: 1 / 1 / 3 / 2;
      justify-self: end;
      position: relative;
      z-index: 55;
      width: 15px;
      margin-right: calc(-7px - var(--shell-gap) / 2);
      cursor: col-resize;
      touch-action: none;
    }

    /* Nothing at rest — the gap already separates rail from card. The line
       appears only once the handle is addressed, so the frame stays quiet.
       Border tone is too close to the ground to read here (#e0e0e0 on #f1f1f1),
       so it's the secondary text tone held back by opacity: visible enough to
       be an affordance, faint enough not to become a divider. */
    .shell-resizer::before {
      content: '';
      position: absolute;
      inset-block: 0;
      left: 50%;
      transform: translateX(-50%);
      width: 2px;
      border-radius: 1px;
      background: var(--color-text-secondary);
      opacity: 0;
      transition:
        opacity 0.15s ease,
        background-color 0.15s ease;
    }

    .shell-resizer:hover::before {
      opacity: 0.4;
    }

    /* Being dragged, or focused by keyboard: the handle is now the thing being
       operated, so it takes One Blue at full strength. Pointer capture holds
       :active for the whole gesture, and the drag class covers the case where
       it doesn't. */
    .shell-resizer:active::before,
    .shell-resizer:focus-visible::before,
    :global(html.is-rail-resizing) .shell-resizer::before {
      background: var(--color-primary);
      opacity: 1;
    }

    /* The line is the focus indicator — a ring around a 15px strip in an 8px
       gap would only bleed onto the rail and the card. */
    .shell-resizer:focus-visible {
      outline: none;
    }

    @media (prefers-reduced-motion: reduce) {
      .shell-resizer::before {
        transition: none;
      }
    }

    .shell-card {
      grid-area: 2 / 2;
      min-width: 0;
      min-height: 0;
      background: var(--color-bg);
      border: 1px solid var(--color-border);
      border-radius: var(--shell-radius);
      overflow: hidden;
    }

    .shell-scroll {
      height: 100%;
      overflow-y: auto;
      overscroll-behavior: contain;
      /* Symmetric gutters keep the 800px reading column centred on the same
         axis as the toolbar above it, classic scrollbars or not. */
      scrollbar-gutter: stable both-edges;
    }
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
    flex-shrink: 0;
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
</style>
