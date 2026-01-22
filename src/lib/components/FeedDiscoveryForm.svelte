<script lang="ts">
	import { api } from '$lib/services/api';

	interface Props {
		onFeedSelected: (feedUrl: string) => Promise<void>;
		disabled?: boolean;
	}

	let { onFeedSelected, disabled = false }: Props = $props();

	let feedUrl = $state('');
	let isDiscovering = $state(false);
	let error = $state<string | null>(null);
	let discoveredFeeds = $state<string[]>([]);

	export function reset() {
		feedUrl = '';
		isDiscovering = false;
		error = null;
		discoveredFeeds = [];
	}

	async function discoverFeeds() {
		if (!feedUrl.trim()) return;

		error = null;
		isDiscovering = true;
		discoveredFeeds = [];

		try {
			const result = await api.discoverFeeds(feedUrl.trim());
			if (result.feeds.length === 0) {
				error = 'No feeds found at this URL';
			} else if (result.feeds.length === 1) {
				await selectFeed(result.feeds[0]);
			} else {
				discoveredFeeds = result.feeds;
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to discover feeds';
		} finally {
			isDiscovering = false;
		}
	}

	async function selectFeed(url: string) {
		error = null;
		isDiscovering = true;

		try {
			await onFeedSelected(url);
			reset();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to add feed';
			isDiscovering = false;
		}
	}
</script>

<form
	onsubmit={(e) => {
		e.preventDefault();
		discoverFeeds();
	}}
>
	<div class="input-group">
		<input
			type="url"
			class="input"
			placeholder="https://example.com or feed URL"
			bind:value={feedUrl}
			disabled={disabled || isDiscovering}
		/>
		<button
			type="submit"
			class="btn btn-primary"
			disabled={disabled || isDiscovering || !feedUrl.trim()}
		>
			{isDiscovering ? 'Adding...' : 'Add'}
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
				onclick={() => selectFeed(url)}
				disabled={isDiscovering}
			>
				{url}
			</button>
		{/each}
	</div>
{/if}

<style>
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
