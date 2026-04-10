<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';

  interface Props {
    avatarUrl: string | null;
    displayName: string;
    handle: string;
    totalUnread: number;
    onRemoveAll: () => void;
  }

  let { avatarUrl, displayName, handle, totalUnread, onRemoveAll }: Props = $props();
</script>

<div class="group-header">
  <div class="header-icon">
    {#if avatarUrl}
      <img src={avatarUrl} alt="" class="avatar" />
    {:else}
      <Icon name="user" size={16} />
    {/if}
  </div>
  <div class="header-info">
    <span class="header-name">{displayName}</span>
    <span class="header-handle">@{handle}</span>
  </div>
  {#if totalUnread > 0}
    <span class="unread-badge">{totalUnread}</span>
  {/if}
  <button class="remove-all-btn" onclick={onRemoveAll} title="Remove all">
    <Icon name="trash" size={14} />
  </button>
</div>

<style>
  .group-header {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.5rem 0.75rem;
    background: var(--color-bg);
    border-bottom: 1px solid var(--color-border, rgba(0, 0, 0, 0.06));
  }

  .header-icon {
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-secondary);
  }

  .avatar {
    width: 24px;
    height: 24px;
    border-radius: 50%;
  }

  .header-info {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 0.375rem;
  }

  .header-name {
    font-size: 0.8125rem;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .header-handle {
    font-size: 0.75rem;
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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

  .remove-all-btn {
    flex-shrink: 0;
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.25rem;
    border-radius: 4px;
    color: var(--color-text-secondary);
    display: flex;
    align-items: center;
    opacity: 0;
    transition: opacity 0.15s;
  }

  .group-header:hover .remove-all-btn {
    opacity: 1;
  }

  .remove-all-btn:hover {
    color: var(--color-error, #dc2626);
    background: var(--color-bg-hover);
  }

  @media (max-width: 640px) {
    .remove-all-btn {
      opacity: 1;
    }
  }
</style>
