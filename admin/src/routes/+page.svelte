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

{#each data.groups as group}
  <MetricGrid category={group.category} metrics={group.metrics} />
{/each}

{#if data.ops.available}
  <section>
    <h2>Trends (30 days, hourly)</h2>
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

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 1rem;
  }

  .unavailable p {
    color: var(--color-text-secondary);
    font-size: 0.9rem;
  }
</style>
