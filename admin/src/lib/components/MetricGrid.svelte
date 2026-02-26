<script lang="ts">
	import type { MetricValue } from '$lib/types';
	import MetricCard from './MetricCard.svelte';

	interface Props {
		category: string;
		metrics: MetricValue[];
	}

	let { category, metrics }: Props = $props();
</script>

<section>
	<h2>{category}</h2>
	<div class="grid">
		{#each metrics as metric}
			<MetricCard {metric} />
		{/each}
	</div>
</section>

<style>
	section {
		margin-bottom: 2rem;
	}

	h2 {
		font-size: 1rem;
		font-weight: 600;
		color: var(--color-text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-bottom: 0.75rem;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 1rem;
	}
</style>
