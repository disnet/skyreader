<script lang="ts">
  import { tick } from 'svelte';
  import Icon from '../Icon.svelte';

  interface Props {
    x: number;
    y: number;
    onEdit?: () => void;
    onRename?: () => void;
    onDelete: () => void;
    onClose: () => void;
    deleteLabel?: string;
  }

  let { x, y, onEdit, onRename, onDelete, onClose, deleteLabel = 'Delete' }: Props = $props();

  let menuRef: HTMLDivElement | null = $state(null);
  let adjustedX = $state(0);
  let adjustedY = $state(0);

  $effect(() => {
    // Track x and y as dependencies
    const targetX = x;
    const targetY = y;

    tick().then(() => {
      if (menuRef) {
        const rect = menuRef.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const padding = 8;

        let newX = targetX;
        let newY = targetY;

        // Adjust horizontal position if menu would overflow right edge
        if (targetX + rect.width > viewportWidth - padding) {
          newX = Math.max(padding, viewportWidth - rect.width - padding);
        }

        // Adjust vertical position if menu would overflow bottom edge
        if (targetY + rect.height > viewportHeight - padding) {
          newY = Math.max(padding, viewportHeight - rect.height - padding);
        }

        adjustedX = newX;
        adjustedY = newY;
      } else {
        adjustedX = targetX;
        adjustedY = targetY;
      }
    });
  });

  function handleEdit() {
    onEdit?.();
    onClose();
  }

  function handleRename() {
    onRename?.();
    onClose();
  }

  function handleDelete() {
    onDelete();
    onClose();
  }
</script>

<div
  bind:this={menuRef}
  class="context-menu"
  style="left: {adjustedX}px; top: {adjustedY}px;"
  role="menu"
>
  {#if onEdit}
    <button class="context-menu-item" onclick={handleEdit} role="menuitem">
      <span class="context-menu-icon"><Icon name="edit" size={16} /></span>
      Edit
    </button>
  {/if}
  {#if onRename}
    <button class="context-menu-item" onclick={handleRename} role="menuitem">
      <span class="context-menu-icon"><Icon name="edit" size={16} /></span>
      Rename
    </button>
  {/if}
  <button class="context-menu-item danger" onclick={handleDelete} role="menuitem">
    <span class="context-menu-icon"><Icon name="trash" size={16} /></span>
    {deleteLabel}
  </button>
</div>

<style>
  .context-menu {
    position: fixed;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    padding: 0.25rem;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    z-index: 1000;
    min-width: 120px;
  }

  .context-menu-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.5rem 0.75rem;
    border: none;
    background: none;
    text-align: left;
    cursor: pointer;
    border-radius: 4px;
    font-size: var(--text-md);
    color: var(--color-text);
  }

  .context-menu-item:hover {
    background: var(--color-bg-secondary);
  }

  .context-menu-item.danger {
    color: var(--color-error, #dc2626);
  }

  .context-menu-item.danger:hover {
    background: rgba(220, 38, 38, 0.1);
  }

  .context-menu-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1rem;
  }
</style>
