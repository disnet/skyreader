<script lang="ts">
    import { subscriptionsStore } from "$lib/stores/subscriptions.svelte";
    import FeedDiscoveryForm from "$lib/components/FeedDiscoveryForm.svelte";
    import Modal from "$lib/components/common/Modal.svelte";

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

<Modal {open} onclose={handleClose} title="Add Feed">
    <FeedDiscoveryForm bind:this={feedFormRef} onFeedSelected={handleFeedSelected} />
</Modal>
