<script lang="ts">
	import DataTable from '$lib/components/DataTable.svelte';
	import Pagination from '$lib/components/Pagination.svelte';
	import { page as pageState } from '$app/state';

	let { data } = $props();

	function formatDate(ts: number | null): string {
		if (!ts) return '—';
		return new Date(ts * 1000).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		});
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

	function buildBaseUrl(): string {
		const url = new URL(pageState.url);
		url.searchParams.delete('page');
		return `${url.pathname}${url.search}`;
	}
</script>

<svelte:head>
	<title>Users — Skyreader Admin</title>
</svelte:head>

<h1>Users</h1>

<form class="search-bar" method="get">
	<input
		class="input"
		type="search"
		name="search"
		placeholder="Search by handle or name..."
		value={data.search}
	/>
	<button class="btn btn-primary" type="submit">Search</button>
</form>

<DataTable>
	{#snippet header()}
		<th><a href={sortUrl('handle')}>Handle{sortIndicator('handle')}</a></th>
		<th>Display Name</th>
		<th><a href={sortUrl('registered_at')}>Registered{sortIndicator('registered_at')}</a></th>
		<th><a href={sortUrl('last_active_at')}>Last Active{sortIndicator('last_active_at')}</a></th>
		<th><a href={sortUrl('tier')}>Tier{sortIndicator('tier')}</a></th>
		<th>Subs</th>
		<th>Shares</th>
	{/snippet}

	{#each data.rows as user}
		<tr>
			<td><a href="/users/{encodeURIComponent(user.did)}">{user.handle}</a></td>
			<td>{user.display_name ?? '—'}</td>
			<td>{formatDate(user.registered_at)}</td>
			<td>{formatDate(user.last_active_at)}</td>
			<td>{user.tier ?? 'free'}</td>
			<td>{user.subscription_count ?? 0}</td>
			<td>{user.share_count ?? 0}</td>
		</tr>
	{:else}
		<tr>
			<td colspan="7" style="text-align: center; color: var(--color-text-secondary); padding: 2rem;">
				No users found
			</td>
		</tr>
	{/each}
</DataTable>

<Pagination page={data.page} perPage={data.perPage} total={data.total} baseUrl={buildBaseUrl()} />

<style>
	h1 {
		margin-bottom: 1rem;
	}

	.search-bar {
		display: flex;
		gap: 0.5rem;
		margin-bottom: 1rem;
		max-width: 400px;
	}

	.search-bar .input {
		flex: 1;
	}

	th a {
		text-decoration: none;
		color: inherit;
	}

	th a:hover {
		color: var(--color-primary);
	}
</style>
