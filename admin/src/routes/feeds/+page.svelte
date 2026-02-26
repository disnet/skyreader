<script lang="ts">
	import DataTable from '$lib/components/DataTable.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import Pagination from '$lib/components/Pagination.svelte';
	import { page as pageState } from '$app/state';

	let { data } = $props();

	const filters = [
		{ value: 'all', label: 'All' },
		{ value: 'healthy', label: 'Healthy' },
		{ value: 'erroring', label: 'Erroring' }
	] as const;

	function filterUrl(filter: string): string {
		const url = new URL(pageState.url);
		url.searchParams.set('filter', filter);
		url.searchParams.delete('page');
		return `${url.pathname}${url.search}`;
	}

	function sortUrl(col: string): string {
		const url = new URL(pageState.url);
		const newOrder = data.currentSort === col && data.currentOrder === 'desc' ? 'asc' : 'desc';
		url.searchParams.set('sort', col);
		url.searchParams.set('order', newOrder);
		url.searchParams.delete('page');
		return `${url.pathname}${url.search}`;
	}

	function sortIndicator(col: string): string {
		if (data.currentSort !== col) return '';
		return data.currentOrder === 'asc' ? ' ↑' : ' ↓';
	}

	function formatDate(ts: number | null): string {
		if (!ts) return '—';
		return new Date(ts * 1000).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	}

	function buildBaseUrl(): string {
		const url = new URL(pageState.url);
		url.searchParams.delete('page');
		return `${url.pathname}${url.search}`;
	}
</script>

<svelte:head>
	<title>Feeds — Skyreader Admin</title>
</svelte:head>

<h1>Feed Health</h1>

<div class="filter-tabs">
	{#each filters as f}
		<a href={filterUrl(f.value)} class:active={data.currentFilter === f.value} class="btn btn-secondary btn-sm">
			{f.label}
		</a>
	{/each}
</div>

<DataTable>
	{#snippet header()}
		<th><a href={sortUrl('title')}>Title{sortIndicator('title')}</a></th>
		<th>URL</th>
		<th><a href={sortUrl('subscriber_count')}>Subs{sortIndicator('subscriber_count')}</a></th>
		<th><a href={sortUrl('error_count')}>Errors{sortIndicator('error_count')}</a></th>
		<th>Last Error</th>
		<th><a href={sortUrl('last_fetched_at')}>Last Fetched{sortIndicator('last_fetched_at')}</a></th>
		<th>Status</th>
	{/snippet}

	{#each data.rows as feed}
		<tr>
			<td>{feed.title ?? '—'}</td>
			<td class="url-cell">{feed.feed_url}</td>
			<td>{feed.subscriber_count}</td>
			<td>{feed.error_count}</td>
			<td class="error-cell">{feed.fetch_error ?? '—'}</td>
			<td>{formatDate(feed.last_fetched_at)}</td>
			<td>
				<StatusBadge status={feed.error_count > 0 ? 'error' : 'healthy'} />
			</td>
		</tr>
	{:else}
		<tr>
			<td colspan="7" style="text-align: center; color: var(--color-text-secondary); padding: 2rem;">
				No feeds found
			</td>
		</tr>
	{/each}
</DataTable>

<Pagination page={data.page} perPage={data.perPage} total={data.total} baseUrl={buildBaseUrl()} />

<style>
	h1 {
		margin-bottom: 1rem;
	}

	.filter-tabs {
		display: flex;
		gap: 0.5rem;
		margin-bottom: 1rem;
	}

	.filter-tabs a {
		text-decoration: none;
	}

	.filter-tabs a.active {
		background: var(--color-primary);
		color: white;
		border-color: var(--color-primary);
	}

	th a {
		text-decoration: none;
		color: inherit;
	}

	th a:hover {
		color: var(--color-primary);
	}

	.url-cell {
		max-width: 250px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.85rem;
	}

	.error-cell {
		max-width: 200px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.8rem;
		color: var(--color-error);
	}
</style>
