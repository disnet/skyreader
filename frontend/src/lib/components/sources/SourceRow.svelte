<script module lang="ts">
  export interface RowAction {
    label: string;
    icon?: string;
    onclick: () => void;
  }
</script>

<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';
  import FeedErrorPopover from '$lib/components/sidebar/FeedErrorPopover.svelte';
  import type { ErrorDetails } from '$lib/stores/feedStatus.svelte';
  import { safeHref } from '$lib/utils/sanitize';

  interface Props {
    iconUrl: string | null;
    iconRound?: boolean;
    title: string;
    subtitle: string;
    /** Opens the source's own site in a new tab from the title. */
    href?: string | null;
    /** A second, quieter line (a publication's blurb). */
    description?: string | null;
    hasError?: boolean;
    errorDetails?: ErrorDetails | null;
    subscribed?: boolean;
    selected?: boolean;
    fallbackIcon?: string;
    onToggleSelect?: () => void;
    onEdit?: (() => void) | null;
    onRefresh?: (() => void) | null;
    onRemove?: (() => void) | null;
    onSubscribe?: (() => void) | null;
    onPark?: (() => void) | null;
    onReactivate?: (() => void) | null;
    /** Hide the source's owner from discovery. */
    onHide?: (() => void) | null;
    /** A labeled action other than Add/Reactivate (e.g. Unhide). */
    action?: RowAction | null;
    /** Already in the library: a quiet check stands where Add would be. */
    added?: boolean;
    /** An Add/Reactivate is in flight: the labeled button shows a spinner. */
    pending?: boolean;
  }

  let {
    iconUrl,
    iconRound = false,
    title,
    subtitle,
    href = null,
    description = null,
    hasError = false,
    errorDetails = null,
    subscribed = true,
    selected = false,
    fallbackIcon = 'rss',
    onToggleSelect,
    onEdit = null,
    onRefresh = null,
    onRemove = null,
    onSubscribe = null,
    onPark = null,
    onReactivate = null,
    onHide = null,
    action = null,
    added = false,
    pending = false,
  }: Props = $props();

  // A favicon that 404s falls back to the source-type glyph instead of a
  // broken-image box. Reset when the row is reused for another source.
  let iconFailed = $state(false);
  $effect(() => {
    void iconUrl;
    iconFailed = false;
  });

  const errorPopoverId = $props.id();

  let showErrorPopover = $state(false);
  let errorBadge: HTMLButtonElement | null = $state(null);
  let errorRegion: HTMLDivElement | null = $state(null);
  let popoverPosition = $state({ top: 0, left: 0 });
  let hideTimeout: ReturnType<typeof setTimeout> | null = null;

  function cancelHide() {
    if (hideTimeout) {
      clearTimeout(hideTimeout);
      hideTimeout = null;
    }
  }

  function showErrorDetails() {
    if (!errorDetails) return;
    cancelHide();
    if (errorBadge) {
      const rect = errorBadge.getBoundingClientRect();
      popoverPosition = {
        top: rect.bottom + 4,
        left: Math.min(rect.left, window.innerWidth - 292),
      };
    }
    showErrorPopover = true;
  }

  function hideErrorDetails() {
    cancelHide();
    hideTimeout = setTimeout(() => {
      hideTimeout = null;
      showErrorPopover = false;
    }, 150);
  }

  function hideErrorDetailsNow() {
    cancelHide();
    showErrorPopover = false;
  }

  $effect(() => cancelHide);

  // The badge and the popover are one focus region: keep the popover open while
  // focus moves between them so keyboard users can reach the technical details.
  let suppressFocusOpen = false;

  function handleRegionFocusIn() {
    if (suppressFocusOpen) return;
    showErrorDetails();
  }

  function handleRegionFocusOut(event: FocusEvent) {
    const next = event.relatedTarget;
    if (next instanceof Node) {
      if (errorRegion?.contains(next)) return;
      hideErrorDetailsNow();
      return;
    }
    // Some browsers omit relatedTarget; fall back to the delayed hide so a
    // focusin landing inside the region can still cancel it.
    hideErrorDetails();
  }

  function handleRegionKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !showErrorPopover) return;
    event.stopPropagation();
    hideErrorDetailsNow();
    if (errorBadge && document.activeElement !== errorBadge) {
      // Returning focus to the badge must not immediately reopen the popover.
      suppressFocusOpen = true;
      errorBadge.focus();
      suppressFocusOpen = false;
    }
  }

  // The one action a suggested or parked row exists for gets words and stays
  // visible; everything else is a quiet icon that surfaces on hover.
  let primary = $derived<RowAction | null>(
    action ??
      (onSubscribe
        ? { label: 'Add', icon: 'plus', onclick: onSubscribe }
        : onReactivate
          ? { label: 'Reactivate', icon: 'inbox', onclick: onReactivate }
          : null)
  );

  // Phones get one overflow button instead of a row of icons: four glyphs on
  // every row crowded the titles and read as noise.
  let menuOpen = $state(false);
  let menuPos = $state({ top: 0, right: 0 });
  let moreBtn: HTMLButtonElement | null = $state(null);
  let menuEl: HTMLDivElement | null = $state(null);

  function toggleMenu() {
    if (!menuOpen && moreBtn) {
      const rect = moreBtn.getBoundingClientRect();
      const below = rect.bottom + 4;
      // Open upward when there isn't room under the button.
      menuPos = {
        top: below + 200 > window.innerHeight ? Math.max(8, rect.top - 4 - 200) : below,
        right: window.innerWidth - rect.right,
      };
    }
    menuOpen = !menuOpen;
  }

  function pick(action: () => void) {
    menuOpen = false;
    action();
  }

  $effect(() => {
    if (!menuOpen) return;
    function onPointer(e: PointerEvent) {
      const t = e.target as Node;
      if (menuEl?.contains(t) || moreBtn?.contains(t)) return;
      menuOpen = false;
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      menuOpen = false;
      moreBtn?.focus();
    }
    function onScroll() {
      menuOpen = false;
    }
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  });

  let actions = $derived.by(() => {
    const items: {
      label: string;
      icon: string;
      variant?: 'default' | 'danger';
      onclick: () => void;
    }[] = [];
    if (onEdit) items.push({ label: 'Edit', icon: 'edit', onclick: onEdit });
    if (onRefresh) items.push({ label: 'Refresh', icon: 'refresh-cw', onclick: onRefresh });
    if (onPark) items.push({ label: 'Park', icon: 'archive', onclick: onPark });
    if (onHide) items.push({ label: 'Hide account', icon: 'x', onclick: onHide });
    if (onRemove)
      items.push({
        label: 'Remove',
        icon: 'trash',
        variant: 'danger',
        onclick: onRemove,
      });
    return items;
  });
</script>

<div class="source-row" class:inactive={!subscribed && !onSubscribe}>
  {#if subscribed && onToggleSelect}
    <label class="row-checkbox">
      <input type="checkbox" checked={selected} onchange={onToggleSelect} />
    </label>
  {/if}

  <div class="source-icon" class:round={iconRound}>
    {#if iconUrl && !iconFailed}
      <img
        src={iconUrl}
        alt=""
        class="icon-img"
        class:round={iconRound}
        loading="lazy"
        onerror={() => (iconFailed = true)}
      />
    {:else}
      <Icon name={fallbackIcon as any} size={16} />
    {/if}
  </div>

  <div class="source-info">
    {#if href && safeHref(href)}
      <a class="source-title" href={safeHref(href)} target="_blank" rel="noopener">{title}</a>
    {:else}
      <span class="source-title">{title}</span>
    {/if}
    {#if description}
      <span class="source-desc">{description}</span>
    {/if}
    <span class="source-meta">{subtitle}</span>
  </div>

  {#if subscribed && (hasError || errorDetails)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      bind:this={errorRegion}
      class="error-region"
      onmouseenter={showErrorDetails}
      onmouseleave={hideErrorDetails}
      onfocusin={handleRegionFocusIn}
      onfocusout={handleRegionFocusOut}
      onkeydown={handleRegionKeydown}
    >
      <button
        bind:this={errorBadge}
        type="button"
        class="error-badge"
        class:permanent={errorDetails?.isPermanent}
        title={errorDetails?.title ?? 'Feed error'}
        aria-label={errorDetails ? `Feed error: ${errorDetails.title}` : 'Feed error'}
        aria-expanded={errorDetails ? showErrorPopover : undefined}
        aria-controls={errorDetails && showErrorPopover ? errorPopoverId : undefined}
        onclick={showErrorDetails}
      >
        <Icon name="alert-triangle" size={14} />
      </button>

      {#if showErrorPopover && errorDetails}
        <div
          id={errorPopoverId}
          class="error-popover-container"
          style="top: {popoverPosition.top}px; left: {popoverPosition.left}px;"
        >
          <FeedErrorPopover {errorDetails} />
        </div>
      {/if}
    </div>
  {/if}

  {#if actions.length > 0}
    <div class="source-actions">
      {#each actions as item (item.label)}
        <button
          class="action-btn"
          class:danger={item.variant === 'danger'}
          title={item.label}
          aria-label={item.label}
          onclick={item.onclick}
        >
          <Icon name={item.icon as any} size={16} />
        </button>
      {/each}
    </div>

    <button
      bind:this={moreBtn}
      class="action-btn more-btn"
      aria-label="More actions for {title}"
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      onclick={toggleMenu}
    >
      <Icon name="more-horizontal" size={18} />
    </button>

    {#if menuOpen}
      <div
        bind:this={menuEl}
        class="row-menu"
        role="menu"
        style="top: {menuPos.top}px; right: {menuPos.right}px;"
      >
        {#each actions as item (item.label)}
          <button
            class="row-menu-item"
            class:danger={item.variant === 'danger'}
            role="menuitem"
            onclick={() => pick(item.onclick)}
          >
            <Icon name={item.icon as any} size={16} />
            {item.label}
          </button>
        {/each}
      </div>
    {/if}
  {/if}
  {#if added}
    <span class="added"><Icon name="check" size={14} /> Added</span>
  {:else if primary}
    <button class="primary-btn" disabled={pending} onclick={primary.onclick}>
      {#if pending}
        <span class="spinner"></span>
      {:else}
        {#if primary.icon}<Icon name={primary.icon as any} size={14} />{/if}
      {/if}
      {primary.label}
    </button>
  {/if}
</div>

<style>
  .source-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem 0.75rem;
    background: var(--color-bg);
    transition: background-color 0.15s;
  }

  .source-row:hover {
    background: var(--color-bg-hover, rgba(0, 0, 0, 0.02));
  }

  /* Parked: kept, not fetched. The title steps back; the row stays legible. */
  .source-row.inactive .source-title {
    color: var(--color-text-secondary);
  }

  .source-row.inactive .source-icon {
    opacity: 0.6;
  }

  .row-checkbox {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    cursor: pointer;
  }

  .row-checkbox input {
    cursor: pointer;
  }

  .source-icon {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-secondary);
  }

  .icon-img {
    width: 20px;
    height: 20px;
    border-radius: 4px;
    object-fit: cover;
  }

  /* Avatars read as people: a touch larger than a favicon. */
  .icon-img.round {
    width: 28px;
    height: 28px;
    border-radius: 50%;
  }

  .primary-btn {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.3125rem 0.625rem;
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-primary);
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 6px);
    cursor: pointer;
    transition: border-color 0.15s;
  }

  .primary-btn:hover:not(:disabled) {
    border-color: var(--color-primary);
  }

  .primary-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .primary-btn:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  .spinner {
    width: 12px;
    height: 12px;
    border: 2px solid var(--color-border);
    border-top-color: var(--color-primary);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .source-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .source-title {
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  a.source-title {
    color: inherit;
    text-decoration: none;
  }

  a.source-title:hover {
    text-decoration: underline;
  }

  .source-desc {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .added {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.3125rem 0.25rem;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-text-secondary);
  }

  .source-meta {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .error-region {
    flex-shrink: 0;
    display: flex;
    align-items: center;
  }

  .error-badge {
    flex-shrink: 0;
    color: var(--color-error, #dc2626);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.25rem;
    border: 0;
    background: transparent;
    border-radius: 4px;
    cursor: help;
  }

  .error-badge:not(.permanent) {
    color: var(--color-warning, #ff9800);
  }

  .error-badge:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  .error-popover-container {
    position: fixed;
    z-index: 1000;
  }

  .source-actions {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 0.125rem;
    opacity: 0;
    transition: opacity 0.15s;
  }

  .source-row:hover .source-actions,
  .source-row:focus-within .source-actions {
    opacity: 1;
  }

  .action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    padding: 0;
    border: none;
    background: transparent;
    border-radius: 6px;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition:
      background-color 0.15s,
      color 0.15s;
  }

  .action-btn:hover {
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }

  .action-btn.danger:hover {
    background: rgba(244, 67, 54, 0.1);
    color: var(--color-error);
  }

  .more-btn {
    display: none;
  }

  @media (max-width: 640px) {
    .source-actions {
      display: none;
    }

    .more-btn {
      display: flex;
    }
  }

  /* Floats over the list, so it's the one element here that gets a shadow. */
  .row-menu {
    position: fixed;
    z-index: 1000;
    min-width: 168px;
    padding: 0.25rem;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg, 8px);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  }

  .row-menu-item {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    width: 100%;
    padding: 0.625rem 0.75rem;
    font: inherit;
    font-size: var(--text-md);
    color: var(--color-text);
    text-align: left;
    background: none;
    border: none;
    border-radius: var(--radius-md, 6px);
    cursor: pointer;
  }

  .row-menu-item > :global(svg) {
    color: var(--color-text-secondary);
  }

  .row-menu-item:hover,
  .row-menu-item:focus-visible {
    background: var(--color-bg-secondary);
    outline: none;
  }

  .row-menu-item.danger,
  .row-menu-item.danger > :global(svg) {
    color: var(--color-error);
  }

  @media (prefers-color-scheme: dark) {
    .source-row:hover {
      background: var(--color-bg-hover, rgba(255, 255, 255, 0.03));
    }
  }
</style>
