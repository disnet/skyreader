<script lang="ts">
  import DataTable from '$lib/components/DataTable.svelte';
  import StatusBadge from '$lib/components/StatusBadge.svelte';
  import {
    differsFromReference,
    nonceSignal,
    notFoundWording,
    rateLimitHeaders,
  } from '$lib/metrics/pds';

  let { data } = $props();

  function formatDate(ts: number | null): string {
    if (!ts) return '—';
    return new Date(ts * 1000).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }
</script>

<svelte:head>
  <title>PDS Servers — Skyreader Admin</title>
</svelte:head>

<h1>PDS Servers</h1>
<p class="intro">
  Which PDS hosts readers are on, and what each has been seen doing where implementations differ.
  Counts come from Skyreader's own requests (writes, refusals, nonce requests, missing records). A
  behavior no profile in <code>backend/test/helpers/fake-pds.ts</code> covers should get one.
</p>

<DataTable>
  {#snippet header()}
    <th>Host</th>
    <th>Readers</th>
    <th>Writes</th>
    <th>RateLimit headers</th>
    <th>429s</th>
    <th>DPoP nonce</th>
    <th>Not-found wording</th>
    <th>Server</th>
    <th>Last seen</th>
  {/snippet}

  {#each data.hosts as h}
    <tr>
      <td class="host-cell">
        {h.name}
        {#if h.hosts > 1}<div class="meta">{h.hosts} hosts</div>{/if}
        {#if differsFromReference(h)}
          <div><StatusBadge status="warning" label="Differs from reference" /></div>
        {/if}
      </td>
      <td>{h.readers}</td>
      <td>{h.writes_ok}</td>
      <td>{rateLimitHeaders(h)}</td>
      <td>
        {h.writes_refused}
        {#if h.writes_refused > 0}
          <div class="meta">
            {h.writes_refused_rate_limit_headers} with headers · {h.writes_refused_retry_after} with Retry-After
          </div>
        {/if}
      </td>
      <td>{nonceSignal(h)}</td>
      <td>{notFoundWording(h)}</td>
      <td class="meta">{h.server ?? '—'}</td>
      <td>{formatDate(h.last_seen_at)}</td>
    </tr>
  {:else}
    <tr>
      <td
        colspan="9"
        style="text-align: center; color: var(--color-text-secondary); padding: 2rem;"
      >
        No readers yet
      </td>
    </tr>
  {/each}
</DataTable>

<style>
  h1 {
    margin-bottom: 0.5rem;
  }

  .intro {
    max-width: 70ch;
    margin-bottom: 1rem;
    color: var(--color-text-secondary);
    font-size: 0.9rem;
  }

  .host-cell {
    max-width: 280px;
    overflow-wrap: anywhere;
  }

  .meta {
    font-size: 0.75rem;
    color: var(--color-text-secondary);
  }
</style>
