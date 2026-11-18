<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { api, type BillingProduct } from '$lib/services/api';
  import {
    billingLine,
    cheapest,
    compareAt,
    formatCents,
    intervalNoun,
    monthlyPrice,
    supporterPlans,
  } from '$lib/utils/pricing';
  import { freeLimits, supporterLimits } from '$lib/constants/tierLimits';
  import { docsUrl } from '$lib/constants/docs';
  import ArticleStory from '$lib/components/landing/ArticleStory.svelte';

  let starting = $state(false);
  let startError = $state<string | null>(null);

  // Start Reading: seed the curated starter channels into this browser and open
  // the reader. No account, no network writes — the subscription rows live only
  // in IndexedDB until the reader signs in.
  async function startReading() {
    if (starting) return;
    starting = true;
    startError = null;
    try {
      const { channels } = await api.getStarterFeeds();
      const feeds = channels.flatMap((channel) =>
        channel.feeds.map((feed) => ({ ...feed, category: channel.name }))
      );

      // Dynamic: the landing page must not ship the app's data layer (Dexie,
      // the feed stores) to every logged-out visitor — the same contract that
      // keeps AppShell out of this chunk (see +layout.svelte).
      const { subscriptionsStore } = await import('$lib/stores/subscriptions.svelte');

      // Before addBulk: the store reads this to keep the writes local.
      await auth.enterGuestMode();
      // The one bulk write a guest is allowed — adding anything else needs an
      // account (see subscriptions.svelte.ts).
      const result = await subscriptionsStore.addBulk(feeds, undefined, { starterSeed: true });
      // addBulk never throws — it collects per-feed problems. Nothing landing at
      // all means the local database is unavailable (a locked-down private
      // window), and there is no reading room to walk into.
      if (result.added.length === 0) {
        auth.exitGuestMode();
        throw new Error(result.failed[0]?.error ?? 'No feeds could be saved locally');
      }

      // Remember which rows were seeded rather than chosen, so signing in to an
      // existing library doesn't bulk-add the samples to it.
      const starterUrls = new Set(feeds.map((feed) => feed.feedUrl));
      auth.rememberStarterRkeys(
        subscriptionsStore.subscriptions
          .filter((sub) => sub.feedUrl && starterUrls.has(sub.feedUrl))
          .map((sub) => sub.rkey)
      );

      await goto('/feeds');
    } catch (error) {
      console.error('Could not start guest reading:', error);
      startError = 'Could not open the reader here. Try signing in instead.';
      starting = false;
    }
  }

  // ── Reveal-on-scroll action ──────────────────────────────────
  // Default (no JS / reduced motion): content is fully visible. The
  // action only opts an element into the entrance when motion is allowed,
  // so the reveal enhances an already-visible default rather than gating it.
  function reveal(node: HTMLElement, params: { delay?: number } = {}) {
    if (typeof window === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    node.classList.add('reveal-init');
    if (params.delay) node.style.transitionDelay = `${params.delay}ms`;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          node.classList.add('revealed');
          io.disconnect();
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
    );
    io.observe(node);
    return { destroy: () => io.disconnect() };
  }

  // ── Pricing (live from Polar via the backend) ────────────────
  // Prices are authored in one place, the Polar dashboard, and served by the
  // public /api/billing/products endpoint. The section reads fine without
  // figures: a failed fetch just leaves the price line off, and /supporter
  // carries the full detail.
  let plans = $state<BillingProduct[]>([]);

  // The Believer patronage tier stays off the landing page; /supporter tells
  // that story. Of what remains, offer the cheapest yearly product (the
  // founding price when one is live), falling back to monthly. The plan-reading
  // rules are shared with /supporter (utils/pricing.ts) so the two surfaces
  // can't drift apart on which product they call the standard price.
  const offered = $derived(supporterPlans(plans));
  const offer = $derived(
    cheapest(offered.filter((p) => p.interval === 'year')) ??
      cheapest(offered.filter((p) => p.interval === 'month'))
  );

  // Monthly-priced framing, same as /supporter: a yearly plan's headline is
  // its per-month equivalent, with the true amount charged named right beneath
  // it — so the only two figures here are always comparable.
  const offerPerMonth = $derived(offer ? monthlyPrice(offer) : null);

  // A dearer live product of the same cadence marks the offer as a founding
  // price; when the founding product is archived in Polar, the framing
  // disappears here on its own.
  const standardPlan = $derived(
    offer
      ? compareAt(
          offered.filter((p) => p.interval === offer.interval),
          offer
        )
      : null
  );

  // ── Hero highlight draw ──────────────────────────────────────
  let motion = $state(false); // becomes true on mount when motion allowed
  let heroDrawn = $state(false);

  onMount(() => {
    // Before the reduced-motion early return: prices load regardless of
    // motion preference. Failure is silent by design; see the pricing note.
    api
      .getBillingProducts()
      .then(({ products }) => (plans = products))
      .catch(() => {});

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    motion = true;
    requestAnimationFrame(() => requestAnimationFrame(() => (heroDrawn = true)));
    // Safety net: scroll-reveal enhances reading, but content must never be
    // stuck hidden in a non-scrolling or headless context. Force-reveal
    // anything still pending shortly after load; engaged readers scroll well
    // before this fires and still get the staggered entrance.
    const safety = setTimeout(() => {
      document
        .querySelectorAll('.landing .reveal-init:not(.revealed)')
        .forEach((el) => el.classList.add('revealed'));
    }, 2500);
    return () => clearTimeout(safety);
  });
</script>

<div class="landing">
  <!-- ── Hero + story: the hero is the story's opening frame ── -->
  <ArticleStory>
    {#snippet intro()}
      <header class="hero">
        <h1 class="hero-title">
          <span class="line" use:reveal>Read it Tuesday.</span>
          <span class="line" use:reveal={{ delay: 90 }}>
            <mark class="hl" class:animate={motion} class:drawn={heroDrawn || !motion}
              >Still have it in March.</mark
            >
          </span>
        </h1>
        <p class="hero-lead" use:reveal={{ delay: 180 }}>
          Skyreader brings everything you follow into one calm place and gives you room to read it
          deeply. What you mark stays with you, and leads you to what to read next.
        </p>
        <div class="hero-actions" use:reveal={{ delay: 260 }}>
          <button class="cta-primary" onclick={startReading} disabled={starting}>
            {starting ? 'Preparing your reading room…' : 'Start Reading'}
          </button>
          <a href="#story" class="cta-ghost">
            Follow one article
            <Icon name="arrow-down" size={16} />
          </a>
        </div>
        {#if startError}
          <p class="start-error" role="alert">{startError}</p>
        {/if}
        <p class="hero-note" use:reveal={{ delay: 320 }}>
          Free, in beta. No account needed — <a href="/auth/login">sign in</a> when you want it synced.
        </p>
      </header>
    {/snippet}
  </ArticleStory>

  <!-- ── Foundation (quiet) ────────────────────────────────── -->
  <section class="section section--foundation" aria-labelledby="found-h">
    <div class="foundation-inner" use:reveal>
      <h2 id="found-h">Yours, and built to last.</h2>
      <p>
        Skyreader is built on the Atmosphere, the open network behind Bluesky. Turn on Atmospheric
        sync and your subscriptions live in your own account too, where any Atmospheric app can read
        them; that copy is public, so it stays off until you choose it. Your highlights and notes
        export whenever you like.
      </p>
    </div>
  </section>

  <!-- ── Pricing (a quiet ledger, deliberately not a tier grid) ── -->
  <section class="section section--pricing" aria-labelledby="pricing-h">
    <div class="section-head" use:reveal>
      <h2 id="pricing-h">Free to read. Backed by readers.</h2>
      <p>
        Skyreader is independent software with no ads. Reading is free, and readers who want to can
        help keep it that way.
      </p>
    </div>

    <div class="plans" use:reveal={{ delay: 80 }}>
      <div class="plan">
        <div class="plan-top">
          <span class="plan-name">Free</span>
          <span class="plan-price">$0</span>
        </div>
        <p class="plan-desc">
          The whole reading room: your feeds, saves, highlights, linkblog, offline reading, and sync
          across devices. Room for {freeLimits.feeds} feeds and {freeLimits.saves} saves a month.
        </p>
      </div>

      <div class="plan">
        <div class="plan-top">
          <span class="plan-name">Supporter</span>
          {#if offerPerMonth && offer}
            <span class="plan-price">
              {offerPerMonth}<span class="plan-per">/month</span>
            </span>
          {/if}
        </div>
        <p class="plan-desc">
          Raises the limits to {supporterLimits.feeds} feeds and {supporterLimits.saves} saves a month,
          and helps keep Skyreader calm, fast, and independent.
        </p>
        {#if offer}
          <!-- The billing line names the amount actually charged, in the same
               unit as the founding comparison below it: a per-month headline
               next to a per-year "standard price" would read as a gulf that
               isn't there. -->
          <p class="plan-meta">
            {billingLine(offer)}{standardPlan
              ? `. Founding price, yours for as long as you stay subscribed; the standard price is ${formatCents(
                  standardPlan.priceAmount,
                  standardPlan.priceCurrency
                )} ${intervalNoun(offer)}.`
              : '.'}
          </p>
        {/if}
        <a class="plan-link" href="/supporter">
          More about supporting
          <Icon name="arrow-right" size={14} />
        </a>
      </div>
    </div>
  </section>

  <!-- ── Final CTA ─────────────────────────────────────────── -->
  <section class="section section--cta" aria-label="Get started">
    <div class="cta-inner" use:reveal>
      <button class="cta-primary cta-primary--lg" onclick={startReading} disabled={starting}>
        {starting ? 'Preparing your reading room…' : 'Start Reading'}
      </button>
      {#if startError}
        <p class="start-error" role="alert">{startError}</p>
      {/if}
      <p class="hero-note">
        Want the full tour first? <a href={docsUrl()} target="_blank" rel="noopener noreferrer"
          >Read the docs</a
        >.
      </p>
    </div>
  </section>
</div>

<style>
  /* ── Smooth in-page scroll for the "Follow one article" jump ── */
  :global(html:has(.landing)) {
    scroll-behavior: smooth;
  }
  @media (prefers-reduced-motion: reduce) {
    :global(html:has(.landing)) {
      scroll-behavior: auto;
    }
  }

  .landing {
    --measure: 62ch;
    --ink: var(--color-text);
    --muted: var(--color-text-secondary);
    --gold: #f5c518;
    --space-section: clamp(4.5rem, 9vw, 8.5rem);
    color: var(--ink);
    /* Pull to the full main-full width and add the page's own gutters. */
    padding-inline: clamp(1.25rem, 5vw, 3rem);
    padding-bottom: clamp(2rem, 5vw, 4rem);
    overflow-x: clip;
  }

  /* ── Reveal entrance ─────────────────────────────────────── */
  :global(.landing .reveal-init) {
    opacity: 0;
    transform: translateY(18px);
    transition:
      opacity 0.7s cubic-bezier(0.2, 0.7, 0.2, 1),
      transform 0.7s cubic-bezier(0.2, 0.7, 0.2, 1);
    will-change: opacity, transform;
  }
  :global(.landing .reveal-init.revealed) {
    opacity: 1;
    transform: none;
  }

  /* ── Hero ────────────────────────────────────────────────── */
  .hero {
    padding-block: clamp(2.5rem, 9vw, 4rem) 0;
  }
  .hero-title {
    font-size: clamp(2.5rem, 4.2vw, 3.5rem);
    font-weight: var(--weight-bold);
    line-height: 1.06;
    letter-spacing: -0.025em;
    text-wrap: balance;
  }
  .hero-title .line {
    display: block;
  }
  .hero-lead {
    margin: clamp(1.5rem, 3vw, 2rem) 0 0;
    max-width: 46ch;
    font-size: clamp(1.0625rem, 1.4vw, 1.1875rem);
    line-height: var(--leading-relaxed);
    color: var(--muted);
    text-wrap: pretty;
  }
  .hero-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    justify-content: flex-start;
    align-items: center;
    margin-top: clamp(1.75rem, 3.5vw, 2.5rem);
  }
  .hero-note {
    margin-top: 1.25rem;
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .hero-note a {
    color: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .hero-note a:hover {
    color: var(--color-primary);
  }

  /* Only ever shown when Start Reading couldn't seed the local library. */
  .start-error {
    margin-top: 0.75rem;
    font-size: var(--text-sm);
    color: var(--color-error);
  }

  /* The highlight: a gold marker stroke behind the phrase. Default state
     is fully drawn (no-JS / reduced motion); `.animate` opts into the draw. */
  .hl {
    background-color: transparent;
    background-image: linear-gradient(
      to right,
      color-mix(in srgb, var(--gold) 34%, transparent) 0,
      color-mix(in srgb, var(--gold) 34%, transparent) 100%
    );
    background-repeat: no-repeat;
    background-position: 0 84%;
    background-size: 100% 46%;
    color: inherit;
    padding-inline: 0.06em;
    border-radius: 1px;
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
  }
  .hl.animate {
    background-size: 0% 46%;
    transition: background-size 0.95s 0.35s cubic-bezier(0.16, 0.84, 0.28, 1);
  }
  .hl.animate.drawn {
    background-size: 100% 46%;
  }

  /* ── CTAs ────────────────────────────────────────────────── */
  .cta-primary {
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
    padding: 0.75rem 1.25rem;
    border-radius: 8px;
    background: var(--color-primary);
    color: #fff;
    font-weight: var(--weight-semibold);
    text-decoration: none;
    transition:
      background-color 0.18s ease,
      transform 0.18s ease;
  }
  .cta-primary:hover {
    background: var(--color-primary-dark);
  }
  .cta-primary:active {
    transform: translateY(1px);
  }
  .cta-primary--lg {
    padding: 0.9rem 1.6rem;
    font-size: var(--text-xl);
  }
  .cta-ghost {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.75rem 0.5rem;
    color: var(--ink);
    font-weight: var(--weight-medium);
    text-decoration: none;
  }
  .cta-ghost:hover {
    color: var(--color-primary);
  }
  .cta-primary:focus-visible,
  .cta-ghost:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
    border-radius: 4px;
  }

  /* ── Section scaffolding ─────────────────────────────────── */
  .section {
    padding-block: var(--space-section);
    scroll-margin-top: 4.5rem;
  }
  .section-head {
    max-width: var(--measure);
    margin: 0 auto clamp(2.5rem, 5vw, 4rem);
    text-align: center;
  }
  .section-head h2,
  .foundation-inner h2 {
    font-size: clamp(1.75rem, 3.6vw, 2.5rem);
    font-weight: var(--weight-bold);
    line-height: 1.12;
    letter-spacing: -0.02em;
    text-wrap: balance;
  }
  .section-head p {
    margin-top: 1rem;
    font-size: var(--text-xl);
    line-height: var(--leading-relaxed);
    color: var(--muted);
    text-wrap: pretty;
  }

  /* ── Foundation ──────────────────────────────────────────── */
  /* A soft, contained panel rather than a hard full-bleed band — matches the
     rounded card language of the rest of the page. */
  .foundation-inner {
    max-width: 46rem;
    margin: 0 auto;
    padding: clamp(2.5rem, 6vw, 4rem) clamp(1.75rem, 5vw, 3.5rem);
    text-align: center;
    background: var(--color-bg-secondary);
    border-radius: 20px;
  }
  .foundation-inner p {
    max-width: 52ch;
    margin: 1.1rem auto 0;
    font-size: var(--text-xl);
    line-height: var(--leading-relaxed);
    color: var(--muted);
    text-wrap: pretty;
  }

  /* ── Pricing: hairline-ruled ledger rows, matching /supporter's
     "benefits ledger" voice. Deliberately not a tier-card grid. ── */
  .plans {
    max-width: 34rem;
    margin: 0 auto;
    border-top: 1px solid var(--color-border);
  }
  .plan {
    padding: 1.5rem 0;
    border-bottom: 1px solid var(--color-border);
  }
  .plan-top {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .plan-name,
  .plan-price {
    font-size: var(--text-xl);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-tight);
  }
  .plan-price {
    font-variant-numeric: tabular-nums;
  }
  .plan-per {
    font-size: var(--text-sm);
    font-weight: var(--weight-regular);
    color: var(--muted);
  }
  .plan-desc {
    margin-top: 0.5rem;
    color: var(--muted);
    line-height: var(--leading-relaxed);
    max-width: 52ch;
    text-wrap: pretty;
  }
  .plan-meta {
    margin-top: 0.4rem;
    font-size: var(--text-sm);
    color: var(--muted);
  }
  .plan-link {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    margin-top: 0.85rem;
    color: var(--color-primary);
    font-weight: var(--weight-medium);
    font-size: var(--text-md);
    text-decoration: none;
  }
  .plan-link:hover {
    text-decoration: underline;
  }
  .plan-link:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
    border-radius: 4px;
  }

  /* ── Final CTA ───────────────────────────────────────────── */
  .section--cta {
    text-align: center;
  }
</style>
