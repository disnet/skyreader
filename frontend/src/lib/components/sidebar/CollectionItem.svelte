<script lang="ts">
  // A Shelf collection nested under the sidebar's Library row, beside the
  // Queue's channels. Same row anatomy as ViewItem; a plain link, since a
  // collection is edited on its own Shelf page rather than from the sidebar.
  // Dragged to reorder like a channel (hooks/useListDrag); its menu (right-click,
  // or a long-press on touch) only moves it.
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
    onContextMenu?: (e: MouseEvent) => void;
    onTouchStart?: (e: TouchEvent) => void;
    onTouchEnd?: (e: TouchEvent) => void;
    onTouchMove?: () => void;
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
    onContextMenu,
    onTouchStart,
    onTouchEnd,
    onTouchMove,
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
  oncontextmenu={onContextMenu}
  ontouchstart={onTouchStart}
  ontouchend={onTouchEnd}
  ontouchmove={onTouchMove}
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

  /* Dragging: as ViewItem. */
  .nav-item.lifted {
    position: relative;
    z-index: 1;
    background-color: var(--color-bg);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
    cursor: grabbing;
  }

  .nav-item.eases {
    transition:
      transform 180ms cubic-bezier(0.2, 0, 0, 1),
      background-color 0.15s;
  }

  @media (prefers-reduced-motion: reduce) {
    .nav-item.eases {
      transition: none;
    }
  }

  @media (prefers-color-scheme: dark) {
    .nav-item.lifted,
    .nav-item.lifted:hover {
      background-color: var(--color-bg-secondary);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    }
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
