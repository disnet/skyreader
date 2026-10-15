<script lang="ts">
  import MetricGrid from '$lib/components/MetricGrid.svelte';
  import Sparkline from '$lib/components/Sparkline.svelte';

  let { data } = $props();
</script>

<svelte:head>
  <title>Dashboard — Skyreader Admin</title>
</svelte:head>

<h1>Dashboard</h1>

<!-- Ops first: "is it healthy right now" outranks "how big is it". -->
{#if data.ops.available}
  <MetricGrid category="Ops" metrics={data.ops.metrics} />
{:else}
  <section class="unavailable">
    <h2>Ops</h2>
    <p class="card">
      No <code>system_status</code> table in this database yet — apply the backend migrations (<code
        >0067_system_status.sql</code
      >) and wait one cron run.
    </p>
  </section>
{/if}

<!-- How it feels on readers' devices: aggregate histograms only (no reader is
     identifiable), sampled from a quarter of page loads. -->
{#if data.vitals.available}
  <div class="vitals">
    <MetricGrid category="Field vitals (p75, last 7 days)" metrics={data.vitals.metrics} />
    {#if data.vitals.routes.length > 0}
      <table class="card vitals-routes">
        <thead>
          <tr><th>Route</th><th>Views</th><th>INP</th><th>CLS</th><th>Blocking</th></tr>
        </thead>
        <tbody>
          {#each data.vitals.routes as route (route.route)}
            <tr>
              <td><code>{route.route}</code></td>
              <td>{route.views}</td>
              <td>{route.inp}</td>
              <td>{route.cls}</td>
              <td>{route.blocking}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
    <p class="note">
      Each value is the upper edge of the histogram bucket holding the 75th percentile. Browsers
      without the performance APIs don't report.
    </p>
  </div>
{/if}

{#each data.groups as group}
  <MetricGrid category={group.category} metrics={group.metrics} />
{/each}

{#if data.ops.available}
  <section>
    <h2>Trends (30 days, hourly)</h2>
    <p class="note">A break in a line is an hour with no recorded value, not a drop to zero.</p>
    <div class="grid">
      {#each data.ops.trends.series as series (series.key)}
        <Sparkline {series} />
      {/each}
    </div>
  </section>
{/if}

<style>
  h1 {
    margin-bottom: 1.5rem;
  }

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

  .note {
    color: var(--color-text-secondary);
    font-size: 0.8rem;
    margin: -0.4rem 0 0.75rem;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 1rem;
  }

  .vitals {
    margin-bottom: 2rem;
  }

  .vitals :global(section) {
    margin-bottom: 0;
  }

  .vitals-routes {
    width: 100%;
    margin-top: 0.75rem;
    border-collapse: collapse;
    font-size: 0.85rem;
  }

  .vitals-routes th,
  .vitals-routes td {
    text-align: left;
    padding: 0.35rem 0.5rem;
  }

  .vitals-routes th {
    color: var(--color-text-secondary);
    font-weight: 500;
  }

  .vitals-routes + .note {
    margin-top: 0.5rem;
  }

  .unavailable p {
    color: var(--color-text-secondary);
    font-size: 0.9rem;
  }
</style>
