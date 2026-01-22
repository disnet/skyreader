<script lang="ts">
	import { subscriptionsStore, MAX_SUBSCRIPTIONS } from '$lib/stores/subscriptions.svelte';
	import FeedDiscoveryForm from '$lib/components/FeedDiscoveryForm.svelte';
	import Modal from '$lib/components/common/Modal.svelte';

	interface Props {
		open: boolean;
		onclose: () => void;
	}

	let { open, onclose }: Props = $props();
	let feedFormRef: { reset: () => void } | undefined = $state();
	let error = $state<string | null>(null);

	const isAtLimit = $derived(subscriptionsStore.subscriptions.length >= MAX_SUBSCRIPTIONS);

	function handleClose() {
		feedFormRef?.reset();
		error = null;
		onclose();
	}

	async function handleFeedSelected(url: string) {
		error = null;

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
			error = e instanceof Error ? e.message : 'Failed to add feed';
		}
	}
</script>

<Modal {open} onclose={handleClose} title="Add Feed">
	{#if isAtLimit}
		<p class="limit-message">
			You've reached the maximum of {MAX_SUBSCRIPTIONS} feeds. Remove some feeds to add new ones.
		</p>
	{:else}
		<FeedDiscoveryForm bind:this={feedFormRef} onFeedSelected={handleFeedSelected} />
		{#if error}
			<p class="error-message">{error}</p>
		{/if}
		<p class="info-notice">Your feed subscriptions are public.</p>
	{/if}
</Modal>

<style>
	.limit-message {
		color: var(--color-text-secondary);
		text-align: center;
		padding: 1rem;
	}

	.error-message {
		color: var(--color-error);
		font-size: 0.875rem;
		margin-top: 0.5rem;
	}

	.info-notice {
		color: var(--color-text-secondary);
		font-size: 0.75rem;
		margin-top: 1rem;
		text-align: center;
	}
</style>
