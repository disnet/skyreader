<script lang="ts">
  // A horizontal Home rail of the reader's generated magazine issues, newest
  // first. Mirrors HomeLane's structure (header + scroll-snapping track + desktop
  // hover chevrons and edge fades) but with an issue-shaped card — an issue is a
  // set of articles, not a single one, so it doesn't fit the article LaneCardVM.
  import { onMount } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import type { Magazine } from '$lib/types';
  import { formatMagazineDate, magazineIssueSummary } from '$lib/utils/dailyMagazine';
  import {
    DAILY_MAGAZINE_MINUTE_OPTIONS,
    DAILY_MAGAZINE_ORDER_OPTIONS,
    preferences,
    type DailyMagazineMinutes,
    type DailyMagazineOrder,
  } from '$lib/stores/preferences.svelte';

  interface Props {
    issues: Magazine[];
    generating: boolean;
    onGenerate: () => void | Promise<void>;
    onOpen: (rkey: string) => void;
  }

  let { issues, generating, onGenerate, onOpen }: Props = $props();

  // Length and article order shape the *next* issue, so they sit behind one
  // quiet settings button rather than inline in the header: the lane leads with
  // its issues and the one action ("New issue"), not with form controls.
  let settingsOpen = $state(false);
  let settingsWrap = $state<HTMLDivElement | null>(null);
  let settingsButton = $state<HTMLButtonElement | null>(null);

  let orderLabel = $derived(
    DAILY_MAGAZINE_ORDER_OPTIONS.find((o) => o.value === preferences.dailyMagazineOrder)?.label ??
      ''
  );
  let settingsSummary = $derived(`${preferences.dailyMagazineMinutes} min · ${orderLabel}`);

  function setLength(minutes: DailyMagazineMinutes) {
    preferences.setDailyMagazineMinutes(minutes);
  }

  function setOrder(order: DailyMagazineOrder) {
    preferences.setDailyMagazineOrder(order);
  }

  function closeSettings(returnFocus = false) {
    settingsOpen = false;
    if (returnFocus) settingsButton?.focus();
  }

  function handleDocumentPointer(e: PointerEvent) {
    if (settingsOpen && settingsWrap && !settingsWrap.contains(e.target as Node)) {
      closeSettings();
    }
  }

  function handleDocumentKeydown(e: KeyboardEvent) {
    if (settingsOpen && e.key === 'Escape') {
      e.preventDefault();
      closeSettings(true);
    }
  }

  // Fraction read, from the resume pointer (which article of how many). Null when
  // the issue hasn't been opened yet, so the spine bar only shows real progress.
  function issueProgress(mag: Magazine): number | null {
    const key = mag.position?.itemKey;
    if (!key || mag.items.length === 0) return null;
    const idx = mag.items.findIndex((i) => i.displayKey === key);
    if (idx < 0) return null;
    return Math.max(2, Math.min(100, Math.round(((idx + 1) / mag.items.length) * 100)));
  }

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

  // Re-measure when the issue set changes (a new issue prepends).
  let signature = $derived(issues.map((m) => m.rkey).join('|'));
  $effect(() => {
    signature;
    requestAnimationFrame(updateAffordances);
  });
</script>

<svelte:document onpointerdown={handleDocumentPointer} onkeydown={handleDocumentKeydown} />

<section class="lane" aria-label="Issues">
  <div class="lane-header">
    <h2 class="lane-title">
      <span class="lane-icon"><Icon name="newspaper" size={16} /></span>
      Daily magazine
    </h2>
    <div class="header-controls">
      <button class="generate" onclick={() => onGenerate()} disabled={generating}>
        <span>{generating ? 'Generating…' : issues.length ? 'New issue' : 'Generate issue'}</span>
        <Icon name="arrow-right" size={15} />
      </button>
      <div class="settings" bind:this={settingsWrap}>
        <button
          bind:this={settingsButton}
          class="settings-btn"
          class:open={settingsOpen}
          onclick={() => (settingsOpen = !settingsOpen)}
          aria-label="Issue settings"
          aria-expanded={settingsOpen}
          aria-controls="magazine-settings"
          title="Issue settings: {settingsSummary}"
        >
          <Icon name="sliders" size={16} />
        </button>
        {#if settingsOpen}
          <div
            class="settings-panel"
            id="magazine-settings"
            role="dialog"
            aria-label="Issue settings"
          >
            <fieldset class="setting">
              <legend>Length</legend>
              <div class="choices">
                {#each DAILY_MAGAZINE_MINUTE_OPTIONS as minutes}
                  <button
                    type="button"
                    class="choice"
                    aria-pressed={preferences.dailyMagazineMinutes === minutes}
                    onclick={() => setLength(minutes)}>{minutes} min</button
                  >
                {/each}
              </div>
            </fieldset>
            <fieldset class="setting">
              <legend>Articles</legend>
              <div class="choices">
                {#each DAILY_MAGAZINE_ORDER_OPTIONS as option}
                  <button
                    type="button"
                    class="choice"
                    aria-pressed={preferences.dailyMagazineOrder === option.value}
                    onclick={() => setOrder(option.value)}>{option.label}</button
                  >
                {/each}
              </div>
            </fieldset>
            <p class="settings-note">Applies to your next issue.</p>
          </div>
        {/if}
      </div>
    </div>
  </div>

  {#if issues.length === 0}
    <p class="empty">Generate an issue to start reading across devices.</p>
  {:else}
    <div class="lane-viewport" class:fade-left={canLeft} class:fade-right={canRight}>
      <button
        class="scroll-btn left"
        class:visible={canLeft}
        onclick={() => scrollByCards(-1)}
        aria-label="Scroll Issues left"
        tabindex={canLeft ? 0 : -1}
      >
        <Icon name="chevron-left" size={18} />
      </button>

      <div class="lane-track" bind:this={track} onscroll={updateAffordances}>
        {#each issues as mag (mag.rkey)}
          {@const pct = issueProgress(mag)}
          <button class="issue-card" onclick={() => onOpen(mag.rkey)}>
            <span class="thumb"><Icon name="newspaper" size={18} /></span>
            <span class="body">
              <span class="title">{formatMagazineDate(new Date(mag.createdAt * 1000))}</span>
              <span class="meta"
                >{magazineIssueSummary(mag.items.length, mag.params.totalMinutes)}</span
              >
            </span>
            {#if pct !== null}
              <span class="progress" aria-hidden="true">
                <span class="progress-fill" style="width: {pct}%"></span>
              </span>
            {/if}
          </button>
        {/each}
      </div>

      <button
        class="scroll-btn right"
        class:visible={canRight}
        onclick={() => scrollByCards(1)}
        aria-label="Scroll Issues right"
        tabindex={canRight ? 0 : -1}
      >
        <Icon name="chevron-right" size={18} />
      </button>
    </div>
  {/if}
</section>

<style>
  .lane {
    margin-bottom: 1.75rem;
  }
  .lane-header {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
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

  .header-controls {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }

  .settings {
    position: relative;
  }
  .settings-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }
  .settings-btn:hover,
  .settings-btn.open {
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }
  .settings-btn:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  /* Floats over the lane, so it earns the one shadow (Flat-By-Default). */
  .settings-panel {
    position: absolute;
    top: calc(100% + 0.375rem);
    right: 0;
    z-index: 20;
    width: max-content;
    max-width: calc(100vw - 2rem);
    padding: 0.875rem 1rem 0.75rem;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 10px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  }
  .setting {
    margin: 0 0 0.875rem;
    padding: 0;
    border: 0;
    min-width: 0;
  }
  .setting legend {
    padding: 0;
    margin-bottom: 0.4rem;
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
  }
  .choices {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }
  .choice {
    padding: 0.375rem 0.7rem;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: none;
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    white-space: nowrap;
    cursor: pointer;
    transition:
      background-color 0.15s ease,
      border-color 0.15s ease,
      color 0.15s ease;
  }
  @media (hover: hover) {
    .choice:hover:not([aria-pressed='true']) {
      background: var(--color-bg-secondary);
    }
  }
  .choice[aria-pressed='true'] {
    border-color: var(--color-primary);
    background: color-mix(in srgb, var(--color-primary) 10%, transparent);
    color: var(--color-primary);
    font-weight: var(--weight-semibold);
  }
  .choice:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  .settings-note {
    margin: 0;
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
  }
  .generate {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    flex: 0 0 auto;
    padding: 0;
    border: 0;
    background: none;
    color: var(--color-primary);
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    cursor: pointer;
    border-radius: 4px;
  }
  .generate:hover:not(:disabled) {
    text-decoration: underline;
  }
  .generate:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 3px;
  }
  .generate:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .empty {
    margin: 0;
    padding: 0 0.25rem;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }
  .lane-viewport {
    position: relative;
  }
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
    scrollbar-width: none;
  }
  .lane-track::-webkit-scrollbar {
    display: none;
  }

  .issue-card {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    width: 14rem;
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
    .issue-card:hover {
      background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.025));
      border-color: var(--color-text-secondary);
    }
  }
  .issue-card:focus-visible {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.15);
  }
  .thumb {
    flex-shrink: 0;
    width: 3.25rem;
    height: 3.25rem;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-bg-secondary, #f5f5f5);
    color: var(--color-text-secondary);
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
    white-space: nowrap;
  }
  .meta {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
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

  @media (max-width: 640px) {
    .issue-card {
      width: 12rem;
    }
    /* On a phone the panel spans the lane, anchored to the header rather than
       the button, so it can't run off the left edge. */
    .settings {
      position: static;
    }
    .settings-panel {
      left: 0;
      right: 0;
      width: auto;
      max-width: none;
    }
  }
  @media (prefers-color-scheme: dark) {
    .issue-card:hover {
      background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.03));
    }
    .scroll-btn {
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
    }
    .settings-panel {
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
    }
  }
</style>
