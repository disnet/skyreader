<script lang="ts">
  // A Shelf collection nested under the sidebar's Library row, beside the
  // Queue's channels. Same row anatomy as ViewItem; a plain link, since a
  // collection is edited on its own Shelf page rather than from the sidebar.
  // Dragged to reorder like a channel (hooks/useListDrag); on touch a long-press
  // menu moves it, and Alt+↑ / Alt+↓ from the keyboard. Right-click stays the
  // browser's link menu.
  import Icon from '../Icon.svelte';

  interface Props {
    id: string;
    name: string;
    href: string;
    isActive: boolean;
    isLifted?: boolean;
    dragOffset?: number;
    dragEases?: boolean;
    onSelect: () => void;
    onPointerDown?: (e: PointerEvent) => void;
    /** Alt+↑ / Alt+↓: move the row a step. */
    onMoveKey?: (delta: -1 | 1) => void;
    onTouchStart?: (e: TouchEvent) => void;
    onTouchEnd?: (e: TouchEvent) => void;
    onTouchMove?: () => void;
    onTouchCancel?: () => void;
  }

  let {
    id,
    name,
    href,
    isActive,
    isLifted = false,
    dragOffset = 0,
    dragEases = false,
    onSelect,
    onPointerDown,
    onMoveKey,
    onTouchStart,
    onTouchEnd,
    onTouchMove,
    onTouchCancel,
  }: Props = $props();
</script>

<a
  {href}
  class="nav-item collection-item"
  class:active={isActive}
  class:lifted={isLifted}
  class:eases={dragEases}
  style:transform={dragOffset ? `translateY(${dragOffset}px)` : undefined}
  data-collection-id={id}
  draggable="false"
  aria-current={isActive ? 'page' : undefined}
  onclick={onSelect}
  onpointerdown={onPointerDown}
  onkeydown={(e) => {
    if (!e.altKey || !onMoveKey) return;
    const delta = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (!delta) return;
    e.preventDefault();
    onMoveKey(delta);
  }}
  ontouchstart={onTouchStart}
  ontouchend={onTouchEnd}
  ontouchmove={onTouchMove}
  ontouchcancel={onTouchCancel}
>
  <span class="collection-icon"><Icon name="layers" size={14} /></span>
  <span class="nav-label">{name}</span>
</a>

<style>
  .nav-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.5rem 0.75rem;
    border-radius: 12px;
    color: var(--color-text);
    text-decoration: none;
    transition: background-color 0.15s;
  }

  @media (hover: hover) {
    .nav-item:hover {
      background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
    }
  }

  .nav-item.active {
    background-color: var(--color-sidebar-active, rgba(0, 102, 204, 0.1));
    color: var(--color-primary);
  }

  .collection-item {
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
  }

  .collection-icon {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    color: var(--color-text-secondary);
  }

  .nav-item.active .collection-icon {
    color: var(--color-primary);
  }

  .nav-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-md);
  }
</style>
