<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ComponentProps } from 'svelte';
  import Icon from '../Icon.svelte';

  interface Props {
    title: string;
    icon: ComponentProps<typeof Icon>['name'];
    isExpanded: boolean;
    showOnlyUnread: boolean;
    isActive: boolean;
    onAdd?: () => void;
    onToggle: () => void;
    onLabelClick: () => void;
    onUnreadToggle: () => void;
    children: Snippet;
  }

  let {
    title,
    icon,
    isExpanded,
    showOnlyUnread,
    isActive,
    onAdd,
    onToggle,
    onLabelClick,
    onUnreadToggle,
    children,
  }: Props = $props();
</script>

<div class="nav-section" class:expanded={isExpanded}>
  <div class="section-header" class:active={isActive}>
    <button class="header-btn" onclick={onLabelClick}>
      <span class="nav-icon"><Icon name={icon} /></span>
      <span class="nav-label">{title}</span>
    </button>
    <div class="header-actions">
      {#if onAdd}
        <button
          class="add-btn"
          onclick={(e) => {
            e.stopPropagation();
            onAdd();
          }}
          title="Add"
        >
          <Icon name="plus" size={14} strokeWidth={2} />
        </button>
      {/if}
      <button
        class="filter-toggle"
        class:active={showOnlyUnread}
        onclick={(e) => {
          e.stopPropagation();
          onUnreadToggle();
        }}
        title={showOnlyUnread ? 'Show all' : 'Show only unread'}
      >
        <Icon name={showOnlyUnread ? 'circle-dot' : 'circle'} size={12} strokeWidth={2} />
      </button>
      <button class="disclosure-btn" onclick={onToggle} aria-label="Toggle section">
        <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size={14} strokeWidth={2.5} />
      </button>
    </div>
  </div>
  {#if isExpanded}
    <div class="section-items">
      {@render children()}
    </div>
  {/if}
</div>

<style>
  .nav-section {
    margin-top: 0;
    border-radius: 12px;
    transition: background-color 0.15s;
  }

  .nav-section.expanded {
    background-color: rgba(0, 0, 0, 0.025);
    padding-bottom: 0.25rem;
  }

  .section-header {
    display: flex;
    align-items: center;
    width: 100%;
    padding: 0.5rem 0.75rem;
    border-radius: 12px;
    color: var(--color-text);
    transition: background-color 0.15s;
  }

  .section-header:hover {
    background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
  }

  .section-header.active {
    background-color: var(--color-sidebar-active, rgba(0, 102, 204, 0.1));
    color: var(--color-primary);
  }

  .header-btn {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex: 1;
    min-width: 0;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    font: inherit;
    color: inherit;
    padding: 0;
  }

  .nav-icon {
    flex-shrink: 0;
    width: 1.25rem;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .nav-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.875rem;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
  }

  .add-btn {
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.125rem;
    color: var(--color-text-secondary);
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition: opacity 0.15s;
    border-radius: 4px;
  }

  .section-header:hover .add-btn {
    opacity: 0.6;
  }

  .add-btn:hover {
    opacity: 1 !important;
    color: var(--color-primary);
  }

  .disclosure-btn {
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.125rem;
    color: var(--color-text-secondary);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .disclosure-btn:hover {
    color: var(--color-text);
  }

  .section-header.active .disclosure-btn {
    color: var(--color-primary);
  }

  .filter-toggle {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text-secondary);
    padding: 0.125rem;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition: opacity 0.15s;
  }

  .section-header:hover .filter-toggle {
    opacity: 0.6;
  }

  .filter-toggle:hover {
    opacity: 1 !important;
  }

  .filter-toggle.active {
    color: var(--color-primary);
    opacity: 1;
  }

  .section-items {
    margin-top: 0.25rem;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  @media (prefers-color-scheme: dark) {
    .section-header:hover {
      background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
    }

    .nav-section.expanded {
      background-color: rgba(255, 255, 255, 0.025);
    }
  }
</style>
