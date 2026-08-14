<script lang="ts">
  import type { TrendSeries } from '$lib/metrics/ops';

  interface Props {
    series: TrendSeries;
  }

  let { series }: Props = $props();

  const WIDTH = 240;
  const HEIGHT = 40;

  // Nulls are gaps, not zeroes — a stretch where the cron never recorded a value
  // must not be drawn as a plunge to the axis. Points keep their x position so a
  // gap reads as a gap.
  const drawn = $derived(
    series.points
      .map((value, index) => ({ value, index }))
      .filter((p): p is { value: number; index: number } => p.value !== null)
  );

  const latest = $derived(drawn.length ? drawn[drawn.length - 1].value : null);
  const first = $derived(drawn.length ? drawn[0].value : null);
  const change = $derived(latest !== null && first !== null ? latest - first : null);

  const path = $derived.by(() => {
    if (drawn.length < 2) return '';
    const values = drawn.map((p) => p.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const lastIndex = series.points.length - 1 || 1;

    return drawn
      .map((point, i) => {
        const x = (point.index / lastIndex) * WIDTH;
        // Flat series sit on the mid-line rather than pinned to the floor.
        const y = HEIGHT - ((point.value - min) / span) * (HEIGHT - 4) - 2;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  });

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

  {#if path}
    <svg viewBox="0 0 {WIDTH} {HEIGHT}" preserveAspectRatio="none" role="presentation">
      <path d={path} fill="none" stroke="var(--color-primary)" stroke-width="1.5" />
    </svg>
  {:else}
    <p class="empty">Not enough history yet</p>
  {/if}

  {#if change !== null && drawn.length > 1}
    <div class="change">
      {change > 0 ? '+' : ''}{format(change)} over {drawn.length}h
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
