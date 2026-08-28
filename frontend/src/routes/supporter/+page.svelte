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
  import Icon from '$lib/components/Icon.svelte';

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

  function formatCents(cents: number, currency: string): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
    }).format(cents / 100);
  }

  // Both options are framed as a monthly price; the annual plan's headline is
  // its per-month equivalent, with the real charge named on the billing line.
  function monthlyPrice(product: BillingProduct): string {
    const cents =
      product.interval === 'year' ? Math.round(product.priceAmount / 12) : product.priceAmount;
    return formatCents(cents, product.priceCurrency);
  }

  // The actual charge cadence, always stating the true billed amount so the
  // per-month framing never hides what the card is charged.
  function billingLine(product: BillingProduct): string {
    return product.interval === 'year'
      ? `${formatCents(product.priceAmount, product.priceCurrency)} billed annually`
      : 'Billed monthly';
  }

  // Polar may carry two live annual products at once: the standard price and
  // a discounted founding-supporter price. The card always offers the cheapest
  // annual product; the dearest one becomes the struck-through "normally"
  // reference. When the founding product is archived, both collapse to the one
  // standard product and the founding framing disappears on its own.
  const monthlyProduct = $derived(products.find((p) => p.interval === 'month'));
  const yearProducts = $derived(products.filter((p) => p.interval === 'year'));
  const yearlyOffer = $derived(
    yearProducts.length > 0
      ? yearProducts.reduce((a, b) => (a.priceAmount <= b.priceAmount ? a : b))
      : undefined
  );
  const yearlyCompareAt = $derived.by(() => {
    if (!yearlyOffer || yearProducts.length < 2) return null;
    const dearest = yearProducts.reduce((a, b) => (a.priceAmount >= b.priceAmount ? a : b));
    return dearest.priceAmount > yearlyOffer.priceAmount ? dearest : null;
  });

  // "Save $45 a year", computed against the annual price actually offered, so
  // the Polar dashboard stays the single source of truth.
  const annualSavings = $derived.by(() => {
    if (!monthlyProduct || !yearlyOffer) return null;
    const savedCents = monthlyProduct.priceAmount * 12 - yearlyOffer.priceAmount;
    if (savedCents <= 0) return null;
    return `Save ${formatCents(savedCents, yearlyOffer.priceCurrency)} a year`;
  });

  // One card, two cadences: the toggle picks which Polar product the CTA
  // checks out. Yearly is the default, as the anchor of the monthly-priced,
  // billed-annually framing.
  let billingInterval = $state<'year' | 'month'>('year');
  const selectedProduct = $derived(billingInterval === 'year' ? yearlyOffer : monthlyProduct);

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
  onpageshow={(e) => {
    // Backing out of Polar's checkout restores this page from the bfcache with
    // `upgradeLoading` still true (set on the way out), leaving the CTA
    // disabled. A restored page never has a checkout in flight, so reset it.
    if (e.persisted) {
      upgradeLoading = false;
      upgradeError = null;
    }
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
          >. No ads, no algorithm, no growth team. Supporters keep it that way.
        </p>
      </header>

      <section class="checkout">
        <div class="plan-card">
          <div class="plan-card-top">
            <span class="plan-card-name">Supporter</span>
            {#if productsState === 'loaded'}
              <div class="plan-toggle" role="group" aria-label="Billing cadence">
                <button
                  class="plan-toggle-option"
                  class:selected={billingInterval === 'year'}
                  aria-pressed={billingInterval === 'year'}
                  onclick={() => (billingInterval = 'year')}
                >
                  Yearly
                </button>
                <button
                  class="plan-toggle-option"
                  class:selected={billingInterval === 'month'}
                  aria-pressed={billingInterval === 'month'}
                  onclick={() => (billingInterval = 'month')}
                >
                  Monthly
                </button>
              </div>
            {/if}
          </div>

          {#if selectedProduct}
            <div class="plan-card-price-row">
              <span class="plan-card-price">
                {monthlyPrice(selectedProduct)}<span class="plan-card-per">/month</span>
              </span>
              <span class="plan-card-billing">
                {#if billingInterval === 'year' && yearlyCompareAt}
                  <!-- The spoken version of the strike lives in the note below,
                       so screen readers hear "normally $120 a year" in words. -->
                  <s class="plan-card-compare" aria-hidden="true"
                    >{formatCents(yearlyCompareAt.priceAmount, yearlyCompareAt.priceCurrency)}</s
                  >
                {/if}
                {billingLine(selectedProduct)}
              </span>
            </div>
            {#if billingInterval === 'year' && yearlyCompareAt}
              <p class="plan-card-savings">
                Founding supporter price, normally {formatCents(
                  yearlyCompareAt.priceAmount,
                  yearlyCompareAt.priceCurrency
                )} a year. Thank you for being early.
              </p>
            {:else if annualSavings}
              <p class="plan-card-savings">{annualSavings} with annual billing</p>
            {/if}
          {:else if productsState === 'loading'}
            <p class="plan-card-loading">Loading plans…</p>
          {/if}

          <ul class="plan-features">
            <li>
              <span class="feature-check"><Icon name="check" size={16} strokeWidth={2.5} /></span>
              <span class="feature-text">
                1,000 active feeds
                <span class="feature-sub"
                  >up from 100{feedsInUse > 0 ? `, ${feedsInUse} in use today` : ''}</span
                >
              </span>
            </li>
            <li>
              <span class="feature-check"><Icon name="check" size={16} strokeWidth={2.5} /></span>
              <span class="feature-text">
                1,000 saves a month
                <span class="feature-sub"
                  >up from 100{hasSavesData ? `, ${savesThisMonth} saved this month` : ''}</span
                >
              </span>
            </li>
            <li>
              <span class="feature-check"><Icon name="check" size={16} strokeWidth={2.5} /></span>
              <span class="feature-text">
                5,000 mirrored subscriptions
                <span class="feature-sub">headroom for everything Atmospheric sync brings</span>
              </span>
            </li>
            <li>
              <span class="feature-check"><Icon name="check" size={16} strokeWidth={2.5} /></span>
              <span class="feature-text">
                An independent, ad-free Skyreader
                <span class="feature-sub">your support keeps it calm, fast, and sustainable</span>
              </span>
            </li>
          </ul>

          <button
            class="btn btn-primary plan-card-cta"
            onclick={() => handleUpgrade(selectedProduct?.id)}
            disabled={upgradeLoading || !syncStore.isOnline || productsState === 'loading'}
          >
            {upgradeLoading ? 'Opening checkout…' : 'Become a Supporter'}
          </button>
          {#if !syncStore.isOnline}
            <p class="offline-note">You're offline. Becoming a Supporter needs a connection.</p>
          {/if}
          {#if upgradeError}
            <p class="checkout-error">{upgradeError}</p>
          {/if}
        </div>
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

  /* The one plan card: flat per the system — 1px Divider border, Surface
     background, no resting shadow. One Blue is reserved for the savings note,
     the CTA, and focus. */
  .plan-card {
    border: 1px solid var(--color-border);
    border-radius: 8px;
    padding: 1.25rem;
  }

  .plan-card-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .plan-card-name {
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
  }

  /* Segmented cadence toggle: pill container on Sunken, selected segment
     lifted to Surface with a Divider stroke. Transparent border keeps the
     unselected segment the same size. */
  .plan-toggle {
    display: inline-flex;
    padding: 2px;
    background: var(--color-bg-secondary);
    border-radius: 999px;
  }

  .plan-toggle-option {
    border: 1px solid transparent;
    background: transparent;
    padding: 0.25rem 0.75rem;
    border-radius: 999px;
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-text-secondary);
    cursor: pointer;
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }

  .plan-toggle-option.selected {
    background: var(--color-bg);
    border-color: var(--color-border);
    color: var(--color-text);
  }

  .plan-toggle-option:focus-visible {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.1);
  }

  @media (prefers-reduced-motion: reduce) {
    .plan-toggle-option {
      transition: none;
    }
  }

  .plan-card-price-row {
    display: flex;
    align-items: baseline;
    gap: 0.625rem;
    flex-wrap: wrap;
    margin-top: 0.875rem;
  }

  .plan-card-price {
    font-size: var(--text-2xl);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-tight);
  }

  .plan-card-per {
    font-size: var(--text-sm);
    font-weight: var(--weight-regular);
    color: var(--color-text-secondary);
  }

  .plan-card-billing {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .plan-card-compare {
    text-decoration: line-through;
    margin-right: 0.125rem;
  }

  .plan-card-savings {
    font-size: var(--text-sm);
    color: var(--color-primary);
    margin: 0.375rem 0 0;
  }

  .plan-card-loading {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    margin: 0.875rem 0 0;
  }

  .plan-features {
    list-style: none;
    margin: 1rem 0;
    padding: 1rem 0 0;
    border-top: 1px solid var(--color-border);
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  .plan-features li {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
  }

  .feature-check {
    color: var(--color-text-secondary);
    flex-shrink: 0;
    margin-top: 2px;
  }

  .feature-text {
    font-size: var(--text-md);
    line-height: var(--leading-normal);
  }

  .feature-sub {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .plan-card-cta {
    width: 100%;
    padding: 0.625rem 1rem;
  }

  .plan-card-cta:disabled {
    opacity: 0.6;
    cursor: default;
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
