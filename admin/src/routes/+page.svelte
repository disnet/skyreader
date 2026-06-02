<script lang="ts">
  import MetricGrid from '$lib/components/MetricGrid.svelte';

  let { data } = $props();
</script>

<svelte:head>
  <title>Dashboard — Skyreader Admin</title>
</svelte:head>

<h1>Dashboard</h1>

{#each data.groups as group}
  <MetricGrid category={group.category} metrics={group.metrics} />
{/each}

<style>
  h1 {
    margin-bottom: 1.5rem;
  }
</style>
