<script lang="ts">
    import { onDestroy } from 'svelte';

    interface Props {
        width: number;
        onWidthChange: (width: number) => void;
        onResizeStart?: () => void;
        onResizeEnd?: () => void;
        minWidth?: number;
        maxWidth?: number;
    }

    let {
        width,
        onWidthChange,
        onResizeStart,
        onResizeEnd,
        minWidth = 180,
        maxWidth = 400,
    }: Props = $props();

    let isResizing = $state(false);

    function startResize(e: MouseEvent) {
        e.preventDefault();
        isResizing = true;
        document.body.classList.add('sidebar-resizing');
        document.addEventListener('mousemove', handleResize);
        document.addEventListener('mouseup', stopResize);
        onResizeStart?.();
    }

    function handleResize(e: MouseEvent) {
        if (!isResizing) return;
        const newWidth = Math.min(maxWidth, Math.max(minWidth, e.clientX));
        onWidthChange(newWidth);
    }

    function stopResize() {
        if (isResizing) {
            isResizing = false;
            document.body.classList.remove('sidebar-resizing');
            document.removeEventListener('mousemove', handleResize);
            document.removeEventListener('mouseup', stopResize);
            onResizeEnd?.();
        }
    }

    onDestroy(() => {
        document.removeEventListener('mousemove', handleResize);
        document.removeEventListener('mouseup', stopResize);
    });
</script>

<div
    class="resize-handle"
    class:resizing={isResizing}
    onmousedown={startResize}
    role="separator"
    aria-orientation="vertical"
    tabindex="0"
></div>

<style>
    .resize-handle {
        position: absolute;
        top: 0;
        right: 0;
        width: 4px;
        height: 100%;
        cursor: col-resize;
        background: transparent;
        z-index: 10;
        transition: background-color 0.15s;
    }

    .resize-handle:hover,
    .resize-handle.resizing {
        background: var(--color-primary);
    }

    @media (max-width: 768px) {
        .resize-handle {
            display: none;
        }
    }
</style>
