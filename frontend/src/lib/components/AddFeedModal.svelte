<script lang="ts">
    import { subscriptionsStore } from "$lib/stores/subscriptions.svelte";
    import { api } from "$lib/services/api";

    interface Props {
        open: boolean;
        onclose: () => void;
    }

    let { open, onclose }: Props = $props();

    let feedUrl = $state("");
    let isAdding = $state(false);
    let error = $state<string | null>(null);
    let discoveredFeeds = $state<string[]>([]);

    function reset() {
        feedUrl = "";
        isAdding = false;
        error = null;
        discoveredFeeds = [];
    }

    function handleClose() {
        reset();
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

    async function discoverFeeds() {
        if (!feedUrl.trim()) return;

        error = null;
        isAdding = true;

        try {
            const result = await api.discoverFeeds(feedUrl.trim());
            if (result.feeds.length === 0) {
                error = "No feeds found at this URL";
            } else if (result.feeds.length === 1) {
                await addFeed(result.feeds[0]);
            } else {
                discoveredFeeds = result.feeds;
            }
        } catch (e) {
            error = e instanceof Error ? e.message : "Failed to discover feeds";
        } finally {
            isAdding = false;
        }
    }

    async function addFeed(url: string) {
        error = null;
        isAdding = true;

        try {
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
        } catch (e) {
            error = e instanceof Error ? e.message : "Failed to add feed";
            isAdding = false;
        }
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

            <form onsubmit={(e) => { e.preventDefault(); discoverFeeds(); }}>
                <div class="input-group">
                    <input
                        type="url"
                        class="input"
                        placeholder="https://example.com or feed URL"
                        bind:value={feedUrl}
                        disabled={isAdding}
                    />
                    <button
                        type="submit"
                        class="btn btn-primary"
                        disabled={isAdding || !feedUrl.trim()}
                    >
                        {isAdding ? "Adding..." : "Add"}
                    </button>
                </div>
            </form>

            {#if error}
                <p class="error">{error}</p>
            {/if}

            {#if discoveredFeeds.length > 1}
                <div class="discovered-feeds">
                    <p>Found multiple feeds. Select one:</p>
                    {#each discoveredFeeds as url}
                        <button
                            class="btn btn-secondary feed-option"
                            onclick={() => addFeed(url)}
                            disabled={isAdding}
                        >
                            {url}
                        </button>
                    {/each}
                </div>
            {/if}
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

    .input-group {
        display: flex;
        gap: 0.5rem;
    }

    .input-group input {
        flex: 1;
    }

    .discovered-feeds {
        margin-top: 1rem;
        padding-top: 1rem;
        border-top: 1px solid var(--color-border);
    }

    .discovered-feeds p {
        margin-bottom: 0.5rem;
        color: var(--color-text-secondary);
        font-size: 0.875rem;
    }

    .feed-option {
        display: block;
        width: 100%;
        text-align: left;
        margin-top: 0.5rem;
        font-size: 0.875rem;
        word-break: break-all;
    }
</style>
