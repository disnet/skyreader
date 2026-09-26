<script lang="ts">
  // Bluesky's own count ring: fills toward 300, turns amber in the last 20 with
  // the characters left inside it, and red past the limit — where the post gets
  // trimmed, so the number goes negative.
  import { BLUESKY_MAX_GRAPHEMES } from '$lib/utils/blueskyPost';

  interface Props {
    /** What the post's text would run to uncut, in graphemes. */
    length: number;
  }

  let { length }: Props = $props();

  // The ring's geometry (a 24-unit box) and when it starts warning.
  const RING_R = 10;
  const RING_C = 2 * Math.PI * RING_R;
  const RING_WARN = 20;

  let remaining = $derived(BLUESKY_MAX_GRAPHEMES - length);
  let ringState = $derived(remaining < 0 ? 'over' : remaining <= RING_WARN ? 'near' : 'ok');
  let fill = $derived(Math.min(length / BLUESKY_MAX_GRAPHEMES, 1));
</script>

<span
  class="count-ring {ringState}"
  role="img"
  aria-label={remaining < 0
    ? `${-remaining} characters over Bluesky's limit; the post will be trimmed`
    : `${remaining} characters left on Bluesky`}
  title={`${length}/${BLUESKY_MAX_GRAPHEMES}`}
>
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
    <circle class="ring-track" cx="12" cy="12" r={RING_R} />
    <circle
      class="ring-fill"
      cx="12"
      cy="12"
      r={RING_R}
      stroke-dasharray={RING_C}
      stroke-dashoffset={RING_C * (1 - fill)}
    />
  </svg>
  {#if ringState !== 'ok'}<span class="ring-num">{Math.max(remaining, -99)}</span>{/if}
</span>

<style>
  .count-ring {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 22px;
    height: 22px;
    font-variant-numeric: tabular-nums;
  }

  /* Drawn from 12 o'clock, clockwise. */
  .count-ring svg {
    transform: rotate(-90deg);
  }

  .ring-track,
  .ring-fill {
    fill: none;
    stroke-width: 2.5;
  }

  .ring-track {
    stroke: var(--color-border, #e0e0e0);
  }

  .ring-fill {
    stroke: var(--color-primary, #0066cc);
    stroke-linecap: round;
    transition:
      stroke-dashoffset 0.15s ease,
      stroke 0.15s ease;
  }

  .count-ring.near .ring-fill {
    stroke: var(--color-warning, #ff9800);
  }

  .count-ring.over .ring-fill {
    stroke: var(--color-error, #f44336);
  }

  .ring-num {
    position: absolute;
    font-size: 0.5625rem;
    font-weight: var(--weight-medium);
    color: var(--color-text-secondary);
  }

  .count-ring.over .ring-num {
    color: var(--color-error, #f44336);
  }

  @media (prefers-reduced-motion: reduce) {
    .ring-fill {
      transition: none;
    }
  }
</style>
