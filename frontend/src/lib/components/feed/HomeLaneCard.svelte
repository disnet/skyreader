<script lang="ts">
  // A single compact tile in a Home lane. Presentational: HomePage computes the
  // view-model (title, source, read-time / time-left, progress) so this stays a
  // thin, fast render reused across every lane. Restrained on purpose — a small
  // thumbnail and text, not a magazine cover — per the Reading Room design system.
  import Icon from '$lib/components/Icon.svelte';

  interface Props {
    title: string;
    domain: string | null;
    image: string | null;
    faviconUrl: string;
    /** "6 min left" for in-progress, "8 min read" otherwise, or null when unknown. */
    metaLabel: string | null;
    /** 0–1 reading progress; renders the spine bar when present (Continue reading). */
    progress: number | null;
    onOpen?: () => void;
    onHover?: () => void;
  }

  let { title, domain, image, faviconUrl, metaLabel, progress, onOpen, onHover }: Props = $props();

  // A cover image that 404s would otherwise leave a broken-image box; fall back to
  // the favicon tile on error.
  let imageFailed = $state(false);
  let faviconFailed = $state(false);
  let showCover = $derived(Boolean(image) && !imageFailed);
  let showFavicon = $derived(Boolean(faviconUrl) && !faviconFailed);

  let progressPct = $derived(
    progress == null ? null : Math.max(2, Math.min(100, Math.round(progress * 100)))
  );
</script>

<button class="lane-card" onclick={() => onOpen?.()} onmouseenter={() => onHover?.()}>
  <span class="thumb" class:has-cover={showCover}>
    {#if showCover}
      <img src={image} alt="" loading="lazy" onerror={() => (imageFailed = true)} />
    {:else if showFavicon}
      <img
        class="favicon"
        src={faviconUrl}
        alt=""
        loading="lazy"
        onerror={() => (faviconFailed = true)}
      />
    {:else}
      <Icon name="file-text" size={18} />
    {/if}
  </span>

  <span class="body">
    <span class="title">{title}</span>
    <span class="meta">
      {#if domain}<span class="domain">{domain}</span>{/if}
      {#if domain && metaLabel}<span class="dot" aria-hidden="true">·</span>{/if}
      {#if metaLabel}<span class="read-time">{metaLabel}</span>{/if}
    </span>
  </span>

  {#if progressPct !== null}
    <span class="progress" aria-hidden="true">
      <span class="progress-fill" style="width: {progressPct}%"></span>
    </span>
  {/if}
</button>

<style>
  .lane-card {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    width: 16.5rem;
    /* Hold the set width so the track scrolls instead of squeezing tiles. */
    flex-shrink: 0;
    padding: 0.75rem 0.875rem 0.875rem;
    background: none;
    border: 1px solid var(--color-border);
    border-radius: 12px;
    cursor: pointer;
    text-align: left;
    font: inherit;
    color: var(--color-text);
    scroll-snap-align: start;
    transition:
      background-color 0.15s ease,
      border-color 0.15s ease;
  }

  @media (hover: hover) {
    .lane-card:hover {
      background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.025));
      border-color: var(--color-text-secondary);
    }
  }

  .lane-card:focus-visible {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.15);
  }

  .thumb {
    flex-shrink: 0;
    width: 3.25rem;
    height: 3.25rem;
    border-radius: 8px;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-bg-secondary, #f5f5f5);
    color: var(--color-text-secondary);
  }

  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  /* Favicon fallback sits small and centered rather than filling the tile. */
  .thumb .favicon {
    width: 22px;
    height: 22px;
    border-radius: 4px;
    object-fit: contain;
  }

  .body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .title {
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    line-height: var(--leading-snug);
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    min-width: 0;
  }

  .domain {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .dot {
    opacity: 0.55;
    flex-shrink: 0;
  }

  .read-time {
    white-space: nowrap;
    flex-shrink: 0;
  }

  /* Reading-progress spine along the bottom edge — only on Continue reading. */
  .progress {
    position: absolute;
    left: 0.875rem;
    right: 0.875rem;
    bottom: 0.5rem;
    height: 2px;
    border-radius: 999px;
    background: var(--color-border);
    overflow: hidden;
  }

  .progress-fill {
    display: block;
    height: 100%;
    border-radius: 999px;
    background: var(--color-primary);
  }

  /* Phones: a more square, compact tile — cover on top, text below — so several
     fit across the viewport instead of one wide row. */
  @media (max-width: 640px) {
    .lane-card {
      flex-direction: column;
      align-items: stretch;
      gap: 0;
      width: 9.75rem;
      padding: 0 0 0.7rem;
      overflow: hidden;
    }

    .thumb {
      width: 100%;
      height: 5.5rem;
      /* The card's own radius + overflow:hidden clips these top corners. */
      border-radius: 0;
    }

    .thumb .favicon {
      width: 26px;
      height: 26px;
    }

    .body {
      padding: 0.5rem 0.625rem 0;
      gap: 0.25rem;
    }

    .progress {
      left: 0.625rem;
      right: 0.625rem;
      bottom: 0.4rem;
    }
  }

  @media (prefers-color-scheme: dark) {
    .lane-card:hover {
      background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.03));
    }
  }
</style>
