<script lang="ts">
  import type { TrendSeries } from '$lib/metrics/ops';
  import { sparklineGeometry } from './sparkline';

  interface Props {
    series: TrendSeries;
  }

  let { series }: Props = $props();

  const WIDTH = 240;
  const HEIGHT = 40;

  // Nulls are gaps, not zeroes — an hour the cron never recorded must not be
  // drawn as a plunge to the axis, and must not be bridged by a line either. See
  // ./sparkline.ts, where that rule is tested.
  const geometry = $derived(sparklineGeometry(series.points, WIDTH, HEIGHT));
  const latest = $derived(geometry.latest);
  const change = $derived(
    geometry.latest !== null && geometry.first !== null ? geometry.latest - geometry.first : null
  );

  function format(value: number): string {
    if (Number.isInteger(value)) return value.toLocaleString();
    return value.toFixed(1);
  }
</script>

<div class="card trend">
  <div class="head">
    <span class="label">{series.label}</span>
    <span class="value">
      {latest === null ? '—' : format(latest)}{#if series.unit && latest !== null}<span class="unit"
          >{series.unit}</span
        >{/if}
    </span>
  </div>

  {#if geometry.path || geometry.dots.length}
    <svg viewBox="0 0 {WIDTH} {HEIGHT}" preserveAspectRatio="none" role="presentation">
      {#if geometry.path}
        <path d={geometry.path} fill="none" stroke="var(--color-primary)" stroke-width="1.5" />
      {/if}
      <!-- An hour recorded with no recorded neighbour has no line to belong to. -->
      {#each geometry.dots as dot (dot.x)}
        <circle cx={dot.x} cy={dot.y} r="1.2" fill="var(--color-primary)" />
      {/each}
    </svg>
  {:else}
    <p class="empty">Not enough history yet</p>
  {/if}

  {#if change !== null && geometry.spanHours > 0}
    <div class="change">
      {change > 0 ? '+' : ''}{format(change)} over {geometry.spanHours}h
    </div>
  {/if}
</div>

<style>
  .trend {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .label {
    font-size: 0.8rem;
    color: var(--color-text-secondary);
    font-weight: 500;
  }

  .value {
    font-size: 1.1rem;
    font-weight: 700;
  }

  .unit {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--color-text-secondary);
    margin-left: 0.15rem;
  }

  svg {
    width: 100%;
    height: 40px;
    display: block;
  }

  .empty,
  .change {
    font-size: 0.75rem;
    color: var(--color-text-secondary);
  }
</style>
