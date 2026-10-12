<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { notificationsStore } from '$lib/stores/notifications.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { searchStore } from '$lib/stores/search.svelte';
  import { canUseSearch } from '$lib/utils/search';
  import { appManager } from '$lib/stores/app.svelte';
  import { bottomRail } from '$lib/stores/bottomRail.svelte';
  import { bottomBarInset } from '$lib/stores/bottomBarInset.svelte';

  interface Props {
    controlsVisible: boolean;
    currentTitle: string;
    onScrollToTop: () => void;
    onOpenFeedSwitcher: () => void;
    onOpenFilterSheet: () => void;
    onOpenNotifications: () => void;
    hasActiveFilters: boolean;
    hideFilterButton?: boolean;
    /**
     * Saved views only: the header's search button isn't reachable down here.
     * Stands in for the full-text search button when that isn't available —
     * where it is, search covers Saved (and hands off to this offline).
     */
    onOpenSearch?: () => void;
    searchActive?: boolean;
  }

  let {
    controlsVisible,
    currentTitle,
    onScrollToTop,
    onOpenFeedSwitcher,
    onOpenFilterSheet,
    onOpenNotifications,
    hasActiveFilters,
    hideFilterButton = false,
    onOpenSearch,
    searchActive = false,
  }: Props = $props();

  // Full-text search rides the bar on every page that has one, so it's a thumb
  // away wherever you are — the phone has no `/` key.
  let fullTextSearch = $derived(canUseSearch(auth.user));

  // Refresh activity rides the bar's top rail, the way reading progress rides the
  // reader bar's — the edge facing the content says what that content is doing.
  // While the bar is up it claims that job from the app-wide RefreshProgressBar
  // (which stands down below 1000px); once it slides away it hands the job back,
  // so a scrolled-down feed still says when it's refreshing.
  // `completing` holds the rail one beat past the refresh so the sweep fades out
  // instead of vanishing mid-stride.
  let refreshing = $state(false);
  let completing = $state(false);

  $effect(() => {
    if (appManager.isRefreshing) {
      refreshing = true;
      completing = false;
    } else if (refreshing) {
      completing = true;
      const timer = setTimeout(() => {
        refreshing = false;
        completing = false;
      }, 400);
      return () => clearTimeout(timer);
    }
  });

  $effect(() => {
    if (!controlsVisible) return;
    return bottomRail.claim();
  });

  // While the bar is up it owns the bottom edge, so anything else anchored there
  // (the share composer's minibar) stacks above it instead of sharing the strip.
  // Claimed by measured height — it includes the safe-area inset the bar absorbs.
  let barHeight = $state(0);

  $effect(() => {
    if (!controlsVisible || barHeight === 0) return;
    return bottomBarInset.claim(barHeight);
  });
</script>

<div class="mobile-bottom-bar" class:hidden={!controlsVisible} bind:clientHeight={barHeight}>
  <div class="bar-rail" class:refreshing class:completing aria-hidden="true">
    <div class="bar-rail-sweep"></div>
  </div>

  <div class="bar-row">
    <button class="view-switcher" onclick={onOpenFeedSwitcher} aria-label="Switch feed">
      <Icon name="layers" size={20} />
      <span class="view-name">{currentTitle}</span>
    </button>

    <div class="bar-actions">
      <!-- Opens the Add modal (add/AddModal.svelte), which the sidebar renders
           once for the whole app — guests get its sign-in view. -->
      <button
        class="bar-btn"
        class:active={sidebarStore.addModalTab !== null}
        onclick={() => sidebarStore.openAddModal()}
        aria-haspopup="dialog"
        aria-label="Add"
        title="Add"
      >
        <Icon name="plus" size={20} />
      </button>
      {#if !auth.isGuest}
        <button
          class="bar-btn"
          onclick={onOpenNotifications}
          aria-label={notificationsStore.unreadCount > 0
            ? `Notifications, ${notificationsStore.unreadCount} unread`
            : 'Notifications'}
          title="Notifications"
        >
          <Icon name="bell" size={20} />
          {#if notificationsStore.unreadCount > 0}
            <span class="notif-count"
              >{notificationsStore.unreadCount > 99 ? '99+' : notificationsStore.unreadCount}</span
            >
          {/if}
        </button>
      {/if}
      {#if fullTextSearch}
        <button
          class="bar-btn"
          class:active={searchStore.isOpen}
          onclick={() => searchStore.open()}
          aria-label="Search"
          title="Search"
        >
          <Icon name="search" size={20} />
        </button>
      {:else if onOpenSearch}
        <button
          class="bar-btn"
          class:has-filters={searchActive}
          onclick={onOpenSearch}
          aria-label="Search saved items"
          title="Search saved"
        >
          <Icon name="search" size={20} />
          {#if searchActive}
            <span class="filter-dot"></span>
          {/if}
        </button>
      {/if}
      {#if !hideFilterButton}
        <button
          class="bar-btn"
          class:has-filters={hasActiveFilters}
          onclick={onOpenFilterSheet}
          aria-label="Filters and style"
          title="Filters & Style"
        >
          <Icon name="sliders" size={20} />
          {#if hasActiveFilters}
            <span class="filter-dot"></span>
          {/if}
        </button>
      {/if}
      <button
        class="bar-btn"
        onclick={onScrollToTop}
        aria-label="Scroll to top"
        title="Scroll to top"
      >
        <Icon name="arrow-up" size={20} />
      </button>
    </div>
  </div>
</div>

<style>
  /* Flat, opaque, edge to edge — built like the reader's bar: a rail across the
     top and a row of controls beneath it. It doesn't float over the page; it
     ends it. */
  .mobile-bottom-bar {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    display: flex;
    flex-direction: column;
    /* Opaque, matching the reader's bar. Translucency was tried and lost to
       mobile Safari's own bottom toolbar, which sits directly below this and
       can't be made translucent; `theme-color` paints that toolbar the same
       colour instead, so the two read as one band. */
    background: var(--color-bg);
    z-index: 10;
    transition: transform 0.25s ease;
  }

  /* The rail: the bar's top edge and its refresh indicator in one element. Idle
     it is a plain 2px Divider — the same edge the reader's rail draws when a
     piece has no progress to report. */
  .bar-rail {
    flex-shrink: 0;
    height: 2px;
    overflow: hidden;
    background: var(--color-border);
  }

  .bar-rail-sweep {
    height: 100%;
    background: var(--color-primary);
    transform-origin: left;
    opacity: 0;
  }

  /* Indeterminate: a refresh has no measurable end, so the sweep travels rather
     than fills — the one motion in this bar, and only while work is happening. */
  .bar-rail.refreshing .bar-rail-sweep {
    opacity: 1;
    animation: railSweep 1.2s ease-in-out infinite;
  }

  .bar-rail.completing .bar-rail-sweep {
    animation: railSettle 0.3s ease-out forwards;
  }

  @keyframes railSweep {
    0% {
      transform: translateX(-100%) scaleX(0.3);
    }
    50% {
      transform: translateX(0%) scaleX(0.5);
    }
    100% {
      transform: translateX(100%) scaleX(0.3);
    }
  }

  @keyframes railSettle {
    from {
      opacity: 1;
      transform: translateX(0) scaleX(1);
    }
    to {
      opacity: 0;
      transform: translateX(0) scaleX(1);
    }
  }

  .bar-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem clamp(0.25rem, 2vw, 1rem);
    padding-bottom: calc(0.25rem + env(safe-area-inset-bottom, 0px));
  }

  /* Slides fully clear rather than fading in place, so nothing ghosts over the
     list. Off-screen it can't be tapped, but revoke hit-testing anyway. */
  .mobile-bottom-bar.hidden {
    transform: translateY(100%);
    pointer-events: none;
  }

  /* Names the view you're in and opens the switcher — the only in-app way to
     navigate in the installed PWA, so it keeps its label while the actions stay
     iconic. Takes whatever width the actions don't need. */
  .view-switcher {
    display: flex;
    flex: 0 1 auto;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    min-height: 44px;
    padding: 0 0.625rem;
    border: 0;
    border-radius: 8px;
    background: none;
    color: var(--color-text);
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
  }

  .view-switcher :global(.icon) {
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  .view-switcher:active {
    background: var(--color-sidebar-active);
  }

  .view-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .bar-actions {
    position: relative;
    display: flex;
    flex-shrink: 0;
    align-items: center;
  }

  .bar-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    min-width: 44px;
    height: 44px;
    background: none;
    border: none;
    border-radius: 8px;
    color: var(--color-text-secondary);
    transition: color 0.15s ease;
    gap: 0.125rem;
  }

  .bar-btn.active {
    color: var(--color-primary);
  }

  .bar-btn:active {
    background: var(--color-sidebar-active);
  }

  /* Badges ride the icon's top-right corner, not the button's — the button is a
     44px touch target with air around a 20px icon, so cornering the button would
     leave the badge floating on its own. */
  .filter-dot {
    position: absolute;
    top: 0.625rem;
    right: 0.5rem;
    width: 6px;
    height: 6px;
    background: var(--color-primary, #0066cc);
    border-radius: 50%;
  }

  .notif-count {
    position: absolute;
    top: 0.35rem;
    right: 0.3rem;
    min-width: 15px;
    height: 15px;
    padding: 0 3px;
    border-radius: 999px;
    background: var(--color-primary, #0066cc);
    color: #fff;
    font-size: 9px;
    font-weight: var(--weight-semibold);
    line-height: 15px;
    text-align: center;
  }

  /* Small phones: four or five fixed 44px actions leave the view name almost no room, so
     narrow the actions (they keep full height) and buy the title back ~20px. */
  @media (max-width: 360px) {
    .bar-btn {
      min-width: 40px;
    }

    .view-switcher {
      padding: 0 0.375rem;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .mobile-bottom-bar,
    .bar-btn {
      transition: none;
      animation: none;
    }

    /* No travelling sweep: the rail simply goes One Blue for the duration of the
       refresh and back to Divider when it's done. */
    .bar-rail.refreshing .bar-rail-sweep,
    .bar-rail.completing .bar-rail-sweep {
      animation: none;
      opacity: 1;
      transform: none;
      transition: opacity 0.2s ease;
    }

    .bar-rail.completing .bar-rail-sweep {
      opacity: 0;
    }
  }

  /* Only show on mobile */
  @media (min-width: 1001px) {
    .mobile-bottom-bar {
      display: none;
    }
  }
</style>
