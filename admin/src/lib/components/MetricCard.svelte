<script lang="ts">
  import type { MetricValue } from '$lib/types';
  import StatusBadge from './StatusBadge.svelte';

  interface Props {
    metric: MetricValue;
  }

  let { metric }: Props = $props();
</script>

<div class="card metric-card">
  <div class="label">{metric.label}</div>
  <div class="value-row">
    <span class="value">{metric.value}</span>
    {#if metric.unit}
      <span class="unit">{metric.unit}</span>
    {/if}
  </div>
  {#if metric.status}
    <div class="status">
      <StatusBadge status={metric.status} />
    </div>
  {/if}
</div>

<style>
  .metric-card {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .label {
    font-size: 0.8rem;
    color: var(--color-text-secondary);
    font-weight: 500;
  }

  .value-row {
    display: flex;
    align-items: baseline;
    gap: 0.35rem;
  }

  .value {
    font-size: 1.75rem;
    font-weight: 700;
    line-height: 1.2;
  }

  .unit {
    font-size: 0.85rem;
    color: var(--color-text-secondary);
  }

  .status {
    margin-top: 0.25rem;
  }
</style>
