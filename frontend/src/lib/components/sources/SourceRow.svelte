<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';
  import PopoverMenu from '$lib/components/PopoverMenu.svelte';

  interface Props {
    iconUrl: string | null;
    iconRound?: boolean;
    title: string;
    subtitle: string;
    sourceLabel: string;
    pillClass: string;
    unreadCount?: number;
    hasError?: boolean;
    subscribed?: boolean;
    selected?: boolean;
    fallbackIcon?: string;
    onToggleSelect?: () => void;
    onEdit?: (() => void) | null;
    onRefresh?: (() => void) | null;
    onRemove?: (() => void) | null;
    onSubscribe?: (() => void) | null;
  }

  let {
    iconUrl,
    iconRound = false,
    title,
    subtitle,
    sourceLabel,
    pillClass,
    unreadCount = 0,
    hasError = false,
    subscribed = true,
    selected = false,
    fallbackIcon = 'rss',
    onToggleSelect,
    onEdit = null,
    onRefresh = null,
    onRemove = null,
    onSubscribe = null,
  }: Props = $props();

  let menuItems = $derived.by(() => {
    const items: {
      label: string;
      icon?: string;
      variant?: 'default' | 'danger';
      onclick: () => void;
    }[] = [];
    if (onSubscribe) items.push({ label: 'Subscribe', icon: 'plus', onclick: onSubscribe });
    if (onEdit) items.push({ label: 'Edit', icon: 'edit', onclick: onEdit });
    if (onRefresh) items.push({ label: 'Refresh', icon: 'refresh-cw', onclick: onRefresh });
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
  {:else if !subscribed}
    <div class="checkbox-spacer"></div>
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

  <span class="source-type-pill {pillClass}">{sourceLabel}</span>

  {#if subscribed && hasError}
    <span class="error-badge" title="Feed error">
      <Icon name="alert-triangle" size={14} />
    </span>
  {/if}

  {#if subscribed && unreadCount > 0}
    <span class="unread-badge">{unreadCount}</span>
  {/if}

  {#if menuItems.length > 0}
    <div class="source-actions">
      <PopoverMenu items={menuItems} />
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

  .checkbox-spacer {
    width: 16px;
    flex-shrink: 0;
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
    font-size: 0.875rem;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .source-meta {
    font-size: 0.75rem;
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .source-type-pill {
    flex-shrink: 0;
    font-size: 0.6875rem;
    font-weight: 500;
    padding: 0.0625rem 0.375rem;
    border-radius: 4px;
    white-space: nowrap;
  }

  .pill-rss {
    color: var(--color-text-secondary);
    background: var(--color-bg-secondary, rgba(0, 0, 0, 0.04));
  }

  .pill-shares {
    color: #16a34a;
    background: rgba(22, 163, 74, 0.1);
  }

  .pill-documents {
    color: #7c3aed;
    background: rgba(124, 58, 237, 0.1);
  }

  .pill-publication {
    color: #ea580c;
    background: rgba(234, 88, 12, 0.1);
  }

  .pill-collection {
    color: var(--color-text-secondary);
    background: var(--color-bg-secondary, rgba(0, 0, 0, 0.04));
  }

  .unread-badge {
    flex-shrink: 0;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--color-primary);
    background: rgba(0, 102, 204, 0.1);
    padding: 0.125rem 0.375rem;
    border-radius: 10px;
  }

  .error-badge {
    flex-shrink: 0;
    color: var(--color-error, #dc2626);
    display: flex;
    align-items: center;
  }

  .source-actions {
    flex-shrink: 0;
    opacity: 0;
    transition: opacity 0.15s;
  }

  .source-row:hover .source-actions {
    opacity: 1;
  }

  @media (max-width: 640px) {
    .source-actions {
      opacity: 1;
    }

    .source-type-pill {
      display: none;
    }
  }

  @media (prefers-color-scheme: dark) {
    .source-row:hover {
      background: var(--color-bg-hover, rgba(255, 255, 255, 0.03));
    }
  }
</style>
