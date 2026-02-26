<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		children: Snippet;
		header: Snippet;
	}

	let { children, header }: Props = $props();
</script>

<div class="table-wrapper">
	<table>
		<thead>
			<tr>
				{@render header()}
			</tr>
		</thead>
		<tbody>
			{@render children()}
		</tbody>
	</table>
</div>

<style>
	.table-wrapper {
		overflow-x: auto;
		border: 1px solid var(--color-border);
		border-radius: 8px;
	}

	table {
		min-width: 100%;
	}

	table :global(tr:last-child td) {
		border-bottom: none;
	}
</style>
