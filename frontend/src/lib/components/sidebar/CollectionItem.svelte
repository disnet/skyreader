<script lang="ts">
  // A Shelf collection nested under the sidebar's Library row, beside the
  // Queue's channels. Same row anatomy as ViewItem; a plain link, since a
  // collection is edited on its own Shelf page rather than from the sidebar.
  import Icon from '../Icon.svelte';

  interface Props {
    name: string;
    href: string;
    isActive: boolean;
    onSelect: () => void;
  }

  let { name, href, isActive, onSelect }: Props = $props();
</script>

<a
  {href}
  class="nav-item collection-item"
  class:active={isActive}
  aria-current={isActive ? 'page' : undefined}
  onclick={onSelect}
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
