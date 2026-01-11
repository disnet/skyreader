<script lang="ts">
    import { subscriptionsStore } from "$lib/stores/subscriptions.svelte";
    import FeedDiscoveryForm from "$lib/components/FeedDiscoveryForm.svelte";

    interface Props {
        open: boolean;
        onclose: () => void;
    }

    let { open, onclose }: Props = $props();
    let feedFormRef: { reset: () => void } | undefined = $state();

    function handleClose() {
        feedFormRef?.reset();
        onclose();
    }

    function handleBackdropClick(e: MouseEvent) {
        if (e.target === e.currentTarget) {
            handleClose();
        }
    }

    function handleKeydown(e: KeyboardEvent) {
        if (e.key === "Escape") {
            handleClose();
        }
    }

    async function handleFeedSelected(url: string) {
        // Add subscription with URL as temporary title
        const tempTitle = new URL(url).hostname;
        const id = await subscriptionsStore.add(url, tempTitle, {});

        // Close modal immediately
        handleClose();

        // Fetch feed in background (updates title and loads articles)
        subscriptionsStore.fetchFeed(id, true).then(async (feed) => {
            if (feed) {
                // Update subscription with actual title and siteUrl
                await subscriptionsStore.update(id, {
                    title: feed.title,
                    siteUrl: feed.siteUrl,
                });
            }
        });
    }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
    <div class="modal-backdrop" onclick={handleBackdropClick} role="dialog" aria-modal="true">
        <div class="modal">
            <div class="modal-header">
                <h2>Add Feed</h2>
                <button class="close-btn" onclick={handleClose} aria-label="Close">
                    &times;
                </button>
            </div>

            <FeedDiscoveryForm bind:this={feedFormRef} onFeedSelected={handleFeedSelected} />
        </div>
    </div>
{/if}

<style>
    .modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 100;
        padding: 1rem;
    }

    .modal {
        background: var(--color-bg);
        border-radius: 8px;
        width: 100%;
        max-width: 480px;
        padding: 1.5rem;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
    }

    .modal-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 1rem;
    }

    .modal-header h2 {
        font-size: 1.25rem;
        margin: 0;
    }

    .close-btn {
        background: none;
        border: none;
        font-size: 1.5rem;
        color: var(--color-text-secondary);
        padding: 0;
        line-height: 1;
        cursor: pointer;
    }

    .close-btn:hover {
        color: var(--color-text);
    }
</style>
