<script lang="ts">
  import type { Snippet } from 'svelte';
  import { auth } from '$lib/stores/auth.svelte';

  /**
   * The one upgrade prompt for plan limits. It supplies the frame and the
   * upsell; the caller supplies the sentence, because only the call site knows
   * whether the reader was blocked, warned, or told about feeds already parked.
   *
   * Deliberately not a modal. Hitting a limit interrupts enough on its own; a
   * paywall interstitial would be the SaaS chrome /supporter refuses.
   *
   * A Supporter who reaches their own (much higher) ceiling gets the sentence
   * and no upsell, so this is safe to render unconditionally at any limit.
   */
  type LimitKind = 'feeds' | 'saves' | 'mirror';

  let { kind, children }: { kind: LimitKind; children: Snippet } = $props();

  // Mirrors the supporter tier in backend/src/config/tier-limits.ts. Kept as
  // prose rather than piped from auth.user.limits, which only ever carries the
  // *current* plan's numbers, never the one being sold.
  const RAISED: Record<LimitKind, string> = {
    feeds: 'Supporters get 1,000 active feeds.',
    saves: 'Supporters get 1,000 saves a month.',
    mirror: 'Supporters mirror 5,000 subscriptions.',
  };

  const isSupporter = $derived(auth.user?.tier === 'supporter');
</script>

<div class="limit-notice">
  <div class="limit-body">{@render children()}</div>
  {#if !isSupporter}
    <p class="limit-upsell">
      {RAISED[kind]}
      <a href="/supporter">Become a Supporter</a>
    </p>
  {/if}
</div>

<style>
  /* Flat by default: a bordered block, no shadow. It never floats over
     anything, so it earns no elevation. */
  .limit-notice {
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg-secondary);
    font-size: 0.875rem;
    line-height: 1.5;
    color: var(--color-text);
  }

  .limit-body {
    padding: 0.75rem 0.875rem;
  }

  /* The pitch sits below a hairline so the fact above it reads as fact, not as
     part of the sales line. */
  .limit-upsell {
    margin: 0;
    padding: 0.625rem 0.875rem;
    border-top: 1px solid var(--color-border);
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
  }

  .limit-upsell a {
    color: var(--color-primary);
    text-decoration: none;
    font-weight: 500;
    white-space: nowrap;
  }

  .limit-upsell a:hover {
    text-decoration: underline;
  }

  /* Call sites hand in plain paragraphs; normalize their spacing here so each
     one doesn't have to restate it. */
  .limit-body :global(p) {
    margin: 0;
  }

  .limit-body :global(p + p) {
    margin-top: 0.5rem;
  }
</style>
