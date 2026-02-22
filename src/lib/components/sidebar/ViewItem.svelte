<script lang="ts">
  import { tick } from 'svelte';
  import type { FilteredView } from '$lib/types';
  import Icon from '../Icon.svelte';

  interface Props {
    view: FilteredView;
    isActive: boolean;
    isRenaming: boolean;
    onSelect: () => void;
    onContextMenu: (e: MouseEvent) => void;
    onTouchStart: (e: TouchEvent) => void;
    onTouchEnd: (e: TouchEvent) => void;
    onTouchMove: () => void;
    onMoreClick: (e: MouseEvent) => void;
    onRename: (name: string) => void;
    onRenameCancel: () => void;
  }

  let {
    view,
    isActive,
    isRenaming,
    onSelect,
    onContextMenu,
    onTouchStart,
    onTouchEnd,
    onTouchMove,
    onMoreClick,
    onRename,
    onRenameCancel,
  }: Props = $props();

  let inputRef: HTMLInputElement | null = $state(null);
  let renameValue = $state('');

  $effect(() => {
    if (isRenaming) {
      renameValue = view.name;
      tick().then(() => {
        inputRef?.focus();
        inputRef?.select();
      });
    }
  });

  function commitRename() {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== view.name) {
      onRename(trimmed);
    } else {
      onRenameCancel();
    }
  }
</script>

<button
  class="nav-item view-item"
  class:active={isActive}
  onclick={isRenaming ? undefined : onSelect}
  oncontextmenu={onContextMenu}
  ontouchstart={onTouchStart}
  ontouchend={onTouchEnd}
  ontouchmove={onTouchMove}
>
  <span class="view-icon"><Icon name="filter" size={14} /></span>
  {#if isRenaming}
    <!-- svelte-ignore a11y_autofocus -->
    <input
      bind:this={inputRef}
      bind:value={renameValue}
      class="rename-input"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitRename();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onRenameCancel();
        }
      }}
      onblur={commitRename}
    />
  {:else}
    <span class="nav-label">{view.name}</span>
    <span
      class="more-btn"
      role="button"
      tabindex="0"
      onclick={(e) => {
        e.stopPropagation();
        onMoreClick(e);
      }}
      onkeydown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          onMoreClick(e as unknown as MouseEvent);
        }
      }}
      title="More options"
    >
      <Icon name="more-horizontal" size={14} />
    </span>
  {/if}
</button>

<style>
  .nav-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.5rem 0.75rem;
    background: none;
    border: none;
    border-radius: 12px;
    cursor: pointer;
    text-align: left;
    font: inherit;
    color: var(--color-text);
    transition: background-color 0.15s;
  }

  .nav-item:hover {
    background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
  }

  .nav-item.active {
    background-color: var(--color-sidebar-active, rgba(0, 102, 204, 0.1));
    color: var(--color-primary);
  }

  .view-icon {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    color: var(--color-text-secondary);
  }

  .nav-item.active .view-icon {
    color: var(--color-primary);
  }

  .nav-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.875rem;
  }

  .view-item {
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
  }

  .more-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text-secondary);
    font-size: 1rem;
    padding: 0;
    line-height: 1;
    opacity: 0;
    transition: opacity 0.15s;
    flex-shrink: 0;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }

  .view-item:hover .more-btn,
  .more-btn:focus {
    opacity: 1;
  }

  .more-btn:hover {
    color: var(--color-text);
    background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.1));
    border-radius: 4px;
  }

  .rename-input {
    flex: 1;
    min-width: 0;
    font: inherit;
    font-size: 0.875rem;
    padding: 0.125rem 0.25rem;
    border: 1px solid var(--color-primary);
    border-radius: 4px;
    background: var(--color-bg);
    color: var(--color-text);
    outline: none;
  }

  @media (prefers-color-scheme: dark) {
    .nav-item:hover {
      background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
    }
  }
</style>
