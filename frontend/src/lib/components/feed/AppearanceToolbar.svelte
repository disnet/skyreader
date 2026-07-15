<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import {
    preferences,
    type ArticleFont,
    ARTICLE_FONT_SIZE_MIN,
    ARTICLE_FONT_SIZE_MAX,
  } from '$lib/stores/preferences.svelte';

  // Each option previews in its own reader typeface, with a plain-language hint
  // so the two serifs (Charter vs. Literata) don't read as the same choice.
  const fontOptions: { value: ArticleFont; name: string; hint: string; family: string }[] = [
    { value: 'sans-serif', name: 'Sans', hint: 'System', family: 'var(--font-sans-serif)' },
    { value: 'serif', name: 'Serif', hint: 'Charter', family: 'var(--font-serif)' },
    { value: 'literata', name: 'Literata', hint: 'Book', family: 'var(--font-literata)' },
    { value: 'mono', name: 'Mono', hint: 'Code', family: 'var(--font-mono)' },
  ];

  const current = $derived(
    fontOptions.find((o) => o.value === preferences.articleFont) ?? fontOptions[1]
  );

  let open = $state(false);
  let dropdownRef = $state<HTMLDivElement | null>(null);
  let triggerRef = $state<HTMLButtonElement | null>(null);
  let menuRef = $state<HTMLDivElement | null>(null);
  // The menu renders position:fixed and is placed from the trigger's rect so it
  // escapes any clipping/scrolling ancestor (reader chrome, bottom sheet) and
  // stays inside the viewport. `positioned` gates visibility until the first
  // measurement so it never flashes below-then-flips-above.
  let menuPos = $state<{ top: number; left: number; maxHeight: number } | null>(null);
  const positioned = $derived(menuPos !== null);

  // Reparent the menu to <body>. A position:fixed element resolves against the
  // nearest ancestor with a transform/filter/backdrop-filter as its containing
  // block, not the viewport — and both the toolbar pill (backdrop-filter) and the
  // full-screen reader header (transform) are such ancestors, which threw the
  // viewport-coordinate placement off-screen. Portaling to body removes any such
  // ancestor so the getBoundingClientRect() coordinates land correctly.
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    // Clicks inside the (now body-level) menu must not bubble to the document
    // click-outside handlers — ours here, and the full-screen reader's own one
    // that closes the whole style row — which would otherwise fire because the
    // menu is no longer a DOM descendant of the toolbar/header.
    const stop = (e: Event) => e.stopPropagation();
    node.addEventListener('click', stop);
    return {
      destroy() {
        node.removeEventListener('click', stop);
        node.parentNode?.removeChild(node);
      },
    };
  }

  function positionMenu() {
    if (!triggerRef || !menuRef) return;
    const t = triggerRef.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = 6;
    const margin = 8;
    const menuW = menuRef.offsetWidth;
    const menuH = menuRef.offsetHeight;

    const spaceBelow = vh - t.bottom - gap - margin;
    const spaceAbove = t.top - gap - margin;

    let top: number;
    let maxHeight: number;
    // Prefer below; flip above only when it doesn't fit below and there's more
    // room above. Cap to the available space and let the menu scroll internally.
    if (menuH <= spaceBelow || spaceBelow >= spaceAbove) {
      top = t.bottom + gap;
      maxHeight = Math.max(120, spaceBelow);
    } else {
      maxHeight = Math.max(120, spaceAbove);
      top = t.top - gap - Math.min(menuH, maxHeight);
    }

    let left = t.left;
    if (left + menuW > vw - margin) left = vw - menuW - margin;
    if (left < margin) left = margin;

    menuPos = { top, left, maxHeight };
  }

  function reposition() {
    if (open) positionMenu();
  }

  // Position (and keep positioning) whenever the menu is open.
  $effect(() => {
    if (open && menuRef) {
      requestAnimationFrame(positionMenu);
    } else {
      menuPos = null;
    }
  });

  function selectFont(value: ArticleFont) {
    preferences.setArticleFont(value);
    open = false;
  }

  function handleClickOutside(e: MouseEvent) {
    // The menu is portaled to <body>, so it's no longer inside dropdownRef —
    // check it separately so a click within the menu doesn't count as outside.
    const target = e.target as Node;
    if (
      open &&
      dropdownRef &&
      !dropdownRef.contains(target) &&
      !(menuRef && menuRef.contains(target))
    ) {
      open = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (open && e.key === 'Escape') {
      open = false;
    }
  }

  onMount(() => {
    document.addEventListener('click', handleClickOutside);
    document.addEventListener('keydown', handleKeydown);
    // Keep the fixed menu glued to the trigger as things move around it.
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
  });

  onDestroy(() => {
    document.removeEventListener('click', handleClickOutside);
    document.removeEventListener('keydown', handleKeydown);
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition);
  });
</script>

<div class="appearance-toolbar" role="toolbar" aria-label="Appearance controls">
  <!-- Font Style -->
  <div class="toolbar-group">
    <span class="group-label">Font</span>
    <div class="font-dropdown" bind:this={dropdownRef}>
      <button
        bind:this={triggerRef}
        class="font-trigger"
        class:open
        aria-haspopup="listbox"
        aria-expanded={open}
        onclick={(e) => {
          e.stopPropagation();
          open = !open;
        }}
        title="Choose reading font"
      >
        <span class="trigger-name" style:font-family={current.family}>{current.name}</span>
        <Icon name="chevron-down" size={14} />
      </button>

      {#if open}
        <div
          bind:this={menuRef}
          use:portal
          class="font-menu"
          class:positioned
          role="listbox"
          aria-label="Reading font"
          style:top={menuPos ? `${menuPos.top}px` : undefined}
          style:left={menuPos ? `${menuPos.left}px` : undefined}
          style:max-height={menuPos ? `${menuPos.maxHeight}px` : undefined}
        >
          {#each fontOptions as option}
            <button
              class="font-menu-item"
              class:active={preferences.articleFont === option.value}
              role="option"
              aria-selected={preferences.articleFont === option.value}
              onclick={() => selectFont(option.value)}
            >
              <span class="specimen" style:font-family={option.family}>Ag</span>
              <span class="labels">
                <span class="name" style:font-family={option.family}>{option.name}</span>
                <span class="hint">{option.hint}</span>
              </span>
              {#if preferences.articleFont === option.value}
                <span class="check"><Icon name="check" size={16} /></span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <span class="toolbar-divider"></span>

  <!-- Font Size -->
  <div class="toolbar-group">
    <span class="group-label">Size</span>
    <div class="size-controls" role="group" aria-label="Font size">
      <button
        class="size-btn"
        onclick={() => preferences.decreaseFontSize()}
        disabled={preferences.articleFontSize <= ARTICLE_FONT_SIZE_MIN}
        title="Decrease font size"
        aria-label="Decrease font size"
      >
        <Icon name="minus" size={14} />
      </button>
      <span class="size-value" title="Font size: {preferences.articleFontSize}px"
        >{preferences.articleFontSize}</span
      >
      <button
        class="size-btn"
        onclick={() => preferences.increaseFontSize()}
        disabled={preferences.articleFontSize >= ARTICLE_FONT_SIZE_MAX}
        title="Increase font size"
        aria-label="Increase font size"
      >
        <Icon name="plus" size={14} />
      </button>
    </div>
  </div>
</div>

<style>
  .appearance-toolbar {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    padding: 0.25rem;
    background: rgba(255, 255, 255, 0.85);
    backdrop-filter: blur(8px);
    border-radius: 999px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    pointer-events: auto;
  }

  .toolbar-group {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .group-label {
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wide);
    padding-left: 0.375rem;
    white-space: nowrap;
  }

  .toolbar-divider {
    width: 1px;
    height: 1rem;
    background: var(--color-border, #e0e0e0);
    margin: 0 0.25rem;
    opacity: 0.5;
  }

  /* ── Font dropdown ─────────────────────────────────────────── */
  .font-dropdown {
    position: relative;
    display: inline-flex;
  }

  .font-trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    background: var(--color-bg-secondary, #f5f5f5);
    border: none;
    padding: 0.3rem 0.4rem 0.3rem 0.7rem;
    border-radius: 999px;
    cursor: pointer;
    color: var(--color-text);
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }

  .font-trigger:hover,
  .font-trigger.open {
    background: var(--color-border, #e5e5e5);
  }

  .trigger-name {
    font-size: var(--text-md);
    line-height: var(--leading-none);
    white-space: nowrap;
    /* Pin every family to the system sans x-height so the trigger keeps a
       steady width and the label doesn't tower for Literata. */
    font-size-adjust: 0.52;
  }

  .font-trigger :global(svg) {
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }

  .font-menu {
    /* Fixed + JS-placed so it can't be clipped by an overflow ancestor and
       always lands inside the viewport (see positionMenu). Hidden until the
       first measurement to avoid a below→above flip flash. */
    position: fixed;
    top: 0;
    left: 0;
    width: max-content;
    min-width: 200px;
    max-width: calc(100vw - 16px);
    padding: 0.25rem;
    background: var(--color-bg, #fff);
    border: 1px solid var(--color-border, #e0e0e0);
    border-radius: 12px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
    overflow-y: auto;
    overscroll-behavior: contain;
    z-index: 10000;
    visibility: hidden;
  }

  .font-menu.positioned {
    visibility: visible;
  }

  .font-menu-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.5rem 0.6rem;
    border: none;
    background: transparent;
    border-radius: 8px;
    cursor: pointer;
    text-align: left;
    color: var(--color-text);
    transition: background-color 0.12s ease;
  }

  .font-menu-item:hover {
    background: var(--color-bg-secondary, #f5f5f5);
  }

  .specimen {
    display: flex;
    align-items: baseline;
    justify-content: center;
    width: 2rem;
    flex-shrink: 0;
    font-size: 1.375rem;
    line-height: var(--leading-none);
    color: var(--color-text);
    font-size-adjust: 0.52;
  }

  .labels {
    display: flex;
    flex-direction: column;
    gap: 0.05rem;
    flex: 1;
    min-width: 0;
  }

  .name {
    font-size: var(--text-md);
    line-height: var(--leading-tight);
    color: var(--color-text);
  }

  .hint {
    font-size: var(--text-2xs);
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wide);
  }

  .check {
    display: flex;
    align-items: center;
    color: var(--color-primary, #0066cc);
    flex-shrink: 0;
  }

  .font-menu-item.active .name {
    font-weight: var(--weight-semibold);
  }

  /* ── Size stepper ──────────────────────────────────────────── */
  .size-controls {
    display: flex;
    align-items: center;
    gap: 0.125rem;
  }

  .size-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    padding: 0.3rem;
    border-radius: 999px;
    cursor: pointer;
    color: var(--color-text-secondary);
    transition: all 0.2s ease;
  }

  .size-btn:hover:not(:disabled) {
    color: var(--color-text);
    background: var(--color-bg-secondary, #f5f5f5);
  }

  .size-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .size-value {
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    color: var(--color-text);
    min-width: 1.5rem;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }

  /* Tablet: hide labels */
  @media (max-width: 900px) {
    .group-label {
      display: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .font-trigger,
    .font-menu-item,
    .size-btn {
      transition: none;
    }
  }

  @media (prefers-color-scheme: dark) {
    .appearance-toolbar {
      background: rgba(40, 40, 40, 0.95);
    }

    .toolbar-divider {
      background: rgba(255, 255, 255, 0.2);
    }

    .font-trigger {
      background: rgba(255, 255, 255, 0.1);
    }

    .font-trigger:hover,
    .font-trigger.open {
      background: rgba(255, 255, 255, 0.18);
    }

    .font-menu {
      background: var(--color-bg-secondary, #2a2a2a);
      border-color: var(--color-border, #404040);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    }

    .font-menu-item:hover {
      background: rgba(255, 255, 255, 0.08);
    }

    .size-btn:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.1);
    }
  }
</style>
