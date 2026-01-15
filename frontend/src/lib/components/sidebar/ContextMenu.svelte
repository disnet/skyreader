<script lang="ts">
    interface Props {
        x: number;
        y: number;
        onDelete: () => void;
        onClose: () => void;
    }

    let { x, y, onDelete, onClose }: Props = $props();

    function handleDelete() {
        onDelete();
        onClose();
    }
</script>

<div
    class="context-menu"
    style="left: {x}px; top: {y}px;"
    role="menu"
>
    <button
        class="context-menu-item danger"
        onclick={handleDelete}
        role="menuitem"
    >
        <span class="context-menu-icon">🗑</span>
        Delete
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
        font-size: 0.875rem;
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
        font-size: 1rem;
    }
</style>
