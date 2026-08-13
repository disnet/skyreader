<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';
  import FeedErrorPopover from '$lib/components/sidebar/FeedErrorPopover.svelte';
  import type { ErrorDetails } from '$lib/stores/feedStatus.svelte';

  interface Props {
    iconUrl: string | null;
    iconRound?: boolean;
    title: string;
    subtitle: string;
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
  }

  let {
    iconUrl,
    iconRound = false,
    title,
    subtitle,
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
  }: Props = $props();

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

  let actions = $derived.by(() => {
    const items: {
      label: string;
      icon: string;
      variant?: 'default' | 'danger';
      onclick: () => void;
    }[] = [];
    if (onSubscribe) items.push({ label: 'Subscribe', icon: 'plus', onclick: onSubscribe });
    if (onReactivate) items.push({ label: 'Reactivate', icon: 'inbox', onclick: onReactivate });
    if (onEdit) items.push({ label: 'Edit', icon: 'edit', onclick: onEdit });
    if (onRefresh) items.push({ label: 'Refresh', icon: 'refresh-cw', onclick: onRefresh });
    if (onPark) items.push({ label: 'Park', icon: 'archive', onclick: onPark });
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

<div class="source-row" class:unsubscribed={!subscribed}>
  {#if subscribed && onToggleSelect}
    <label class="row-checkbox">
      <input type="checkbox" checked={selected} onchange={onToggleSelect} />
    </label>
  {/if}

  <div class="source-icon" class:round={iconRound}>
    {#if iconUrl}
      <img src={iconUrl} alt="" class="icon-img" class:round={iconRound} />
    {:else}
      <Icon name={fallbackIcon as any} size={16} />
    {/if}
  </div>

  <div class="source-info">
    <span class="source-title">{title}</span>
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

  .source-row.unsubscribed {
    opacity: 0.55;
  }

  .source-row.unsubscribed:hover {
    opacity: 0.8;
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
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-secondary);
  }

  .icon-img {
    width: 20px;
    height: 20px;
    border-radius: 4px;
  }

  .icon-img.round {
    border-radius: 50%;
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

  .source-row:hover .source-actions {
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

  @media (max-width: 640px) {
    .source-actions {
      opacity: 1;
    }
  }

  @media (prefers-color-scheme: dark) {
    .source-row:hover {
      background: var(--color-bg-hover, rgba(255, 255, 255, 0.03));
    }
  }
</style>
