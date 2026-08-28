<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { syncStore } from '$lib/stores/sync.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { api, type BillingProduct } from '$lib/services/api';
  import StaticPageChrome from '$lib/components/feed/StaticPageChrome.svelte';
  import { countUrlSavesThisMonth } from '$lib/utils/usage';

  let isSupporter = $derived(auth.user?.tier === 'supporter');

  // Plans mirrored from the Polar dashboard. The flow never depends on this
  // fetch: 'failed' falls back to a plain button that uses the backend's
  // default product.
  let products = $state<BillingProduct[]>([]);
  let productsState = $state<'loading' | 'loaded' | 'failed'>('loading');
  let upgradeLoading = $state(false);
  let upgradeError = $state<string | null>(null);

  async function loadProducts() {
    if (!syncStore.isOnline || auth.user?.tier === 'supporter') return;
    try {
      const { products: loaded } = await api.getBillingProducts();
      products = loaded;
      productsState = loaded.length > 0 ? 'loaded' : 'failed';
    } catch (error) {
      console.error('Failed to load billing products:', error);
      productsState = 'failed';
    }
  }

  // Ask the backend for a Polar hosted-checkout URL, then navigate to it
  // top-level (same shape as the OAuth login redirect).
  async function handleUpgrade(productId?: string) {
    upgradeError = null;
    upgradeLoading = true;
    try {
      const { url } = await api.createCheckout(productId);
      window.location.href = url;
      // Keep the buttons disabled while the navigation happens; only a failure
      // hands control back to this page.
    } catch (error) {
      console.error('Failed to start checkout:', error);
      upgradeError = "Couldn't start checkout. Try again in a moment.";
      upgradeLoading = false;
    }
  }

  function formatPrice(product: BillingProduct): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: product.priceCurrency,
      maximumFractionDigits: product.priceAmount % 100 === 0 ? 0 : 2,
    }).format(product.priceAmount / 100);
  }

  // "Save $21 a year" on the annual option, computed from the actual prices so
  // the Polar dashboard stays the single source of truth.
  const annualSavings = $derived.by(() => {
    const monthly = products.find((p) => p.interval === 'month');
    const annual = products.find((p) => p.interval === 'year');
    if (!monthly || !annual) return null;
    const savedCents = monthly.priceAmount * 12 - annual.priceAmount;
    if (savedCents <= 0) return null;
    const saved = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: annual.priceCurrency,
      maximumFractionDigits: savedCents % 100 === 0 ? 0 : 2,
    }).format(savedCents / 100);
    return `Save ${saved} a year`;
  });

  // Current usage makes the raised limits concrete. Only shown once the
  // backing store actually has data, so a not-yet-loaded store never reads
  // as "0 in use".
  let feedsInUse = $derived(subscriptionsStore.subscriptions.length);
  let savesThisMonth = $derived(countUrlSavesThisMonth(savesStore.articles));
  let hasSavesData = $derived(savesStore.articles.length > 0);

  onMount(async () => {
    if (!auth.isAuthenticated) {
      goto('/auth/login?returnUrl=/supporter');
      return;
    }
    // Refresh tier from the server; non-blocking, offline is a no-op.
    void auth.verifySession();
    if (subscriptionsStore.subscriptions.length === 0) {
      await subscriptionsStore.load();
    }
  });

  // Load plans on mount, and again when a connection comes back: loadProducts
  // is a no-op while offline, so without this a reader who opened the page
  // offline would be stuck without checkout options after reconnecting.
  $effect(() => {
    if (syncStore.isOnline && productsState === 'loading') void loadProducts();
  });
</script>

<!--
THESIS: The upgrade pitch reads like a page in the reading room, not a pricing
table. It refuses the SaaS tier-comparison grid.
OWN-WORLD: Inherits Skyreader's system: white surface, system sans, One Blue,
1px dividers, flat bordered plan buttons. No cards-of-icons, no gradients.
STORY: A free reader learns Skyreader is one person's independent software,
sees exactly what supporting raises (real numbers, their own usage beside
them), and picks monthly or annual checkout at Polar.
FIRST VIEWPORT: Title, three short sentences of honest pitch, then the
benefits ledger; plan buttons directly beneath, one screen down at most.
FORM: Precisely specified extension of the established world; shaped
directly, no concept tournament.
-->

<svelte:head>
  <title>Supporter - Skyreader</title>
</svelte:head>

<!-- Checkout happens on Polar's site with no return redirect, so refresh the
     tier when the user tabs/navigates back here and it hasn't flipped yet. -->
<svelte:window
  onfocus={() => {
    if (auth.user && auth.user.tier !== 'supporter') void auth.verifySession();
  }}
/>

<StaticPageChrome title="Supporter" />

{#if auth.user}
  <div class="supporter-page">
    {#if isSupporter}
      <header class="page-header">
        <h1>You're a Supporter</h1>
        <p class="lede">
          Thank you. Skyreader stays independent because of readers like you, and your limits are
          raised for as long as you're here.
        </p>
      </header>

      <ul class="benefits">
        <li class="benefit">
          <span class="benefit-figure">1,000 active feeds</span>
          <span class="benefit-desc">Follow widely without rationing slots.</span>
        </li>
        <li class="benefit">
          <span class="benefit-figure">1,000 saves a month</span>
          <span class="benefit-desc">Save from the web, your phone, or the extension.</span>
        </li>
        <li class="benefit">
          <span class="benefit-figure">5,000 mirrored subscriptions</span>
          <span class="benefit-desc">Headroom for everything Atmospheric sync brings along.</span>
        </li>
      </ul>

      <p class="fine-print">
        Your usage lives in <a href="/settings">Settings</a>. Billing runs through Polar; your
        receipt email links to your billing portal, where you can change or cancel anytime.
        Questions? Ask
        <a href="https://bsky.app/profile/disnetdev.com" target="_blank" rel="noopener noreferrer"
          >Tim</a
        > directly.
      </p>
    {:else}
      <header class="page-header">
        <h1>Support Skyreader</h1>
        <p class="lede">
          Skyreader is independent software, built and run by
          <a href="https://bsky.app/profile/disnetdev.com" target="_blank" rel="noopener noreferrer"
            >Tim</a
          >. No ads, no algorithm, no growth team. Supporters keep it that way
        </p>
      </header>

      <ul class="benefits">
        <li class="benefit">
          <span class="benefit-figure">1,000 active feeds</span>
          <span class="benefit-desc">Up from 100. Follow widely without rationing slots.</span>
          {#if feedsInUse > 0}
            <span class="benefit-usage">You're using {feedsInUse} today.</span>
          {/if}
        </li>
        <li class="benefit">
          <span class="benefit-figure">1,000 saves a month</span>
          <span class="benefit-desc"
            >Up from 100. Save from the web, your phone, or the extension.</span
          >
          {#if hasSavesData}
            <span class="benefit-usage">You've saved {savesThisMonth} this month.</span>
          {/if}
        </li>
        <li class="benefit">
          <span class="benefit-figure">5,000 mirrored subscriptions</span>
          <span class="benefit-desc"
            >Up from 1,000. Headroom for everything Atmospheric sync brings along.</span
          >
        </li>
        <li class="benefit">
          <span class="benefit-figure">A reader that answers to you</span>
          <span class="benefit-desc"
            >Your support goes straight to keeping Skyreader calm, fast, and sustainable.</span
          >
        </li>
      </ul>

      <section class="checkout">
        {#if !syncStore.isOnline}
          <p class="offline-note">You're offline. Becoming a Supporter needs a connection.</p>
        {:else if productsState === 'loaded'}
          <div class="plan-options">
            {#each products as product (product.id)}
              <button
                class="plan-option"
                onclick={() => handleUpgrade(product.id)}
                disabled={upgradeLoading}
              >
                <span class="plan-option-interval"
                  >{product.interval === 'year' ? 'Annual' : 'Monthly'}</span
                >
                <span class="plan-option-price">
                  {formatPrice(product)}<span class="plan-option-per"
                    >/{product.interval === 'year' ? 'year' : 'month'}</span
                  >
                </span>
                {#if product.interval === 'year' && annualSavings}
                  <span class="plan-option-note">{annualSavings}</span>
                {/if}
              </button>
            {/each}
          </div>
        {:else if productsState === 'loading'}
          <!-- Same footprint as the loaded options, so nothing jumps and no
               resting blue flashes before the plans arrive. -->
          <div class="plan-options" aria-hidden="true">
            {#each ['Monthly', 'Annual'] as interval (interval)}
              <button class="plan-option" disabled>
                <span class="plan-option-interval">{interval}</span>
                <span class="plan-option-price">…</span>
              </button>
            {/each}
          </div>
        {:else}
          <button class="btn btn-primary" onclick={() => handleUpgrade()} disabled={upgradeLoading}>
            {upgradeLoading ? 'Opening checkout…' : 'Become a Supporter'}
          </button>
        {/if}
        {#if upgradeError}
          <p class="checkout-error">{upgradeError}</p>
        {/if}
        <p class="fine-print">
          Checkout is handled by <a
            href="https://polar.sh"
            target="_blank"
            rel="noopener noreferrer">Polar</a
          >. Cancel anytime; everything you've read and saved stays yours.
        </p>
      </section>
    {/if}
  </div>
{/if}

<style>
  .supporter-page {
    max-width: 640px;
    margin: 0 auto;
    /* Clear the floating page-header pill (matches the Discover page). */
    padding: 3.5rem 1rem 4rem;
  }

  @media (max-width: 1000px) {
    .supporter-page {
      padding-top: 0.5rem;
      padding-bottom: calc(var(--bottom-bar-height) + var(--safe-area-bottom) + 4rem);
    }
  }

  .page-header {
    margin-bottom: 2rem;
  }

  h1 {
    font-size: var(--text-2xl);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-tight);
    margin: 0 0 0.75rem;
  }

  .lede {
    font-size: var(--text-base);
    line-height: var(--leading-relaxed);
    color: var(--color-text);
    max-width: 60ch;
    margin: 0;
  }

  .lede a {
    color: var(--color-primary);
    text-decoration: none;
  }

  .lede a:hover {
    text-decoration: underline;
  }

  /* The benefits ledger: quiet hairline-ruled rows, not icon cards. The
     number is the headline of each row. */
  .benefits {
    list-style: none;
    margin: 0 0 2.5rem;
    padding: 0;
    border-top: 1px solid var(--color-border);
  }

  .benefit {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 1rem 0;
    border-bottom: 1px solid var(--color-border);
  }

  .benefit-figure {
    font-size: var(--text-xl);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-tight);
  }

  .benefit-desc {
    font-size: var(--text-md);
    line-height: var(--leading-normal);
    color: var(--color-text-secondary);
    max-width: 60ch;
  }

  .benefit-usage {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    font-variant-numeric: tabular-nums;
  }

  /* Flat option buttons per the design system: 1px Divider borders, tonal
     hover, One Blue reserved for the savings note and the focus ring. */
  .plan-options {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
  }

  .plan-option {
    flex: 1 1 10rem;
    max-width: 16rem;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.125rem;
    padding: 0.875rem 1rem;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    cursor: pointer;
    text-align: left;
    font: inherit;
    color: var(--color-text);
    transition:
      border-color 0.2s ease,
      background-color 0.2s ease;
  }

  .plan-option:hover:not(:disabled) {
    border-color: var(--color-primary);
    background: var(--color-bg-secondary);
  }

  .plan-option:focus-visible {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.1);
  }

  .plan-option:disabled {
    opacity: 0.6;
    cursor: default;
  }

  @media (prefers-reduced-motion: reduce) {
    .plan-option {
      transition: none;
    }
  }

  .plan-option-interval {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-text-secondary);
  }

  .plan-option-price {
    font-size: var(--text-xl);
    font-weight: var(--weight-semibold);
    color: var(--color-text);
  }

  .plan-option-per {
    font-size: var(--text-sm);
    font-weight: 400;
    color: var(--color-text-secondary);
  }

  .plan-option-note {
    font-size: var(--text-sm);
    color: var(--color-primary);
  }

  .offline-note {
    font-size: var(--text-md);
    color: var(--color-text-secondary);
    margin: 0;
  }

  .checkout-error {
    font-size: var(--text-md);
    color: var(--color-error);
    margin: 0.75rem 0 0;
  }

  .fine-print {
    margin: 1.25rem 0 0;
    font-size: var(--text-sm);
    line-height: var(--leading-normal);
    color: var(--color-text-secondary);
    max-width: 60ch;
  }

  .fine-print a {
    color: var(--color-primary);
    text-decoration: none;
  }

  .fine-print a:hover {
    text-decoration: underline;
  }
</style>
