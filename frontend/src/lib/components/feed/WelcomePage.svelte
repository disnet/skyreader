<script lang="ts">
  // The logged-out landing page. A plain, conventional shape on purpose: say
  // what Skyreader is in the hero (a feed reader and read-later app in one),
  // then walk the loop a reader actually lives in (Follow, Read, Keep), each
  // step shown with a real screenshot of the app. Then switching, the quiet
  // social layer, ownership, plans, questions, and the same call to start.
  //
  // The screenshots in /landing/ are generated, not hand-captured: see the
  // "Landing page" block in e2e-docs/docs-screenshots.spec.ts
  // (`npm run shots:docs`). Rerun it after a design change.
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

  let starting = $state(false);
  let startError = $state<string | null>(null);
  // The page has two Start buttons; the error shows beside the one pressed, so
  // a failure is one alert, in view, not two (one of them off-screen).
  let startFrom = $state<'hero' | 'closing'>('hero');

  // "Start reading": guest mode. Seeds the curated starter channels into the
  // local library and opens the reader, no account involved; signing in later
  // migrates whatever the guest did. See "Guest reading mode" in
  // frontend/CLAUDE.md.
  async function startReading(from: 'hero' | 'closing') {
    if (starting) return;
    startFrom = from;
    starting = true;
    startError = null;
    try {
      const { channels } = await api.getStarterFeeds();
      const feeds = channels.flatMap((channel) =>
        channel.feeds.map((feed) => ({ ...feed, category: channel.name }))
      );

      const { subscriptionsStore } = await import('$lib/stores/subscriptions.svelte');

      await auth.enterGuestMode();
      const result = await subscriptionsStore.addBulk(feeds, undefined, { starterSeed: true });
      if (result.added.length === 0) {
        auth.exitGuestMode();
        throw new Error(result.failed[0]?.error ?? 'No feeds could be saved locally');
      }

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

  // ── Plans ────────────────────────────────────────────────────
  // Prices are authored in one place, the Polar dashboard, and served by the
  // backend; this page never hard-codes them. A failed fetch just leaves the
  // price line off, and /supporter has the details.
  let plans = $state<BillingProduct[]>([]);
  const offered = $derived(supporterPlans(plans));
  const offer = $derived(
    cheapest(offered.filter((p) => p.interval === 'year')) ??
      cheapest(offered.filter((p) => p.interval === 'month'))
  );
  // Monthly-priced framing, same as /supporter: a yearly plan's headline is its
  // per-month equivalent, with the amount actually charged named beneath it.
  const offerPerMonth = $derived(offer ? monthlyPrice(offer) : null);
  // A dearer live product of the same cadence marks the offer as a founding
  // price; archive the founding product in Polar and the framing goes with it.
  const standardPlan = $derived(
    offer
      ? compareAt(
          offered.filter((p) => p.interval === offer.interval),
          offer
        )
      : null
  );

  onMount(() => {
    api
      .getBillingProducts()
      .then(({ products }) => (plans = products))
      .catch(() => {});
  });

  // What a reader can bring in. Named as file formats people recognize, not as
  // a comparison: these are the exports the importer reads.
  const importApps = ['Pocket', 'Instapaper', 'Readwise Reader', 'Omnivore', 'Matter', 'Wallabag'];
  const readerApps = ['NetNewsWire', 'Reeder', 'ReadKit', 'Unread'];

  // Answers follow docs-site/src/content/docs/faq.md; keep them in step.
  const faqs: { q: string; a: string; link?: { href: string; label: string } }[] = [
    {
      q: 'Do I need a Bluesky account?',
      a: 'Not to try it: Start reading opens the reader with a few starter feeds and no account. To sync across devices you sign in with an Atmosphere account, and a Bluesky account is one. The sign-in page can make one for you.',
    },
    {
      q: 'Is my reading public?',
      a: 'No. What you read, save, highlight and note is private to you. A few things are public by your choice: your linkblog, recommends, the reading rooms you join, and anything you sync or back up to another Atmospheric app.',
      link: { href: docsUrl('yourData'), label: 'What is public, in full' },
    },
    {
      q: 'Can I keep using my RSS app?',
      a: `Yes. ${readerApps.join(', ')} and other apps that speak the Google Reader API can sync with Skyreader, with read and starred state kept in step.`,
      link: { href: docsUrl('otherApps'), label: 'Other reader apps' },
    },
    {
      q: 'What works offline?',
      a: 'Reading your feeds and saved articles, marking read, highlighting, notes and the daily magazine. Changes sync when you are back online.',
    },
    {
      q: 'How do I take my data with me?',
      a: 'Export your subscriptions as OPML at any time, a format every feed reader understands. Highlights and notes can sync to Obsidian and Zotero on the Supporter plan.',
      link: { href: docsUrl('yourData'), label: 'Your data' },
    },
  ];
</script>

<div class="landing">
  <!-- ── Hero ──────────────────────────────────────────────── -->
  <header class="hero">
    <p class="eyebrow">A feed reader and read-later app, in one</p>
    <h1 class="hero-title">
      <span>Read everything you follow.</span>
      <span>Keep what matters.</span>
    </h1>
    <p class="hero-lead">
      The blogs and sites you follow arrive in one calm, chronological stream, beside the links your
      Bluesky follows share. Highlight what matters, write in the margin, and the good parts come
      back to you.
    </p>
    <div class="actions">
      <button class="btn btn-primary" onclick={() => startReading('hero')} disabled={starting}>
        {starting ? 'Preparing your reading room…' : 'Start reading'}
      </button>
      <a class="btn btn-secondary" href="/auth/login">Sign in with Bluesky</a>
    </div>
    {#if startError && startFrom === 'hero'}
      <p class="start-error" role="alert">{startError}</p>
    {/if}
    <p class="fine">Free while in beta. No account needed to start.</p>
  </header>

  <figure class="shot shot--hero">
    <img
      src="/landing/reader.jpg"
      width="2080"
      height="992"
      alt="An essay open in Skyreader's reader. One paragraph is highlighted in yellow, and a handwritten note beside it in the margin reads: the decisions are the understanding. Keep the pen."
      fetchpriority="high"
    />
  </figure>

  <!-- ── Follow, Read, Keep ────────────────────────────────── -->
  <section class="steps" aria-labelledby="steps-h">
    <div class="section-head">
      <h2 id="steps-h">Reading that adds up, in three steps</h2>
      <p>The loop you already live in, with nothing added to pull you back in.</p>
    </div>

    <article class="step">
      <div class="step-text">
        <p class="step-num">01 · Follow</p>
        <h3>Everything you follow, in one stream</h3>
        <p>
          Add any site with a feed, and on the Supporter plan, newsletters by email. Group them into
          channels. They arrive in the order they were published, with no algorithm deciding what
          you see. Signed in, you can also read the links people you follow on Bluesky are sharing.
        </p>
        <ul class="points">
          <li>Bring your subscriptions from any feed reader with an OPML file</li>
          <li>Save any page with the Chrome or Firefox extension</li>
          <li>Keyboard-friendly, and quiet when there is nothing new</li>
        </ul>
      </div>
      <figure class="shot">
        <img
          src="/landing/stream.jpg"
          width="2400"
          height="1520"
          loading="lazy"
          alt="Skyreader's Feeds view: a sidebar of Home, Feeds, Library, Channels and Highlights beside a stream of articles from blogs like The Commonplace and The Slow Web Review."
        />
      </figure>
    </article>

    <article class="step step--flip">
      <div class="step-text">
        <p class="step-num">02 · Read</p>
        <h3>A reader that gets out of the way</h3>
        <p>
          Every article opens in a clean reading view, in the type and size you like. When a feed
          sends only a summary, signing in lets you fetch the whole article.
        </p>
        <ul class="points">
          <li>Scroll or turn pages</li>
          <li>Works offline, and syncs when you're back</li>
          <li>Light and dark, sans and serif</li>
        </ul>
      </div>
      <figure class="shot">
        <img
          src="/landing/article.jpg"
          width="2400"
          height="1200"
          loading="lazy"
          alt="An article, What we lose when we skim, open in Skyreader's reader: the title, author and reading time above plain, roomy serif text, with Style, Pages, Share and Archive in a quiet toolbar."
        />
      </figure>
    </article>

    <article class="step">
      <div class="step-text">
        <p class="step-num">03 · Keep</p>
        <h3>Highlights that come back to you</h3>
        <p>
          Highlight a passage and write beside it in the margin. Your highlights collect in one
          place, and the review deck brings old ones back a few at a time, so what you read stays
          with you.
        </p>
        <ul class="points">
          <li>A Queue for what's next, a Shelf for what you keep</li>
          <li>Search everything you've read and highlighted (Supporter)</li>
          <li>Highlights and notes sync to Obsidian and Zotero (Supporter)</li>
        </ul>
      </div>
      <figure class="shot">
        <img
          src="/landing/review.jpg"
          width="1732"
          height="860"
          loading="lazy"
          alt="The review deck showing one past highlight, the article it came from, and buttons for Next and Later."
        />
      </figure>
    </article>
  </section>

  <!-- ── Switching ─────────────────────────────────────────── -->
  <section class="section" aria-labelledby="bring-h">
    <div class="section-head">
      <h2 id="bring-h">Bring everything with you</h2>
      <p>Moving in takes a few minutes, and you can keep the apps you like.</p>
    </div>
    <dl class="ledger">
      <div class="ledger-row">
        <dt>Your feeds</dt>
        <dd>Import an OPML file from any feed reader, folders included.</dd>
      </div>
      <div class="ledger-row">
        <dt>Your saved articles</dt>
        <dd>
          Import from {importApps.slice(0, -1).join(', ')} or {importApps.at(-1)}, with tags,
          archive and highlights where the export has them. Pocket and Omnivore have shut down; if
          you kept your export, it still imports.
        </dd>
      </div>
      <div class="ledger-row">
        <dt>Your RSS app</dt>
        <dd>
          Keep reading in {readerApps.join(', ')} or any app that speaks the Google Reader API. Read and
          starred state stay in step.
        </dd>
      </div>
    </dl>
    <p class="more">
      <a href={docsUrl('importLibrary')} target="_blank" rel="noopener noreferrer">
        How importing works <Icon name="arrow-right" size={14} />
      </a>
    </p>
  </section>

  <!-- ── Other readers, quietly ────────────────────────────── -->
  <section class="section" aria-labelledby="social-h">
    <div class="section-head">
      <h2 id="social-h">Other readers, without the timeline</h2>
      <p>
        The people you follow make your reading better. They never turn it into a feed to scroll.
      </p>
    </div>
    <ul class="trio">
      <li>
        <h3>From your follows</h3>
        <p>
          The links people you follow on Bluesky share, one article at a time. Nothing is ranked by
          engagement, and the list ends.
        </p>
      </li>
      <li>
        <h3>Discussion</h3>
        <p>At the end of an article, see what people have written about it, in one place.</p>
      </li>
      <li>
        <h3>Your linkblog</h3>
        <p>
          Share a piece with a sentence of your own. Your linkblog is a public page people can read
          and subscribe to.
        </p>
      </li>
    </ul>
  </section>

  <!-- ── Ownership ─────────────────────────────────────────── -->
  <section class="section section--quiet" aria-labelledby="yours-h">
    <div class="section-head">
      <h2 id="yours-h">Yours, and built to last</h2>
      <p>
        Your reading is private by default, kept on Skyreader's servers. You sign in with an account
        you own, not a Skyreader password, and you can export your subscriptions at any time.
      </p>
      <p>
        Skyreader is built on the Atmosphere, the open network behind Bluesky. Turn on Atmospheric
        sync and your subscriptions are also kept in your own Atmosphere account, where any
        Atmospheric app can use them. That also makes them public.
      </p>
    </div>
    <p class="more">
      <a href={docsUrl('yourData')} target="_blank" rel="noopener noreferrer">
        What's kept where <Icon name="arrow-right" size={14} />
      </a>
    </p>
  </section>

  <!-- ── Plans ─────────────────────────────────────────────── -->
  <section class="section" aria-labelledby="pricing-h">
    <div class="section-head">
      <h2 id="pricing-h">Free to read. Backed by readers.</h2>
      <p>
        Skyreader is independent software, built and run by one person. No ads, no investors.
        Reading is free, and readers who want to can help keep it that way.
      </p>
    </div>
    <div class="plans">
      <div class="plan">
        <div class="plan-top">
          <h3 class="plan-name">Free</h3>
          <span class="plan-price">$0</span>
        </div>
        <ul class="points">
          <li>Up to {freeLimits.feeds} feeds and {freeLimits.saves} saves a month</li>
          <li>The reader, highlights and margin notes</li>
          <li>The daily magazine and review deck</li>
          <li>Your linkblog</li>
          <li>Offline reading and sync across devices</li>
        </ul>
      </div>
      <div class="plan">
        <div class="plan-top">
          <h3 class="plan-name">Supporter</h3>
          {#if offerPerMonth && offer}
            <span class="plan-price">{offerPerMonth}<span class="plan-per">/month</span></span>
          {/if}
        </div>
        <ul class="points">
          <li>Up to {supporterLimits.feeds} feeds and {supporterLimits.saves} saves a month</li>
          <li>Newsletters by email</li>
          <li>Search everything you've read, saved and highlighted</li>
          <li>PDFs and books, read and highlighted like articles</li>
          <li>Highlights in Obsidian and Zotero</li>
        </ul>
        {#if offer}
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
          More about supporting <Icon name="arrow-right" size={14} />
        </a>
      </div>
    </div>
  </section>

  <!-- ── Questions ─────────────────────────────────────────── -->
  <section class="section" aria-labelledby="faq-h">
    <div class="section-head">
      <h2 id="faq-h">Questions</h2>
    </div>
    <div class="faq">
      {#each faqs as item (item.q)}
        <details>
          <summary>{item.q}</summary>
          <p>
            {item.a}
            {#if item.link}
              <a href={item.link.href} target="_blank" rel="noopener noreferrer"
                >{item.link.label}</a
              >.
            {/if}
          </p>
        </details>
      {/each}
    </div>
    <p class="more">
      <a href={docsUrl('faq')} target="_blank" rel="noopener noreferrer">
        More questions <Icon name="arrow-right" size={14} />
      </a>
    </p>
  </section>

  <!-- ── Final call ────────────────────────────────────────── -->
  <section class="closing" aria-labelledby="closing-h">
    <h2 id="closing-h">Start with a few feeds. Sign in when you want it synced.</h2>
    <div class="actions">
      <button class="btn btn-primary" onclick={() => startReading('closing')} disabled={starting}>
        {starting ? 'Preparing your reading room…' : 'Start reading'}
      </button>
      <a class="btn btn-secondary" href="/auth/login">Sign in with Bluesky</a>
    </div>
    {#if startError && startFrom === 'closing'}
      <p class="start-error" role="alert">{startError}</p>
    {/if}
  </section>
</div>

<style>
  .landing {
    --measure: 40rem;
    --wide: 72rem;
    --space-section: clamp(4rem, 9vw, 7.5rem);
    color: var(--color-text);
    padding-inline: clamp(1rem, 5vw, 3rem);
    padding-bottom: clamp(2rem, 5vw, 4rem);
    overflow-x: clip;
  }

  h2 {
    font-size: clamp(1.625rem, 3.2vw, 2.25rem);
    font-weight: var(--weight-bold);
    line-height: 1.15;
    letter-spacing: -0.015em;
    text-wrap: balance;
  }
  h3 {
    font-size: var(--text-2xl);
    font-weight: var(--weight-semibold);
    line-height: var(--leading-tight);
  }

  /* ── Hero ───────────────────────────────────────────────── */
  .hero {
    max-width: 52rem;
    margin: 0 auto;
    padding-block: clamp(3rem, 9vw, 6rem) clamp(2rem, 5vw, 3.5rem);
    text-align: center;
  }
  .eyebrow {
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    color: var(--color-primary);
  }
  .hero-title {
    margin-top: 0.75rem;
    font-size: clamp(2.125rem, 5.4vw, 3.5rem);
    font-weight: var(--weight-bold);
    line-height: 1.06;
    letter-spacing: -0.025em;
    text-wrap: balance;
  }
  .hero-title span {
    display: block;
  }
  .hero-lead {
    margin: clamp(1.25rem, 2.5vw, 1.75rem) auto 0;
    max-width: 38rem;
    font-size: clamp(1.0625rem, 1.4vw, 1.1875rem);
    line-height: var(--leading-relaxed);
    color: var(--color-text-secondary);
    text-wrap: pretty;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    justify-content: center;
    margin-top: clamp(1.75rem, 3.5vw, 2.25rem);
  }
  .fine {
    margin-top: 1rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }
  .start-error {
    margin-top: 0.75rem;
    font-size: var(--text-sm);
    color: var(--color-error);
  }

  /* ── Buttons ────────────────────────────────────────────── */
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2.75rem;
    padding: 0.7rem 1.3rem;
    border-radius: 8px;
    font-size: var(--text-base);
    font-weight: var(--weight-semibold);
    text-decoration: none;
    transition:
      background-color 0.15s ease,
      border-color 0.15s ease;
  }
  .btn-primary {
    background: var(--color-primary);
    color: #fff;
    border: 1px solid var(--color-primary);
  }
  .btn-primary:hover:not(:disabled) {
    background: var(--color-primary-dark);
    border-color: var(--color-primary-dark);
  }
  .btn-primary:disabled {
    opacity: 0.75;
    cursor: progress;
  }
  .btn-secondary {
    background: var(--color-bg);
    color: var(--color-text);
    border: 1px solid var(--color-border);
  }
  .btn-secondary:hover {
    border-color: var(--color-text-secondary);
  }
  .btn:focus-visible,
  .more a:focus-visible,
  .plan-link:focus-visible,
  summary:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  /* ── Screenshots ────────────────────────────────────────── */
  .shot {
    margin: 0;
  }
  .shot img {
    display: block;
    width: 100%;
    height: auto;
    border: 1px solid var(--color-border);
    border-radius: 12px;
    background: var(--color-bg-secondary);
  }
  .shot--hero {
    max-width: var(--wide);
    margin-inline: auto;
  }
  /* The hero frame is the one floating element on the page, so it alone gets
     a shadow (DESIGN.md: flat by default). */
  .shot--hero img {
    box-shadow:
      0 1px 2px rgb(0 0 0 / 0.04),
      0 12px 32px -12px rgb(0 0 0 / 0.18);
  }

  /* ── Sections ───────────────────────────────────────────── */
  .section,
  .steps {
    max-width: var(--wide);
    margin: var(--space-section) auto 0;
  }
  .section-head {
    max-width: var(--measure);
  }
  .section-head p {
    margin-top: 0.875rem;
    font-size: var(--text-xl);
    line-height: var(--leading-relaxed);
    color: var(--color-text-secondary);
    text-wrap: pretty;
  }
  .steps > .section-head {
    margin-inline: auto;
    text-align: center;
  }
  .more {
    margin-top: 1.5rem;
  }
  .more a,
  .plan-link {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    color: var(--color-primary);
    text-decoration: none;
  }
  .more a:hover,
  .plan-link:hover {
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .points {
    margin: 1rem 0 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 0.5rem;
  }
  .points li {
    position: relative;
    padding-left: 1.25rem;
    font-size: var(--text-base);
    line-height: var(--leading-normal);
  }
  .points li::before {
    content: '';
    position: absolute;
    left: 0.15rem;
    top: 0.6em;
    width: 0.4rem;
    height: 0.4rem;
    border-radius: 50%;
    background: var(--color-primary);
  }

  /* ── Steps ──────────────────────────────────────────────── */
  .step {
    display: grid;
    grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
    gap: clamp(1.5rem, 4vw, 3.5rem);
    align-items: center;
    margin-top: clamp(3rem, 6vw, 5rem);
  }
  .step--flip .step-text {
    order: 2;
  }
  .step-num {
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    letter-spacing: 0.02em;
    color: var(--color-primary);
  }
  .step-text h3 {
    margin-top: 0.5rem;
    font-size: clamp(1.375rem, 2.2vw, 1.625rem);
  }
  .step-text > p:not(.step-num) {
    margin-top: 0.75rem;
    font-size: var(--text-base);
    line-height: var(--leading-relaxed);
    color: var(--color-text-secondary);
  }

  /* ── Switching ledger ───────────────────────────────────── */
  .ledger {
    margin: 2rem 0 0;
    border-top: 1px solid var(--color-border);
  }
  .ledger-row {
    display: grid;
    grid-template-columns: minmax(0, 14rem) minmax(0, 1fr);
    gap: 0.5rem 2rem;
    padding-block: 1.25rem;
    border-bottom: 1px solid var(--color-border);
  }
  .ledger dt {
    font-weight: var(--weight-semibold);
  }
  .ledger dd {
    margin: 0;
    max-width: var(--measure);
    line-height: var(--leading-relaxed);
    color: var(--color-text-secondary);
  }

  /* ── Social trio ────────────────────────────────────────── */
  .trio {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: clamp(1.5rem, 3vw, 2.5rem);
    margin: 2rem 0 0;
    padding: 0;
    list-style: none;
  }
  .trio li {
    padding-top: 1rem;
    border-top: 1px solid var(--color-border);
  }
  .trio h3 {
    font-size: var(--text-xl);
  }
  .trio p {
    margin-top: 0.5rem;
    line-height: var(--leading-relaxed);
    color: var(--color-text-secondary);
  }

  /* ── Ownership ──────────────────────────────────────────── */
  .section--quiet {
    padding: clamp(1.5rem, 4vw, 2.5rem);
    border-radius: 12px;
    background: var(--color-bg-secondary);
  }

  /* ── Plans ──────────────────────────────────────────────── */
  .plans {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: clamp(1rem, 3vw, 2rem);
    margin-top: 2rem;
  }
  .plan {
    padding: 1.5rem;
    border: 1px solid var(--color-border);
    border-radius: 12px;
  }
  .plan-top {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
  }
  .plan-name {
    font-size: var(--text-xl);
  }
  .plan-price {
    font-size: var(--text-2xl);
    font-weight: var(--weight-bold);
    font-variant-numeric: tabular-nums;
  }
  .plan-per {
    font-size: var(--text-md);
    font-weight: var(--weight-regular);
    color: var(--color-text-secondary);
  }
  .plan-meta {
    margin-top: 1rem;
    font-size: var(--text-sm);
    line-height: var(--leading-normal);
    color: var(--color-text-secondary);
  }
  .plan-link {
    margin-top: 1rem;
  }

  /* ── FAQ ────────────────────────────────────────────────── */
  .faq {
    margin-top: 1.5rem;
    max-width: 48rem;
    border-top: 1px solid var(--color-border);
  }
  .faq details {
    border-bottom: 1px solid var(--color-border);
  }
  .faq summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding-block: 1rem;
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    cursor: pointer;
    list-style: none;
  }
  .faq summary::-webkit-details-marker {
    display: none;
  }
  .faq summary::after {
    content: '+';
    font-size: var(--text-2xl);
    font-weight: var(--weight-regular);
    color: var(--color-text-secondary);
  }
  .faq details[open] summary::after {
    content: '−';
  }
  .faq details p {
    padding-bottom: 1.25rem;
    max-width: var(--measure);
    line-height: var(--leading-relaxed);
    color: var(--color-text-secondary);
  }
  .faq details a {
    color: var(--color-primary);
  }

  /* ── Closing ────────────────────────────────────────────── */
  .closing {
    max-width: 40rem;
    margin: var(--space-section) auto 0;
    text-align: center;
  }

  /* ── Narrow screens ─────────────────────────────────────── */
  @media (max-width: 800px) {
    .step {
      grid-template-columns: minmax(0, 1fr);
    }
    .step--flip .step-text {
      order: 0;
    }
    .ledger-row {
      grid-template-columns: minmax(0, 1fr);
    }
    .trio,
    .plans {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  @media (max-width: 480px) {
    .actions .btn {
      width: 100%;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .btn {
      transition: none;
    }
  }
</style>
