<script module lang="ts">
  // The bar's height above the safe-area inset: 2px rail + a 44px touch row with
  // 4px of air. Hosts whose reading surface can't scroll under it (paged mode)
  // reserve exactly this much. Keep it in step with the styles below.
  export const READER_BAR_INSET = 56;
</script>

<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';
  import { bottomRail } from '$lib/stores/bottomRail.svelte';
  import { bottomBarInset } from '$lib/stores/bottomBarInset.svelte';
  import { mobileStore } from '$lib/stores/mediaQuery.svelte';

  // The mobile reader's chrome: one flat bar anchored to the bottom edge, with
  // the reading rail as its top edge — the edge that faces the text. It is the
  // mirror of the desktop bar, whose rail is its bottom edge: the rail always
  // draws the boundary between the chrome and the words.
  //
  // It slides away on scroll-down. The host keeps a detached hairline pinned to
  // the bottom inset that crossfades in as the bar leaves, so progress survives
  // a long read with the chrome gone.
  //
  // Palette comes from inherited custom properties so a themed edition (the
  // magazine surface) can repaint the bar without reaching into these styles.
  let {
    progress = 0,
    eased = false,
    visible = true,
    onBack,
    onContents,
    onArchive,
    isArchived = false,
    onToggleSave,
    isSaved = false,
    onShare,
    shareActive = false,
    onCommunity,
    communityCount,
    communityCapped = false,
    communityActive = false,
    communityButtonEl = $bindable(null),
    onTag,
    tagCount = 0,
    tagActive = false,
    tagButtonEl = $bindable(null),
    onMore,
    moreActive = false,
  }: {
    /** 0–1. Scroll fraction while scrolling, page position while paged. */
    progress?: number;
    /** Ease the fill between values. On for paged mode, whose jumps are discrete. */
    eased?: boolean;
    visible?: boolean;
    onBack: () => void;
    onContents?: () => void;
    onArchive?: () => void;
    isArchived?: boolean;
    onToggleSave?: () => void;
    isSaved?: boolean;
    /** Open the share composer (or edit the posted share). */
    onShare?: () => void;
    /** The item is already shared to the linkblog. */
    shareActive?: boolean;
    /** Toggle passages highlighted by other readers on Margin. */
    onCommunity?: () => void;
    /** Number of fetched community highlights; undefined while loading. */
    communityCount?: number;
    communityCapped?: boolean;
    communityActive?: boolean;
    communityButtonEl?: HTMLButtonElement | null;
    onTag?: () => void;
    tagCount?: number;
    tagActive?: boolean;
    tagButtonEl?: HTMLButtonElement | null;
    onMore: () => void;
    moreActive?: boolean;
  } = $props();

  // Nothing else should double up on the refresh indicator while an article is
  // open: a refresh behind the text is not the reader's business. Claiming for
  // the reader's whole life keeps the app-wide bar down even as this one slides.
  $effect(() => bottomRail.claim());

  // The bottom edge, unlike the rail, is only claimed while the bar is actually
  // on screen — it slides away on scroll-down, and above the breakpoint the bar
  // isn't rendered at all, so a blanket claim would push the composer's minibar
  // off a bar that isn't there. Claimed by measured height, which includes the
  // safe-area inset the bar absorbs.
  let barHeight = $state(0);

  $effect(() => {
    if (!visible || !mobileStore.isMobile || barHeight === 0) return;
    return bottomBarInset.claim(barHeight);
  });
</script>

<div class="reader-bottom-bar" class:hidden={!visible} bind:clientHeight={barHeight}>
  <div class="reader-bar-rail" aria-hidden="true">
    <div class="reader-bar-rail-fill" class:eased style:transform={`scaleX(${progress})`}></div>
  </div>

  <div class="reader-bar-actions">
    <button class="bar-btn" onclick={onBack} aria-label="Back" title="Back (Escape)">
      <Icon name="arrow-left" size={20} />
    </button>

    {#if onContents}
      <button class="bar-btn" onclick={onContents} aria-label="Contents" title="Contents">
        <Icon name="list" size={20} />
      </button>
    {/if}

    {#if onArchive}
      <button
        class="bar-btn"
        onclick={onArchive}
        aria-label={isArchived ? 'Move to inbox' : 'Archive'}
        title={isArchived ? 'Move to inbox' : 'Archive (e)'}
      >
        <Icon name={isArchived ? 'inbox' : 'archive'} size={20} />
      </button>
    {/if}

    {#if onToggleSave}
      <button
        class="bar-btn"
        class:active={isSaved}
        onclick={onToggleSave}
        aria-pressed={isSaved}
        aria-label={isSaved ? 'Unsave' : 'Save'}
        title={isSaved ? 'Unsave' : 'Save (s)'}
      >
        <Icon name="bookmark" size={20} />
      </button>
    {/if}

    {#if onShare}
      <button
        class="bar-btn"
        class:active={shareActive}
        onclick={onShare}
        aria-label={shareActive ? 'Shared — edit your note' : 'Share to your linkblog'}
        title={shareActive ? 'Shared — edit your note' : 'Share to your linkblog'}
      >
        <Icon name="share" size={20} />
      </button>
    {/if}

    {#if onCommunity}
      <button
        class="bar-btn"
        class:active={communityActive}
        bind:this={communityButtonEl}
        onclick={onCommunity}
        aria-pressed={communityActive}
        aria-label={communityCount === undefined
          ? 'Community highlights'
          : `${communityCount}${communityCapped ? ' or more' : ''} community highlight${communityCount === 1 ? '' : 's'}`}
        title="Passages highlighted by readers on margin.at"
      >
        <Icon name="users" size={20} />
        {#if communityCount !== undefined}
          <span class="bar-btn-count">{communityCount}{communityCapped ? '+' : ''}</span>
        {/if}
      </button>
    {/if}

    {#if onTag}
      <button
        class="bar-btn"
        class:active={tagActive}
        bind:this={tagButtonEl}
        onclick={onTag}
        aria-expanded={tagActive}
        aria-label={tagCount > 0 ? `Tag, ${tagCount} applied` : 'Tag'}
        title="Tag (t)"
      >
        <Icon name="tag" size={20} />
        {#if tagCount > 0}<span class="bar-btn-count">{tagCount}</span>{/if}
      </button>
    {/if}

    <button
      class="bar-btn"
      class:active={moreActive}
      onclick={onMore}
      aria-expanded={moreActive}
      aria-label="Style and actions"
      title="Style & Actions"
    >
      <Icon name="sliders" size={20} />
    </button>
  </div>
</div>

<style>
  /* Flat, opaque, edge to edge — no floating pills, no blur, no shadow. The bar
     doesn't hover over the page; it ends it. Its own rail is the only edge it
     needs (Flat-By-Default). */
  .reader-bottom-bar {
    position: fixed;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: 10;
    display: flex;
    flex-direction: column;
    /* Opaque. A translucent material was tried here and lost to mobile Safari:
       its own toolbar sits directly below this bar and cannot be made
       translucent, so the two read as mismatched surfaces. The bar is solid and
       `theme-color` paints Safari's toolbar the same colour instead, which makes
       the pair read as one band. */
    background: var(--reader-chrome-bg, var(--color-bg, #fff));
    transition: transform 0.25s ease;
  }

  /* Slides fully clear of the viewport rather than fading in place, so nothing
     ghosts over the last line of text. */
  .reader-bottom-bar.hidden {
    transform: translateY(100%);
    pointer-events: none;
  }

  .reader-bar-rail {
    flex-shrink: 0;
    height: 2px;
    overflow: hidden;
    background: var(--reader-rail-track, var(--color-border, #e0e0e0));
  }

  .reader-bar-rail-fill {
    height: 100%;
    background: var(--reader-rail-fill, var(--color-primary, #0066cc));
    transform-origin: left;
    /* No transition by default: scroll drives the fill frame-by-frame. Paged
       mode jumps a whole page at a time, so it asks for the eased settle below. */
    will-change: transform;
  }

  .reader-bar-rail-fill.eased {
    transition: transform 0.34s cubic-bezier(0.22, 1, 0.36, 1);
  }

  @media (prefers-reduced-motion: reduce) {
    .reader-bar-rail-fill.eased {
      transition: none;
    }
  }

  /* Evenly spread across the width: each control owns an equal share of the bar,
     so the row reads as one deliberate strip instead of a cluster pushed to one
     side. */
  .reader-bar-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.25rem clamp(0.25rem, 2vw, 1rem);
    padding-bottom: calc(0.25rem + env(safe-area-inset-bottom, 0px));
  }

  .bar-btn {
    position: relative;
    display: flex;
    flex: 1 1 0;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    height: 44px;
    border: 0;
    border-radius: 8px;
    background: none;
    color: var(--reader-chrome-fg, var(--color-text-secondary, #666));
    cursor: pointer;
    gap: 0.25rem;
    transition: color 0.15s ease;
  }

  .bar-btn.active {
    color: var(--reader-chrome-accent, var(--color-primary, #0066cc));
  }

  .bar-btn:active {
    background: var(--color-sidebar-active, rgba(0, 102, 204, 0.1));
  }

  /* How many tags are on this piece — a number, not a colored dot, so the signal
     survives without color. */
  .bar-btn-count {
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    font-variant-numeric: tabular-nums;
    line-height: var(--leading-none);
  }

  @media (min-width: 1001px) {
    .reader-bottom-bar {
      display: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .reader-bottom-bar,
    .bar-btn {
      transition: none;
    }
  }
</style>
