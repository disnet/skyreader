<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { syncStore } from '$lib/stores/sync.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { api, type BillingProduct } from '$lib/services/api';
  import {
    believerPlan,
    billingLine,
    cheapest,
    compareAt,
    formatCents,
    monthlyPrice,
    supporterPlans,
  } from '$lib/utils/pricing';
  import { freeLimits, supporterLimits } from '$lib/constants/tierLimits';
  import StaticPageChrome from '$lib/components/feed/StaticPageChrome.svelte';
  import { countUrlSavesThisMonth } from '$lib/utils/usage';
  import { isPaidTier, isGrantedSupporter, hasGrantFallback } from '$lib/utils/tier';
  import Icon from '$lib/components/Icon.svelte';

  // Three states, not two. A paid supporter has a Polar customer and a billing
  // portal; a granted supporter (everyone who was given the tier before paid
  // plans existed) has neither, keeps their access for good, and is offered a
  // paid plan only as something optional.
  let isPaidSupporter = $derived(isPaidTier(auth.user));
  let grantedSupporter = $derived(isGrantedSupporter(auth.user));
  let keepsGrantIfCancelled = $derived(hasGrantFallback(auth.user));

  // Plans mirrored from the Polar dashboard. The flow never depends on this
  // fetch: 'failed' falls back to a plain button that uses the backend's
  // default product.
  let products = $state<BillingProduct[]>([]);
  let productsState = $state<'loading' | 'loaded' | 'failed'>('loading');
  let upgradeLoading = $state(false);
  let upgradeError = $state<string | null>(null);

  async function loadProducts() {
    // Granted supporters still need plans: paying is offered to them as an
    // option. Only someone already on a paid plan has nothing to buy here.
    if (!syncStore.isOnline || isPaidSupporter) return;
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
    // Checkout needs an account (the DID is Polar's customer key), but the
    // pitch itself doesn't: a signed-out reader or a guest goes through
    // sign-in and lands back here to finish.
    if (!auth.isAuthenticated) {
      goto('/auth/login?returnUrl=/supporter');
      return;
    }
    upgradeError = null;
    upgradeLoading = true;
    checkoutStarted = true;
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

  // Polar's hosted customer portal, same top-level navigation shape as
  // checkout. A failure usually means Polar has no customer for this DID
  // (admin-granted tier); the receipt email is the fallback path.
  let portalLoading = $state(false);
  let portalError = $state<string | null>(null);

  async function openBillingPortal() {
    portalError = null;
    portalLoading = true;
    try {
      const { url } = await api.createBillingPortal();
      window.location.href = url;
    } catch (error) {
      console.error('Failed to open billing portal:', error);
      portalError = "Couldn't open the billing portal. Your receipt email also links to it.";
      portalLoading = false;
    }
  }

  // Believer is patronage, not a competing plan: every Believer product is
  // pulled out before any supporter-plan logic runs, so a patronage price can
  // never leak into the founding compare-at or savings math below. The landing
  // page reads the same list through the same helpers (utils/pricing.ts).
  const believerProduct = $derived(believerPlan(products));
  const supporterProducts = $derived(supporterPlans(products));

  const monthProducts = $derived(supporterProducts.filter((p) => p.interval === 'month'));
  const yearProducts = $derived(supporterProducts.filter((p) => p.interval === 'year'));
  const monthlyProduct = $derived(cheapest(monthProducts));
  const yearlyOffer = $derived(cheapest(yearProducts));
  const monthlyCompareAt = $derived(compareAt(monthProducts, monthlyProduct));
  const yearlyCompareAt = $derived(compareAt(yearProducts, yearlyOffer));

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
  const selectedCompareAt = $derived(
    billingInterval === 'year' ? yearlyCompareAt : monthlyCompareAt
  );
  // The lede's founding line and the card note both key off this, so the
  // framing appears and disappears together with the founding products.
  const foundingActive = $derived(Boolean(yearlyCompareAt || monthlyCompareAt));

  // Current usage makes the raised limits concrete. Only shown once the
  // backing store actually has data, so a not-yet-loaded store never reads
  // as "0 in use".
  let feedsInUse = $derived(subscriptionsStore.subscriptions.length);
  let savesThisMonth = $derived(countUrlSavesThisMonth(savesStore.articles));
  let hasSavesData = $derived(savesStore.articles.length > 0);

  // Polar's success redirect lands on /supporter?checkout=success. Payment is
  // done at that point, but the tier flip rides the webhook and can trail the
  // redirect — so the param means "confirming", never proof of entitlement.
  // Poll the session until the webhook lands, then let the page's normal
  // isSupporter branch take over.
  let confirming = $state(false);

  // Waits for the paid source, not just the tier: a granted supporter who
  // chooses to start paying is already tier 'supporter', so only tier_source
  // flipping to a Polar one actually confirms their checkout.
  async function confirmPurchase() {
    confirming = true;
    for (let i = 0; i < 15 && !isPaidTier(auth.user); i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await auth.verifySession();
    }
    // Webhook still hasn't landed after ~30s: fall back to the pitch page,
    // but say why, so a paid-up reader isn't staring at a buy button.
    confirmSlow = !isPaidTier(auth.user);
    confirming = false;
  }

  let confirmSlow = $state(false);
  // Set once checkout is opened, so the focus refresh below only chases a
  // purchase that's actually in flight.
  let checkoutStarted = $state(false);

  onMount(async () => {
    // Signed-out visitors and guests see the pitch too (the landing page links
    // here; prices are public). Only the account-bound work below needs a
    // session.
    if (!auth.isAuthenticated) return;
    if (new URL(window.location.href).searchParams.get('checkout') === 'success') {
      // Strip the param so a reload or bookmark doesn't re-enter confirming.
      window.history.replaceState(window.history.state, '', '/supporter');
      if (!isPaidTier(auth.user)) void confirmPurchase();
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

<!-- Checkout normally redirects back to ?checkout=success (handled in onMount),
     but a buyer can also tab back mid-checkout — so still refresh the tier when
     the window regains focus and it hasn't flipped yet. -->
<svelte:window
  onfocus={() => {
    // A free reader's tier can flip at any time; a granted supporter's only
    // moves if they opened checkout, so don't poll the ones who never did.
    if (!auth.user || isPaidSupporter) return;
    if (checkoutStarted || auth.user.tier !== 'supporter') void auth.verifySession();
  }}
  onpageshow={(e) => {
    // Backing out of Polar's checkout restores this page from the bfcache with
    // `upgradeLoading` still true (set on the way out), leaving the CTA
    // disabled. A restored page never has a checkout in flight, so reset it.
    if (e.persisted) {
      upgradeLoading = false;
      upgradeError = null;
      portalLoading = false;
      portalError = null;
    }
  }}
/>

<!-- App navigation chrome belongs to the app: a signed-out visitor gets the
     marketing layout's own header and footer instead. -->
{#if auth.isInApp}
  <StaticPageChrome title="Supporter" />
{/if}

{#snippet benefitsLedger()}
  <ul class="benefits">
    <li class="benefit">
      <span class="benefit-figure">{supporterLimits.feeds} active feeds</span>
      <span class="benefit-desc">Follow widely without rationing slots.</span>
    </li>
    <li class="benefit">
      <span class="benefit-figure">{supporterLimits.saves} saves a month</span>
      <span class="benefit-desc">Save from the web, your phone, or the extension.</span>
    </li>
    <li class="benefit">
      <span class="benefit-figure">{supporterLimits.mirrored} mirrored subscriptions</span>
      <span class="benefit-desc">Headroom for everything Atmospheric sync brings along.</span>
    </li>
  </ul>
{/snippet}

{#snippet planOptions(ctaLabel: string, showFeatures: boolean)}
  <section class="checkout">
    <div class="plan-card">
      <div class="plan-card-top">
        <!-- Matches the Polar product name, so checkout and the receipt say the
             same thing the card did. Post-purchase surfaces still say plain
             "Supporter": founding names the price, not the tier. -->
        <span class="plan-card-name">{selectedCompareAt ? 'Founding Supporter' : 'Supporter'}</span>
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
            {#if selectedCompareAt}
              <!-- The spoken version of the strike lives in the note below,
                       so screen readers hear "normally $99 a year" in words. -->
              <s class="plan-card-compare" aria-hidden="true"
                >{formatCents(selectedCompareAt.priceAmount, selectedCompareAt.priceCurrency)}</s
              >
            {/if}
            {billingLine(selectedProduct)}
          </span>
        </div>
        {#if selectedCompareAt}
          <p class="plan-card-savings">
            Founding price; the standard price is {formatCents(
              selectedCompareAt.priceAmount,
              selectedCompareAt.priceCurrency
            )}
            {billingInterval === 'year' ? 'a year' : 'a month'}. Keep the founding price for as long
            as you're subscribed.
          </p>
        {:else if annualSavings}
          <p class="plan-card-savings">{annualSavings} with annual billing</p>
        {/if}
      {:else if productsState === 'loading'}
        <p class="plan-card-loading">Loading plans…</p>
      {/if}

      {#if showFeatures}
        <ul class="plan-features">
          <li>
            <span class="feature-check"><Icon name="check" size={16} strokeWidth={2.5} /></span>
            <span class="feature-text">
              {supporterLimits.feeds} active feeds
              <span class="feature-sub"
                >up from {freeLimits.feeds}{feedsInUse > 0
                  ? `, ${feedsInUse} in use today`
                  : ''}</span
              >
            </span>
          </li>
          <li>
            <span class="feature-check"><Icon name="check" size={16} strokeWidth={2.5} /></span>
            <span class="feature-text">
              {supporterLimits.saves} saves a month
              <span class="feature-sub"
                >up from {freeLimits.saves}{hasSavesData
                  ? `, ${savesThisMonth} saved this month`
                  : ''}</span
              >
            </span>
          </li>
          <li>
            <span class="feature-check"><Icon name="check" size={16} strokeWidth={2.5} /></span>
            <span class="feature-text">
              {supporterLimits.mirrored} mirrored subscriptions
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
      {/if}

      <button
        class="btn btn-primary plan-card-cta"
        onclick={() => handleUpgrade(selectedProduct?.id)}
        disabled={upgradeLoading || !syncStore.isOnline || productsState === 'loading'}
      >
        {upgradeLoading ? 'Opening checkout…' : ctaLabel}
      </button>
      {#if !syncStore.isOnline}
        <p class="offline-note">You're offline. Becoming a Supporter needs a connection.</p>
      {/if}
      {#if upgradeError}
        <p class="checkout-error">{upgradeError}</p>
      {/if}
    </div>

    <!-- Believer: a ruled patronage row in the ledger's voice, deliberately
             not a second card so the page never becomes a tier grid. -->
    {#if believerProduct}
      <div class="believer">
        <div class="believer-top">
          <span class="believer-name">Believer</span>
          <span class="believer-price">
            {formatCents(believerProduct.priceAmount, believerProduct.priceCurrency)}<span
              class="believer-per">/year</span
            >
          </span>
        </div>
        <p class="believer-desc">
          Fund the future of reading on the Atmosphere. Everything in Supporter plus early access to
          new features.
        </p>
        <button
          class="btn btn-secondary believer-cta"
          onclick={() => handleUpgrade(believerProduct.id)}
          disabled={upgradeLoading || !syncStore.isOnline}
        >
          Become a Believer
        </button>
      </div>
    {/if}
    <p class="fine-print">
      Checkout is handled by <a href="https://polar.sh" target="_blank" rel="noopener noreferrer"
        >Polar</a
      >.
    </p>
  </section>
{/snippet}

{#if !auth.isLoading}
  <div class="supporter-page" class:standalone={!auth.isInApp}>
    {#if isPaidSupporter}
      <header class="page-header">
        <h1>You're a Supporter</h1>
        <p class="lede">
          Thank you. Skyreader stays independent because of readers like you, and your limits are
          raised for as long as you're here.
        </p>
      </header>

      {@render benefitsLedger()}

      <button
        class="btn btn-secondary manage-billing"
        onclick={openBillingPortal}
        disabled={portalLoading || !syncStore.isOnline}
      >
        {portalLoading ? 'Opening portal…' : 'Manage billing'}
      </button>
      {#if portalError}
        <p class="checkout-error">{portalError}</p>
      {/if}

      {#if keepsGrantIfCancelled}
        <p class="fine-print">
          You had Supporter access before Skyreader had paid plans, and that still stands: if you
          ever cancel, your account goes back to the access you were given, not to the free tier.
        </p>
      {/if}

      <p class="fine-print">
        Your usage lives in <a href="/settings">Settings</a>. Manage billing opens your Polar
        portal, where you can change plans or cancel anytime. Questions? Email support at
        <a href="mailto:support@skyreader.app">support@skyreader.app</a>.
      </p>
    {:else if confirming}
      <header class="page-header">
        <h1>Thank you</h1>
        <p class="lede">Payment received. Confirming your purchase…</p>
      </header>
    {:else if grantedSupporter}
      <!-- Supporter access given by hand, before Skyreader charged for
           anything. This branch never sells: it confirms the access is theirs
           to keep, and only then mentions that paying is possible. -->
      <header class="page-header">
        <h1>You're a Supporter</h1>
        <p class="lede">
          You've had Supporter access since before Skyreader had paid plans. It stays yours, at no
          charge, for as long as Skyreader runs. Thank you for backing this early.
        </p>
      </header>

      {@render benefitsLedger()}

      {#if confirmSlow}
        <p class="fine-print confirm-slow">
          Your payment went through, but confirmation is taking longer than usual. This page updates
          on its own once it lands; your receipt email has the details.
        </p>
      {/if}

      <section class="optional-paid">
        <h2 class="optional-heading">Paying is optional</h2>
        <p class="optional-intro">
          Nothing changes if you leave things as they are. If you'd rather chip in, a paid plan
          helps keep Skyreader independent, and your Supporter access is still here if you ever stop
          paying.
        </p>
        {@render planOptions('Start a paid plan', false)}
      </section>

      <p class="fine-print">
        Your usage lives in <a href="/settings">Settings</a>. Questions? Email support at
        <a href="mailto:support@skyreader.app">support@skyreader.app</a>.
      </p>
    {:else}
      <header class="page-header">
        <h1>Support Skyreader</h1>
        <p class="lede">
          Skyreader is independent software, built and run by Tim (<a
            href="https://bsky.app/profile/disnetdev.com"
            target="_blank"
            rel="noopener noreferrer">@disnetdev.com</a
          >). No ads, no growth team, just me.
        </p>
        {#if foundingActive}
          <p class="lede">
            Plans are at founding prices while Skyreader is young. The price you join at is yours
            for as long as you stay subscribed.
          </p>
        {/if}
      </header>

      {#if confirmSlow}
        <p class="fine-print confirm-slow">
          Your payment went through, but confirmation is taking longer than usual. This page updates
          on its own once it lands; your receipt email has the details.
        </p>
      {/if}

      {@render planOptions(
        auth.isAuthenticated ? 'Become a Supporter' : 'Sign in to become a Supporter',
        true
      )}

      {#if !auth.isAuthenticated}
        <p class="fine-print">
          Plans attach to your Skyreader account, so the button takes you through sign-in first.
          Reading stays free either way.
        </p>
      {/if}
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

  /* Signed-out visitors get the marketing layout: no floating header pill to
     clear on desktop, no bottom bar to clear on mobile. */
  .supporter-page.standalone {
    padding-top: 2rem;
    padding-bottom: 4rem;
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

  .lede + .lede {
    margin-top: 0.75rem;
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

  /* The optional paid block on a granted supporter's page: ruled off from the
     thank-you above it so it reads as an aside, never as the main event. */
  .optional-paid {
    margin-top: 0.5rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--color-border);
  }

  .optional-heading {
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-tight);
    margin: 0 0 0.375rem;
  }

  .optional-intro {
    font-size: var(--text-md);
    line-height: var(--leading-normal);
    color: var(--color-text-secondary);
    max-width: 60ch;
    margin: 0 0 1.25rem;
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

  /* Manage billing: one quiet secondary action under the ledger; the portal
     itself is Polar's page, so nothing else competes with it here. */
  .manage-billing {
    margin-top: 0.25rem;
  }

  .manage-billing:disabled {
    opacity: 0.6;
    cursor: default;
  }

  /* Sits above the plan card instead of the usual end-of-page position. */
  .confirm-slow {
    margin: 0 0 1.25rem;
  }

  /* Believer: hairline-ruled like the benefits ledger, no box. The real
     annual charge is the headline; no per-month framing on a patronage tier. */
  .believer {
    margin-top: 2rem;
    padding-top: 1.25rem;
    border-top: 1px solid var(--color-border);
  }

  .believer-top {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .believer-name {
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
  }

  .believer-price {
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-tight);
    font-variant-numeric: tabular-nums;
  }

  .believer-per {
    font-size: var(--text-sm);
    font-weight: var(--weight-regular);
    color: var(--color-text-secondary);
  }

  .believer-desc {
    font-size: var(--text-md);
    line-height: var(--leading-normal);
    color: var(--color-text-secondary);
    max-width: 60ch;
    margin: 0.375rem 0 0.875rem;
  }

  .believer-cta:disabled {
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
