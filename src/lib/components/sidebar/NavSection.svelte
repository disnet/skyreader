<script lang="ts">
    import type { Snippet } from 'svelte';

    interface Props {
        title: string;
        isExpanded: boolean;
        isCollapsed: boolean;
        showOnlyUnread: boolean;
        isActive: boolean;
        onToggle: () => void;
        onLabelClick: () => void;
        onUnreadToggle: () => void;
        children: Snippet;
    }

    let {
        title,
        isExpanded,
        isCollapsed,
        showOnlyUnread,
        isActive,
        onToggle,
        onLabelClick,
        onUnreadToggle,
        children,
    }: Props = $props();
</script>

<div class="nav-section">
    <div class="section-header" class:active={isActive}>
        <button
            class="disclosure-btn"
            onclick={onToggle}
            aria-label="Toggle section"
        >
            <span class="disclosure">{isExpanded ? '▼' : '▶'}</span>
        </button>
        {#if !isCollapsed}
            <button
                class="section-label-btn"
                class:active={isActive}
                onclick={onLabelClick}
            >
                {title}
            </button>
            <button
                class="filter-toggle"
                class:active={showOnlyUnread}
                onclick={(e) => {
                    e.stopPropagation();
                    onUnreadToggle();
                }}
                title={showOnlyUnread ? 'Show all' : 'Show only unread'}
            >
                {showOnlyUnread ? '●' : '○'}
            </button>
        {/if}
    </div>
    {#if isExpanded && !isCollapsed}
        <div class="section-items">
            {@render children()}
        </div>
    {/if}
</div>

<style>
    .nav-section {
        margin-top: 0.5rem;
    }

    .section-header {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        padding: 0.5rem 0.75rem;
        color: var(--color-text-secondary);
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }

    .section-header:hover {
        background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
    }

    .section-header.active {
        background-color: var(--color-sidebar-active, rgba(0, 102, 204, 0.1));
    }

    .disclosure-btn {
        background: none;
        border: none;
        cursor: pointer;
        padding: 0;
        color: inherit;
        font-size: inherit;
        line-height: 1;
    }

    .disclosure-btn:hover {
        color: var(--color-text);
    }

    .disclosure {
        font-size: 0.625rem;
        flex-shrink: 0;
    }

    .section-label-btn {
        flex: 1;
        background: none;
        border: none;
        cursor: pointer;
        text-align: left;
        font: inherit;
        color: inherit;
        font-size: inherit;
        text-transform: inherit;
        letter-spacing: inherit;
        padding: 0;
    }

    .section-label-btn:hover {
        color: var(--color-text);
    }

    .section-label-btn.active {
        color: var(--color-primary);
    }

    .filter-toggle {
        background: none;
        border: none;
        cursor: pointer;
        font-size: 0.75rem;
        color: var(--color-text-secondary);
        padding: 0 0.25rem;
        line-height: 1;
        opacity: 0.6;
    }

    .filter-toggle:hover {
        opacity: 1;
    }

    .filter-toggle.active {
        color: var(--color-primary);
        opacity: 1;
    }

    .section-items {
        margin-top: 0.25rem;
    }
</style>
