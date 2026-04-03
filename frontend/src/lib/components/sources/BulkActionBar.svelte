<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';
  import type { FilteredView } from '$lib/types';

  interface Props {
    selectionCount: number;
    channels: FilteredView[];
    onAssignToChannel: (channelId: number) => void;
    onBulkDelete: () => void;
    onClearSelection: () => void;
  }

  let { selectionCount, channels, onAssignToChannel, onBulkDelete, onClearSelection }: Props =
    $props();

  let assignChannelOpen = $state(false);
</script>

<div class="bulk-bar">
  <span class="bulk-count">{selectionCount} selected</span>
  <div class="bulk-actions">
    <div class="assign-wrapper">
      <button class="bulk-btn" onclick={() => (assignChannelOpen = !assignChannelOpen)}>
        <Icon name="filter" size={14} />
        Add to channel
      </button>
      {#if assignChannelOpen && channels.length > 0}
        <div class="assign-dropdown">
          {#each channels as view (view.id)}
            <button
              class="assign-item"
              onclick={() => {
                if (view.id != null) onAssignToChannel(view.id);
                assignChannelOpen = false;
              }}
            >
              {view.name}
            </button>
          {/each}
        </div>
      {/if}
    </div>
    <button class="bulk-btn danger" onclick={onBulkDelete}>
      <Icon name="trash" size={14} />
      Remove
    </button>
  </div>
  <button class="bulk-clear" onclick={onClearSelection}>
    <Icon name="x" size={14} />
  </button>
</div>

<style>
  .bulk-bar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
    background: var(--color-primary);
    color: #fff;
    border-radius: 10px;
    margin-bottom: 1rem;
    font-size: 0.8125rem;
  }

  .bulk-count {
    font-weight: 500;
  }

  .bulk-actions {
    display: flex;
    gap: 0.375rem;
    flex: 1;
  }

  .bulk-btn {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0.5rem;
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 6px;
    background: none;
    color: #fff;
    cursor: pointer;
    font-size: 0.75rem;
  }

  .bulk-btn:hover {
    background: rgba(255, 255, 255, 0.15);
  }

  .bulk-btn.danger:hover {
    background: rgba(220, 38, 38, 0.3);
  }

  .bulk-clear {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.7);
    cursor: pointer;
    padding: 0.25rem;
    display: flex;
    align-items: center;
    border-radius: 4px;
  }

  .bulk-clear:hover {
    color: #fff;
  }

  .assign-wrapper {
    position: relative;
  }

  .assign-dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    margin-top: 0.25rem;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    padding: 0.25rem;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    z-index: 100;
    min-width: 160px;
  }

  .assign-item {
    display: block;
    width: 100%;
    padding: 0.375rem 0.5rem;
    border: none;
    background: none;
    text-align: left;
    cursor: pointer;
    font-size: 0.8125rem;
    color: var(--color-text);
    border-radius: 4px;
  }

  .assign-item:hover {
    background: var(--color-bg-hover);
  }

  @media (prefers-color-scheme: dark) {
    .assign-dropdown {
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }
  }
</style>
