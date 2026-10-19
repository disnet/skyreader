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
  import type { Component } from 'svelte';

  let starting = $state(false);
  let startError = $state<string | null>(null);
  // Which Start Reading button was pressed, so its error shows beside it.
  let startedFrom = $state<'top' | 'end'>('top');

  // Start Reading: seed the curated starter channels into this browser and open
  // the reader. No account, no network writes — the subscription rows live only
  // in IndexedDB until the reader signs in.
  async function startReading(from: typeof startedFrom) {
    if (starting) return;
    startedFrom = from;
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

  // The app shot is most of this page's script (the real cards, popover and
  // Discussion panel), so it loads after the headline and the way in have
  // painted. Its placeholder holds the same space, so nothing jumps.
  let AppShowcase = $state<Component | null>(null);

  onMount(() => {
    import('$lib/components/landing/AppShowcase.svelte').then((m) => (AppShowcase = m.default));

    // Failure is silent by design; see the pricing note.
    api
      .getBillingProducts()
      .then(({ products }) => (plans = products))
      .catch(() => {});

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
  <section class="hero" aria-labelledby="hero-h">
    <h1 id="hero-h">Read everything you follow.<br /> Keep what matters.</h1>
    <p class="lede">
      Blogs, Bluesky, YouTube and the articles you save, in one calm reader, with highlights, notes
      and the conversation around every piece.
    </p>
    <div class="hero-actions">
      <button class="cta-primary" onclick={() => startReading('top')} disabled={starting}>
        {starting ? 'Preparing your reading room…' : 'Start Reading'}
        {#if !starting}<Icon name="arrow-right" size={16} />{/if}
      </button>
      <a class="cta-secondary" href="/auth/login">Sign in</a>
    </div>
    {#if startError && startedFrom === 'top'}
      <p class="start-error" role="alert">{startError}</p>
    {/if}
    <p class="fine">Free to read, no account needed.</p>
  </section>

  <div class="shot">
    {#if AppShowcase}
      <AppShowcase />
    {:else}
      <div class="shot-placeholder" aria-hidden="true"></div>
    {/if}
  </div>

  <!-- ── Features ──────────────────────────────────────────── -->
  <section class="section" aria-labelledby="features-h">
    <div class="section-head" use:reveal>
      <h2 id="features-h">Reading that adds up.</h2>
      <p>
        Everything you follow in one place, and what you take from it kept where you can find it.
      </p>
    </div>
    <ul class="features" use:reveal={{ delay: 80 }}>
      <li>
        <Icon name="inbox" size={20} />
        <h3>Read in one calm place</h3>
        <p>
          RSS and Atom, Atmosphere publications, Bluesky likes and bookmarks, YouTube channels, with
          transcripts for videos you save. Newsletters by email, PDFs and EPUBs with Supporter. In
          order, no algorithm.
        </p>
      </li>
      <li>
        <Icon name="highlighter" size={20} />
        <h3>Mark what matters</h3>
        <p>
          Highlights and margin notes on any source, a PDF's original pages included, and a review
          that brings them back.
        </p>
      </li>
      <li>
        <Icon name="shelf" size={20} />
        <h3>Keep it as you read it</h3>
        <p>
          A snapshot of every save, taken the moment you keep it, with the Wayback Machine as a
          fallback.
        </p>
      </li>
      <li>
        <Icon name="activity" size={20} />
        <h3>Read alongside others</h3>
        <p>
          The discussion around an article from Bluesky and Semble, and linkblogs from people you
          follow.
        </p>
      </li>
      <li>
        <Icon name="bookmark" size={20} />
        <h3>Save from anywhere</h3>
        <p>
          A browser extension for Chrome and Firefox, your phone's share sheet once Skyreader is
          installed, and offline reading for when the signal drops.
        </p>
      </li>
      <li>
        <Icon name="share" size={20} />
        <h3>Take it with you</h3>
        <p>
          Export saves, highlights and notes as Markdown or BibTeX, DOIs included. Exports are free.
        </p>
      </li>
    </ul>
  </section>

  <!-- ── Pricing (a quiet ledger, deliberately not a tier grid) ── -->
  <section class="section" aria-labelledby="pricing-h">
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
          adds newsletters and PDFs, and helps keep Skyreader calm, fast, and independent.
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
  <section class="section section--cta" aria-labelledby="cta-h">
    <div class="cta-inner" use:reveal>
      <h2 id="cta-h">Start with a few good sources.</h2>
      <p>No account needed to try it. Sign in when you want it on every device.</p>
      <button
        class="cta-primary cta-primary--lg"
        onclick={() => startReading('end')}
        disabled={starting}
      >
        {starting ? 'Preparing your reading room…' : 'Start Reading'}
        {#if !starting}<Icon name="arrow-right" size={18} />{/if}
      </button>
      {#if startError && startedFrom === 'end'}
        <p class="start-error" role="alert">{startError}</p>
      {/if}
      <p class="fine">
        Want the full tour first? <a href={docsUrl()} target="_blank" rel="noopener noreferrer"
          >Read the docs</a
        >.
      </p>
    </div>
  </section>
</div>

<style>
  .landing {
    --ink: var(--color-text);
    --muted: var(--color-text-secondary);
    --space-section: clamp(4.5rem, 9vw, 7.5rem);
    color: var(--ink);
    padding-inline: clamp(1rem, 4vw, 3.5rem);
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

  /* ── Hero: the claim, the way in, then the app itself ──────── */
  .hero {
    max-width: 52rem;
    margin: 0 auto;
    padding-block: clamp(2.5rem, 7vh, 5rem) clamp(2rem, 4vw, 3rem);
    text-align: center;
  }
  .hero h1 {
    font-size: clamp(2.5rem, 5.5vw, 4.5rem);
    font-weight: 800;
    line-height: 1.02;
    letter-spacing: -0.035em;
    text-wrap: balance;
  }
  .lede {
    max-width: 38rem;
    margin: 1.25rem auto 0;
    font-size: clamp(1.125rem, 1.6vw, 1.3125rem);
    line-height: var(--leading-relaxed);
    color: var(--muted);
    text-wrap: pretty;
  }
  .hero-actions {
    display: flex;
    justify-content: center;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-top: 2rem;
  }
  .hero .fine {
    margin-top: 0.85rem;
  }
  .shot {
    max-width: 76rem;
    margin: 0 auto;
    padding-bottom: var(--space-section);
  }

  /* Same box as AppShowcase's frame, its step row and its sample label. */
  .shot-placeholder {
    height: calc(clamp(30rem, 62vh, 42rem) + 7.85rem);
  }
  @media (max-width: 700px) {
    .shot-placeholder {
      height: calc(32rem + 6.7rem);
    }
  }

  .fine {
    font-size: var(--text-sm);
    color: var(--muted);
  }
  .fine a {
    color: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .fine a:hover {
    color: var(--color-primary);
  }

  /* Only ever shown when Start Reading couldn't seed the local library. */
  .start-error {
    margin-top: 0.75rem;
    font-size: var(--text-sm);
    color: var(--color-error);
  }

  /* ── CTAs ────────────────────────────────────────────────── */
  .cta-primary,
  .cta-secondary {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1.25rem;
    border-radius: 8px;
    font-weight: var(--weight-semibold);
    text-decoration: none;
    transition:
      background-color 0.18s ease,
      transform 0.18s ease;
  }
  .cta-primary {
    border: none;
    background: var(--color-primary);
    color: #fff;
  }
  .cta-primary:hover {
    background: var(--color-primary-dark);
  }
  .cta-secondary {
    border: 1px solid var(--color-border);
    color: var(--ink);
  }
  .cta-secondary:hover {
    background: var(--color-bg-secondary);
  }
  .cta-primary:active,
  .cta-secondary:active {
    transform: translateY(1px);
  }
  .cta-primary--lg {
    padding: 0.9rem 1.6rem;
    font-size: var(--text-xl);
  }
  .cta-primary:focus-visible,
  .cta-secondary:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  /* ── Sections below the shot ─────────────────────────────── */
  .section {
    max-width: 68rem;
    margin: 0 auto;
    padding-block: var(--space-section);
    border-top: 1px solid var(--color-border);
  }
  .section-head {
    max-width: 40rem;
    margin-bottom: clamp(2rem, 4vw, 3rem);
  }
  .section h2 {
    font-size: clamp(2rem, 4vw, 3.25rem);
    font-weight: 800;
    line-height: 1.05;
    letter-spacing: -0.03em;
    text-wrap: balance;
  }
  .section-head p,
  .cta-inner > p:not(.fine):not(.start-error) {
    margin-top: 1rem;
    font-family: var(--font-literata);
    font-size: var(--text-xl);
    line-height: var(--leading-relaxed);
    color: var(--muted);
    text-wrap: pretty;
  }

  .features {
    list-style: none;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    column-gap: clamp(1.25rem, 3vw, 2.5rem);
    border-top: 1px solid var(--color-border);
  }
  .features li {
    padding: 1.4rem 0 1.5rem;
    border-bottom: 1px solid var(--color-border);
    min-width: 0;
    color: var(--color-primary);
  }
  .features h3 {
    margin-top: 0.6rem;
    font-size: var(--text-2xl);
    font-weight: var(--weight-bold);
    line-height: 1.2;
    letter-spacing: -0.01em;
    color: var(--ink);
  }
  .features p {
    margin-top: 0.4rem;
    color: var(--muted);
    line-height: var(--leading-relaxed);
  }

  /* ── Pricing: hairline-ruled ledger rows, matching /supporter's
     "benefits ledger" voice. Deliberately not a tier-card grid. ── */
  .plans {
    max-width: 40rem;
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
  .cta-inner > p:not(.fine):not(.start-error) {
    max-width: 40rem;
    margin-bottom: 1.75rem;
  }
  .cta-inner .fine {
    margin-top: 1.25rem;
  }

  /* ── Responsive ──────────────────────────────────────────── */
  @media (max-width: 800px) {
    .features {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
