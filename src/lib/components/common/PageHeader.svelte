<script lang="ts">
	import type { Snippet } from 'svelte';
	import NavigationDropdown from '$lib/components/NavigationDropdown.svelte';

	interface Props {
		title: string;
		subtitle?: string;
		children?: Snippet;
	}

	let { title, subtitle, children }: Props = $props();
</script>

<div class="page-header">
	<div class="header-content">
		<NavigationDropdown currentTitle={title} />
		{#if subtitle}
			<p class="subtitle">{subtitle}</p>
		{/if}
	</div>
	{#if children}
		<div class="header-actions">
			{@render children()}
		</div>
	{/if}
</div>

<style>
	.page-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 1rem;
		padding: 0.75rem 0;
		border-bottom: 1px solid var(--color-border);
		position: sticky;
		top: 0;
		background: var(--color-bg);
		z-index: 10;
	}

	.header-content {
		min-width: 0;
		flex: 1;
	}

	.subtitle {
		color: var(--color-text-secondary);
		margin: 0.25rem 0 0;
		font-size: 0.875rem;
	}

	.header-actions {
		display: flex;
		gap: 0.5rem;
		flex-shrink: 0;
	}
</style>
