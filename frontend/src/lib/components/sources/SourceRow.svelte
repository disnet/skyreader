<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';

  interface Props {
    iconUrl: string | null;
    iconRound?: boolean;
    title: string;
    subtitle: string;
    hasError?: boolean;
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

  {#if subscribed && hasError}
    <span class="error-badge" title="Feed error">
      <Icon name="alert-triangle" size={14} />
    </span>
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

  .error-badge {
    flex-shrink: 0;
    color: var(--color-error, #dc2626);
    display: flex;
    align-items: center;
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
