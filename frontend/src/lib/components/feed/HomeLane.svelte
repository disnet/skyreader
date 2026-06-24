<script lang="ts">
  // One horizontal lane on the Home view: a section header (title + optional
  // action) above a scroll-snapping track of compact tiles. Borrows Readwise's
  // lane structure without its loud cover-art carousels. Desktop gets hover
  // chevrons + edge fades when the track overflows; touch scrolls natively.
  import { onMount } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import type { IconName } from '$lib/components/Icon.svelte';
  import HomeLaneCard from './HomeLaneCard.svelte';
  import type { LaneCardVM } from './homeLane';

  type Action =
    | { kind: 'button'; label: string; icon?: IconName; onClick: () => void }
    | { kind: 'link'; label: string; href: string };

  interface Props {
    title: string;
    icon: IconName;
    items: LaneCardVM[];
    action?: Action;
    loading?: boolean;
    onOpen: (vm: LaneCardVM) => void;
    onHover?: (vm: LaneCardVM) => void;
  }

  let { title, icon, items, action, loading = false, onOpen, onHover }: Props = $props();

  let track = $state<HTMLDivElement | null>(null);
  let canLeft = $state(false);
  let canRight = $state(false);

  function updateAffordances() {
    const el = track;
    if (!el) return;
    canLeft = el.scrollLeft > 4;
    canRight = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
  }

  function scrollByCards(direction: 1 | -1) {
    const el = track;
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({
      left: direction * Math.round(el.clientWidth * 0.85),
      behavior: reduce ? 'auto' : 'smooth',
    });
  }

  onMount(() => {
    updateAffordances();
    const ro = new ResizeObserver(updateAffordances);
    if (track) ro.observe(track);
    return () => ro.disconnect();
  });

  // When the item set changes — a shuffle re-rolls the lane, or items reorder —
  // snap back to the start so the new set reads as a fresh lane rather than a
  // mid-scroll jump, then re-measure the affordances. Tracks the ordered key
  // signature, not just length: a reshuffle keeps the same count, so length alone
  // wouldn't fire this.
  let itemSignature = $derived(items.map((vm) => vm.key).join('|'));
  $effect(() => {
    itemSignature;
    if (track) track.scrollLeft = 0;
    requestAnimationFrame(updateAffordances);
  });
</script>

<section class="lane" aria-label={title}>
  <div class="lane-header">
    <h2 class="lane-title">
      <span class="lane-icon"><Icon name={icon} size={16} /></span>
      {title}
    </h2>
    {#if action}
      {#if action.kind === 'link'}
        <a class="lane-action" href={action.href}>
          {action.label}
          <Icon name="arrow-right" size={13} />
        </a>
      {:else}
        <button class="lane-action" onclick={action.onClick}>
          {#if action.icon}<Icon name={action.icon} size={13} />{/if}
          {action.label}
        </button>
      {/if}
    {/if}
  </div>

  <div class="lane-viewport" class:fade-left={canLeft} class:fade-right={canRight}>
    <button
      class="scroll-btn left"
      class:visible={canLeft}
      onclick={() => scrollByCards(-1)}
      aria-label="Scroll {title} left"
      tabindex={canLeft ? 0 : -1}
    >
      <Icon name="chevron-left" size={18} />
    </button>

    <div class="lane-track" bind:this={track} onscroll={updateAffordances}>
      {#if loading}
        {#each Array(4) as _, i (i)}
          <div class="skeleton-card" aria-hidden="true">
            <div class="skeleton-thumb"></div>
            <div class="skeleton-lines">
              <div class="skeleton-line"></div>
              <div class="skeleton-line short"></div>
            </div>
          </div>
        {/each}
      {:else}
        {#each items as vm (vm.key)}
          <HomeLaneCard
            title={vm.title}
            domain={vm.domain}
            image={vm.image}
            faviconUrl={vm.faviconUrl}
            metaLabel={vm.metaLabel}
            progress={vm.progress}
            onOpen={() => onOpen(vm)}
            onHover={() => onHover?.(vm)}
          />
        {/each}
      {/if}
    </div>

    <button
      class="scroll-btn right"
      class:visible={canRight}
      onclick={() => scrollByCards(1)}
      aria-label="Scroll {title} right"
      tabindex={canRight ? 0 : -1}
    >
      <Icon name="chevron-right" size={18} />
    </button>
  </div>
</section>

<style>
  .lane {
    margin-bottom: 1.75rem;
  }

  .lane-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    padding: 0 0.25rem;
    margin-bottom: 0.625rem;
  }

  .lane-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    line-height: var(--leading-snug);
    color: var(--color-text);
  }

  .lane-icon {
    display: inline-flex;
    color: var(--color-text-secondary);
  }

  .lane-action {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    flex-shrink: 0;
    background: none;
    border: none;
    padding: 0.25rem 0.25rem;
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-text-secondary);
    text-decoration: none;
    cursor: pointer;
    border-radius: 6px;
    transition: color 0.15s ease;
  }

  @media (hover: hover) {
    .lane-action:hover {
      color: var(--color-primary);
    }
  }

  .lane-action:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  .lane-viewport {
    position: relative;
  }

  /* Edge fades cue that the track keeps going, only on the side that can scroll. */
  .lane-viewport.fade-left .lane-track {
    -webkit-mask-image: linear-gradient(to right, transparent, #000 2.5rem);
    mask-image: linear-gradient(to right, transparent, #000 2.5rem);
  }

  .lane-viewport.fade-right .lane-track {
    -webkit-mask-image: linear-gradient(to left, transparent, #000 2.5rem);
    mask-image: linear-gradient(to left, transparent, #000 2.5rem);
  }

  .lane-viewport.fade-left.fade-right .lane-track {
    -webkit-mask-image: linear-gradient(
      to right,
      transparent,
      #000 2.5rem,
      #000 calc(100% - 2.5rem),
      transparent
    );
    mask-image: linear-gradient(
      to right,
      transparent,
      #000 2.5rem,
      #000 calc(100% - 2.5rem),
      transparent
    );
  }

  .lane-track {
    display: flex;
    gap: 0.75rem;
    overflow-x: auto;
    scroll-snap-type: x proximity;
    padding: 0.25rem 0.25rem 0.5rem;
    /* Hide the scrollbar — the chevrons + fades carry the affordance. */
    scrollbar-width: none;
  }

  .lane-track::-webkit-scrollbar {
    display: none;
  }

  .scroll-btn {
    position: absolute;
    top: calc(50% - 0.25rem);
    transform: translateY(-50%);
    z-index: 2;
    display: none;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    color: var(--color-text);
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    opacity: 0;
    transition: opacity 0.15s ease;
  }

  .scroll-btn.left {
    left: -0.5rem;
  }

  .scroll-btn.right {
    right: -0.5rem;
  }

  /* Chevrons are a desktop pointer affordance; touch users scroll directly. */
  @media (hover: hover) and (pointer: fine) {
    .scroll-btn {
      display: flex;
    }

    .lane-viewport:hover .scroll-btn.visible {
      opacity: 1;
    }

    .scroll-btn:focus-visible {
      opacity: 1;
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
  }

  /* Skeletons mirror the tile footprint so first paint doesn't reflow. */
  .skeleton-card {
    flex-shrink: 0;
    display: flex;
    gap: 0.75rem;
    width: 16.5rem;
    padding: 0.75rem 0.875rem 0.875rem;
    border: 1px solid var(--color-border);
    border-radius: 12px;
  }

  .skeleton-thumb {
    flex-shrink: 0;
    width: 3.25rem;
    height: 3.25rem;
    border-radius: 8px;
    background: var(--color-bg-secondary, #f0f0f0);
  }

  .skeleton-lines {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding-top: 0.25rem;
  }

  .skeleton-line {
    height: 0.7rem;
    border-radius: 4px;
    background: var(--color-bg-secondary, #f0f0f0);
  }

  .skeleton-line.short {
    width: 55%;
  }

  /* Match the compact, square mobile tile so loading doesn't reflow. */
  @media (max-width: 640px) {
    .skeleton-card {
      flex-direction: column;
      align-items: stretch;
      width: 9.75rem;
      padding: 0 0 0.7rem;
      gap: 0;
      overflow: hidden;
    }

    .skeleton-thumb {
      width: 100%;
      height: 5.5rem;
      border-radius: 0;
    }

    .skeleton-lines {
      padding: 0.5rem 0.625rem 0;
    }
  }

  .skeleton-thumb,
  .skeleton-line {
    animation: pulse 1.4s ease-in-out infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.45;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .skeleton-thumb,
    .skeleton-line {
      animation: none;
    }
  }

  @media (prefers-color-scheme: dark) {
    .skeleton-thumb,
    .skeleton-line {
      background: rgba(255, 255, 255, 0.06);
    }

    .scroll-btn {
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
    }
  }
</style>
