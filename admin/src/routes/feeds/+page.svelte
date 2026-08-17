<script lang="ts">
  import DataTable from '$lib/components/DataTable.svelte';
  import StatusBadge from '$lib/components/StatusBadge.svelte';
  import Pagination from '$lib/components/Pagination.svelte';
  import { page as pageState } from '$app/state';
  import { feedHealth } from '$lib/metrics/feeds';

  let { data } = $props();

  const filters = [
    { value: 'all', label: 'All' },
    { value: 'erroring', label: 'Erroring' },
    { value: 'starved', label: 'Not Crawled' },
    { value: 'ok', label: 'OK' },
  ] as const;

  function formatRetry(nextRetryAt: number | null): string {
    if (!nextRetryAt) return '';
    const minutes = Math.round((nextRetryAt * 1000 - Date.now()) / 60000);
    if (minutes <= 0) return 'retrying';
    if (minutes < 60) return `retry in ${minutes}m`;
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `retry in ${hours}h` : `retry in ${Math.round(hours / 24)}d`;
  }

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
      minute: '2-digit',
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
    <a
      href={filterUrl(f.value)}
      class:active={data.currentFilter === f.value}
      class="btn btn-secondary btn-sm"
    >
      {f.label}
    </a>
  {/each}
</div>

<DataTable>
  {#snippet header()}
    <th><a href={sortUrl('title')}>Title{sortIndicator('title')}</a></th>
    <th>URL</th>
    <th><a href={sortUrl('subscriber_count')}>Subs{sortIndicator('subscriber_count')}</a></th>
    <th><a href={sortUrl('item_count')}>Archived{sortIndicator('item_count')}</a></th>
    <th><a href={sortUrl('last_ingest_at')}>Last Item{sortIndicator('last_ingest_at')}</a></th>
    <th><a href={sortUrl('error_count')}>Status{sortIndicator('error_count')}</a></th>
  {/snippet}

  {#each data.rows as feed}
    {@const state = feedHealth(feed)}
    <tr>
      <td>{feed.title ?? '—'}</td>
      <td class="url-cell">{feed.feed_url}</td>
      <td>{feed.subscriber_count}</td>
      <td>{feed.item_count}</td>
      <td>{formatDate(feed.last_ingest_at)}</td>
      <td>
        <StatusBadge status={state.status} label={state.label} />
        {#if feed.error_count > 0}
          <div class="fault-detail" title={feed.last_error ?? ''}>
            {feed.last_error ?? 'Unknown error'}
          </div>
          <div class="fault-meta">
            {feed.error_count}
            {feed.error_count === 1 ? 'failure' : 'failures'}
            {#if formatRetry(feed.next_retry_at)}· {formatRetry(feed.next_retry_at)}{/if}
            {#if feed.last_fetch_at}· last ok {formatDate(feed.last_fetch_at)}{/if}
          </div>
        {:else if feed.crawl_stale}
          <div class="fault-meta">
            In the crawl set, not being fetched
            {#if feed.last_fetch_at}· last ok {formatDate(feed.last_fetch_at)}{/if}
          </div>
        {/if}
      </td>
    </tr>
  {:else}
    <tr>
      <td
        colspan="6"
        style="text-align: center; color: var(--color-text-secondary); padding: 2rem;"
      >
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

  /* The crawler's message, verbatim — the whole reason the health report exists.
     Clamped rather than truncated to one line: an operator needs enough of it to
     tell a 404 from a bot filter without hovering. */
  .fault-detail {
    max-width: 320px;
    margin-top: 0.35rem;
    font-size: 0.85rem;
    color: var(--color-error);
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .fault-meta {
    max-width: 320px;
    margin-top: 0.2rem;
    font-size: 0.75rem;
    color: var(--color-text-secondary);
  }
</style>
