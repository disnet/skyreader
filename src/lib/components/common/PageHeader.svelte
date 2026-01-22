<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		subtitle?: string;
		children?: Snippet;
	}

	let { title, subtitle, children }: Props = $props();
</script>

<div class="page-header">
	<div class="header-content">
		<h1>{title}</h1>
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
		padding: 1rem;
		border-bottom: 1px solid var(--color-border);
		position: sticky;
		top: 0;
		background: var(--color-bg);
		z-index: 10;
	}

	.header-content {
		min-width: 0;
	}

	.page-header h1 {
		font-size: 1.5rem;
		margin: 0;
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
