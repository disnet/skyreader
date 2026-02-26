<script lang="ts">
	interface Props {
		page: number;
		perPage: number;
		total: number;
		baseUrl: string;
	}

	let { page, perPage, total, baseUrl }: Props = $props();

	const totalPages = $derived(Math.ceil(total / perPage));

	function pageUrl(p: number): string {
		const url = new URL(baseUrl, 'http://localhost');
		url.searchParams.set('page', String(p));
		return `${url.pathname}${url.search}`;
	}
</script>

{#if totalPages > 1}
	<div class="pagination">
		<span class="info">
			{(page - 1) * perPage + 1}–{Math.min(page * perPage, total)} of {total}
		</span>
		<div class="controls">
			{#if page > 1}
				<a href={pageUrl(page - 1)} class="btn btn-secondary btn-sm">Prev</a>
			{/if}
			{#if page < totalPages}
				<a href={pageUrl(page + 1)} class="btn btn-secondary btn-sm">Next</a>
			{/if}
		</div>
	</div>
{/if}

<style>
	.pagination {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-top: 1rem;
	}

	.info {
		font-size: 0.875rem;
		color: var(--color-text-secondary);
	}

	.controls {
		display: flex;
		gap: 0.5rem;
	}

	.controls a {
		text-decoration: none;
	}
</style>
