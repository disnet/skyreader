<script lang="ts">
  // A horizontal Home rail of the reader's generated magazine issues, newest
  // first. Mirrors HomeLane's structure (header + scroll-snapping track + desktop
  // hover chevrons and edge fades) but with an issue-shaped card — an issue is a
  // set of articles, not a single one, so it doesn't fit the article LaneCardVM.
  import { onMount, tick } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import type { Magazine } from '$lib/types';
  import { formatMagazineDate, magazineIssueSummary } from '$lib/utils/dailyMagazine';
  import {
    DAILY_MAGAZINE_MINUTE_OPTIONS,
    DAILY_MAGAZINE_ORDER_OPTIONS,
    DAILY_MAGAZINE_SOURCE_OPTIONS,
    preferences,
  } from '$lib/stores/preferences.svelte';

  interface Props {
    issues: Magazine[];
    generating: boolean;
    // Feed-sourced issues draw from the local unread window, so they wait on it.
    feedsReady?: boolean;
    // A one-line note after a generate that found nothing to put in an issue.
    hint?: string;
    onGenerate: () => void | Promise<void>;
    onOpen: (rkey: string) => void;
  }

  let { issues, generating, feedsReady = true, hint = '', onGenerate, onOpen }: Props = $props();

  // The split button's caret opens the issue recipe: source, length, order.
  // Choices stick as preferences, so the main button reuses them next time.
  let panelOpen = $state(false);
  let splitEl = $state<HTMLDivElement | null>(null);
  let panelEl = $state<HTMLDivElement | null>(null);

  let sourceLabel = $derived(
    DAILY_MAGAZINE_SOURCE_OPTIONS.find((o) => o.value === preferences.dailyMagazineSource)?.label ??
      ''
  );
  let orderLabel = $derived(
    DAILY_MAGAZINE_ORDER_OPTIONS.find((o) => o.value === preferences.dailyMagazineOrder)?.label ??
      ''
  );
  let recipeSummary = $derived(
    `${sourceLabel} · ${preferences.dailyMagazineMinutes} min · ${orderLabel}`
  );
  let generateDisabled = $derived(
    generating || (preferences.dailyMagazineSource === 'feeds' && !feedsReady)
  );

  function generate() {
    panelOpen = false;
    onGenerate();
  }

  async function togglePanel() {
    panelOpen = !panelOpen;
    if (panelOpen) {
      await tick();
      panelEl?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    }
  }

  function closePanel(refocus: boolean) {
    panelOpen = false;
    if (refocus) splitEl?.querySelector<HTMLButtonElement>('.caret')?.focus();
  }

  function onPanelKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closePanel(true);
    }
  }

  // Arrow keys move within a radio group (and select, as native radios do).
  function onRadioKeydown(event: KeyboardEvent) {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const group = (event.currentTarget as HTMLElement).closest('[role="radiogroup"]');
    const radios = [
      ...(group?.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)') ?? []),
    ];
    const i = radios.indexOf(event.currentTarget as HTMLButtonElement);
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
    const next = radios[(i + step + radios.length) % radios.length];
    next?.focus();
    next?.click();
  }

  function onWindowPointerDown(event: PointerEvent) {
    if (panelOpen && splitEl && !splitEl.contains(event.target as Node)) closePanel(false);
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

<svelte:window onpointerdown={onWindowPointerDown} />

<section class="lane" aria-label="Issues">
  <div class="lane-header">
    <h2 class="lane-title">
      <span class="lane-icon"><Icon name="newspaper" size={16} /></span>
      Daily magazine
    </h2>
    <div class="split" bind:this={splitEl}>
      <button
        class="generate"
        onclick={generate}
        disabled={generateDisabled}
        title={generating ? undefined : recipeSummary}
      >
        {#if generating}
          <span class="spinner" aria-hidden="true"></span>
          <span>Generating…</span>
        {:else}
          <Icon name="plus" size={15} />
          <span>{issues.length ? 'New issue' : 'Generate issue'}</span>
        {/if}
      </button>
      <button
        class="caret"
        onclick={togglePanel}
        disabled={generating}
        aria-label="Issue settings"
        aria-haspopup="dialog"
        aria-expanded={panelOpen}
      >
        <Icon name="chevron-down" size={15} />
      </button>
      {#if panelOpen}
        <div
          class="panel"
          role="dialog"
          aria-label="Issue settings"
          tabindex="-1"
          bind:this={panelEl}
          onkeydown={onPanelKeydown}
        >
          <div class="field">
            <span class="field-label" id="mag-source">From</span>
            <div class="sources" role="radiogroup" aria-labelledby="mag-source">
              {#each DAILY_MAGAZINE_SOURCE_OPTIONS as option}
                {@const checked = preferences.dailyMagazineSource === option.value}
                <button
                  class="source"
                  class:checked
                  role="radio"
                  aria-checked={checked}
                  tabindex={checked ? 0 : -1}
                  onclick={() => preferences.setDailyMagazineSource(option.value)}
                  onkeydown={onRadioKeydown}
                >
                  <span class="source-icon"
                    ><Icon name={option.value === 'feeds' ? 'rss' : 'bookmark'} size={15} /></span
                  >
                  <span class="source-text">
                    <span class="source-label">{option.label}</span>
                    <span class="source-hint"
                      >{option.value === 'feeds'
                        ? feedsReady
                          ? 'Unread articles you follow'
                          : 'Loading your feeds…'
                        : 'Articles you’ve saved'}</span
                    >
                  </span>
                  {#if checked}<span class="source-check"><Icon name="check" size={14} /></span
                    >{/if}
                </button>
              {/each}
            </div>
          </div>

          <div class="field">
            <span class="field-label" id="mag-length">Length in minutes</span>
            <div class="segmented" role="radiogroup" aria-labelledby="mag-length">
              {#each DAILY_MAGAZINE_MINUTE_OPTIONS as minutes}
                {@const checked = preferences.dailyMagazineMinutes === minutes}
                <button
                  class="segment"
                  class:checked
                  role="radio"
                  aria-checked={checked}
                  aria-label="{minutes} minutes"
                  tabindex={checked ? 0 : -1}
                  onclick={() => preferences.setDailyMagazineMinutes(minutes)}
                  onkeydown={onRadioKeydown}>{minutes}</button
                >
              {/each}
            </div>
          </div>

          <div class="field">
            <span class="field-label" id="mag-order">Order</span>
            <div class="segmented" role="radiogroup" aria-labelledby="mag-order">
              {#each DAILY_MAGAZINE_ORDER_OPTIONS as option}
                {@const checked = preferences.dailyMagazineOrder === option.value}
                <button
                  class="segment"
                  class:checked
                  role="radio"
                  aria-checked={checked}
                  tabindex={checked ? 0 : -1}
                  onclick={() => preferences.setDailyMagazineOrder(option.value)}
                  onkeydown={onRadioKeydown}>{option.label}</button
                >
              {/each}
            </div>
          </div>

          <button class="panel-generate" onclick={generate} disabled={generateDisabled}>
            {issues.length ? 'New issue' : 'Generate issue'}
            <Icon name="arrow-right" size={15} />
          </button>
        </div>
      {/if}
    </div>
  </div>

  {#if hint}
    <p class="empty">{hint}</p>
  {/if}
  {#if issues.length === 0}
    {#if !hint}<p class="empty">Generate an issue to start reading across devices.</p>{/if}
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
            <span class="thumb"
              ><Icon name={mag.params.source === 'feeds' ? 'rss' : 'newspaper'} size={18} /></span
            >
            <span class="body">
              <span class="title">{formatMagazineDate(new Date(mag.createdAt * 1000))}</span>
              <span class="meta"
                >{magazineIssueSummary(mag.items.length, mag.params.totalMinutes)}</span
              >
              {#if mag.params.source === 'feeds'}<span class="meta">From your feeds</span>{/if}
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
    display: flex;
    align-items: center;
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

  .split {
    position: relative;
    display: inline-flex;
    flex: 0 0 auto;
  }
  .generate,
  .caret {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    border: 0;
    background: var(--color-primary);
    color: #fff;
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    cursor: pointer;
    transition: background-color 0.15s ease;
  }
  .generate {
    padding: 0.4rem 0.75rem 0.4rem 0.75rem;
    border-radius: 999px 0 0 999px;
  }
  /* The caret shares the pill, split off by a hairline of the page colour. */
  .caret {
    padding: 0.4rem 0.6rem 0.4rem 0.45rem;
    border-radius: 0 999px 999px 0;
    border-left: 1px solid rgba(255, 255, 255, 0.35);
  }
  .generate:hover:not(:disabled),
  .caret:hover:not(:disabled),
  .caret[aria-expanded='true'] {
    background: var(--color-primary-dark);
  }
  .generate:focus-visible,
  .caret:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
    position: relative;
    z-index: 1;
  }
  .generate:disabled,
  .caret:disabled {
    opacity: 0.7;
    cursor: default;
  }
  .spinner {
    width: 0.8rem;
    height: 0.8rem;
    border: 2px solid rgba(255, 255, 255, 0.4);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* Floating, so it earns the one shadow (Flat-By-Default). */
  .panel {
    position: absolute;
    top: calc(100% + 0.375rem);
    right: 0;
    z-index: 20;
    width: 17.5rem;
    max-width: calc(100vw - 2rem);
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    padding: 0.875rem;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
  }
  .panel:focus {
    outline: none;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .field-label {
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    color: var(--color-text-secondary);
  }

  .sources {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .source {
    display: flex;
    align-items: flex-start;
    gap: 0.625rem;
    width: 100%;
    padding: 0.5rem 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: none;
    color: var(--color-text);
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition:
      background-color 0.15s ease,
      border-color 0.15s ease;
  }
  .source:hover:not(.checked) {
    background: var(--color-bg-secondary);
  }
  .source.checked {
    border-color: var(--color-primary);
    background: var(--color-sidebar-active);
  }
  .source-icon {
    display: inline-flex;
    padding-top: 0.125rem;
    color: var(--color-text-secondary);
  }
  .source.checked .source-icon,
  .source-check {
    color: var(--color-primary);
  }
  .source-text {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .source-label {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }
  .source-hint {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }
  .source-check {
    display: inline-flex;
    padding-top: 0.125rem;
  }

  .segmented {
    display: flex;
    padding: 2px;
    border-radius: 999px;
    background: var(--color-bg-secondary);
  }
  .segment {
    flex: 1;
    padding: 0.3rem 0.25rem;
    border: 0;
    border-radius: 999px;
    background: none;
    color: var(--color-text-secondary);
    font: inherit;
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    white-space: nowrap;
    cursor: pointer;
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }
  .segment:hover:not(.checked) {
    color: var(--color-text);
  }
  .segment.checked {
    background: var(--color-bg);
    color: var(--color-primary);
    box-shadow: 0 0 0 1px var(--color-border);
  }
  .source:focus-visible,
  .segment:focus-visible,
  .panel-generate:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  .panel-generate {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    padding: 0.5rem 1rem;
    border: 0;
    border-radius: 8px;
    background: var(--color-primary);
    color: #fff;
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    cursor: pointer;
    transition: background-color 0.15s ease;
  }
  .panel-generate:hover:not(:disabled) {
    background: var(--color-primary-dark);
  }
  .panel-generate:disabled {
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
  }

  @media (prefers-color-scheme: dark) {
    .panel {
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    }
    .issue-card:hover {
      background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.03));
    }
    .scroll-btn {
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
    }
  }
</style>
