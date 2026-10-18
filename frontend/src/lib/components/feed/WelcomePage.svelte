<script lang="ts">
  import { onMount, tick } from 'svelte';
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
  import { inkVariant, installMarginaliaInk } from '$lib/utils/marginaliaInk';
  import { wrapTextRange } from '$lib/utils/wrapTextRange';

  let starting = $state(false);
  let startError = $state<string | null>(null);
  // Which Start Reading button was pressed, so its error shows beside it.
  let startedFrom = $state<'top' | 'margin' | 'end'>('margin');

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

  // ── The essay you can mark up ────────────────────────────────
  // The landing page is an article open in the reader, and a visitor can
  // highlight it for real: select text and it takes the reader's own marker
  // ink (app.css `.marginalia-ink`, utils/marginaliaInk.ts) and lands in "Your
  // highlights", where it can carry a note. Nothing is stored — it's a
  // demonstration, and the page says so by never promising it carries over.
  //
  // The essay's markup is static, so Svelte never touches its text nodes after
  // mount; wrapping them in <mark>s here can't fight a re-render.
  interface PageHighlight {
    id: string;
    text: string;
    note: string;
  }

  const SEED_ID = 'hl-seed';
  let highlights = $state<PageHighlight[]>([
    {
      id: SEED_ID,
      text: 'the page you marked is the page you can still read',
      note: 'This is the part worth keeping.',
    },
  ]);
  let nextId = 1;
  let essayEl = $state<HTMLElement | null>(null);
  let noteInputs: Record<string, HTMLTextAreaElement | null> = $state({});

  // A touch or keyboard selection waits for the Highlight button: committing
  // it on the spot would fight the selection handles. A mouse selection
  // commits on release, the way a marker works, once a double- or triple-click
  // has had the chance to finish building it.
  let pending = $state<Range | null>(null);
  let mouseDown = false;
  let commitTimer: ReturnType<typeof setTimeout> | undefined;
  const MULTI_CLICK_MS = 300;

  /** The live selection, trimmed to the essay, or null if none of it is there. */
  function essaySelection(): Range | null {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !essayEl) return null;
    const range = sel.getRangeAt(0).cloneRange();
    if (!range.intersectsNode(essayEl)) return null;
    if (!essayEl.contains(range.startContainer)) range.setStart(essayEl, 0);
    if (!essayEl.contains(range.endContainer)) range.setEnd(essayEl, essayEl.childNodes.length);
    return range.toString().trim() ? range : null;
  }

  const WORD_CHAR = /[\p{L}\p{N}'’-]/u;

  /** Grow a range's ends out to whole words, so a sloppy drag marks clean words. */
  function snapToWords(range: Range) {
    const { startContainer: sc, endContainer: ec } = range;
    if (sc instanceof Text) {
      let i = range.startOffset;
      while (i > 0 && WORD_CHAR.test(sc.data[i - 1]) && WORD_CHAR.test(sc.data[i] ?? '')) i--;
      range.setStart(sc, i);
    }
    if (ec instanceof Text) {
      let i = range.endOffset;
      while (i < ec.length && WORD_CHAR.test(ec.data[i]) && WORD_CHAR.test(ec.data[i - 1] ?? ''))
        i++;
      range.setEnd(ec, i);
    }
  }

  function unwrap(mark: HTMLElement) {
    const parent = mark.parentNode;
    mark.replaceWith(...mark.childNodes);
    parent?.normalize();
  }

  function commit(range: Range) {
    window.getSelection()?.removeAllRanges();
    pending = null;
    if (!essayEl) return;
    snapToWords(range);
    const text = range.toString().replace(/\s+/g, ' ').trim();
    if (!text) return;
    const id = `hl-${nextId++}`;
    // The reader's own wrapping (utils/wrapTextRange.ts), dressed the way
    // useHighlights' inkMarks dresses it: a passage crossing paragraphs is
    // several marks, and data-edge puts the marker's ragged caps on its ends.
    const marks = wrapTextRange(range, essayEl, () => {
      const mark = document.createElement('mark');
      mark.className = 'highlight';
      mark.dataset.hl = id;
      mark.dataset.ink = String(inkVariant(id));
      return mark;
    }).filter((mark) => mark.textContent?.trim() || (unwrap(mark), false));
    if (marks.length === 0) return;
    marks.forEach((mark, i) => {
      if (marks.length > 1) {
        mark.dataset.edge = i === 0 ? 'start' : i === marks.length - 1 ? 'end' : 'mid';
      }
    });
    highlights.push({ id, text, note: '' });
  }

  let panelHeading = $state<HTMLElement | null>(null);

  function removeHighlight(id: string) {
    essayEl?.querySelectorAll<HTMLElement>(`mark[data-hl="${id}"]`).forEach(unwrap);
    highlights = highlights.filter((h) => h.id !== id);
    // The focused button just went away with its row; don't drop focus to <body>.
    panelHeading?.focus();
  }

  function showPassage(id: string) {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    essayEl
      ?.querySelector(`mark[data-hl="${id}"]`)
      ?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
  }

  // Clicking a passage takes you to its note.
  async function onEssayClick(event: MouseEvent) {
    const mark = (event.target as HTMLElement).closest<HTMLElement>('mark[data-hl]');
    if (!mark || essaySelection()) return;
    await tick();
    noteInputs[mark.dataset.hl!]?.focus();
  }

  function onPointerDown(event: PointerEvent) {
    if (event.pointerType !== 'mouse') return;
    mouseDown = true;
    clearTimeout(commitTimer);
  }

  function onPointerUp(event: PointerEvent) {
    if (event.pointerType !== 'mouse') return;
    mouseDown = false;
    pending = null;
    clearTimeout(commitTimer);
    commitTimer = setTimeout(() => {
      const range = essaySelection();
      if (range) commit(range);
    }, MULTI_CLICK_MS);
  }

  function onSelectionChange() {
    if (mouseDown) return;
    pending = essaySelection();
  }

  // Commit on press, not click: a tap dismisses the native selection before
  // its click arrives. preventDefault keeps focus and selection where they are.
  function onMarkPress(event: PointerEvent) {
    event.preventDefault();
    if (pending) commit(pending);
  }

  onMount(() => {
    // Before the reduced-motion early return: prices load regardless of
    // motion preference. Failure is silent by design; see the pricing note.
    api
      .getBillingProducts()
      .then(({ products }) => (plans = products))
      .catch(() => {});

    installMarginaliaInk();
    const seed = essayEl?.querySelector<HTMLElement>('[data-seed]');
    if (seed) {
      seed.dataset.hl = SEED_ID;
      seed.dataset.ink = String(inkVariant(SEED_ID));
    }

    // Safety net: scroll-reveal enhances reading, but content must never be
    // stuck hidden in a non-scrolling or headless context. Force-reveal
    // anything still pending shortly after load; engaged readers scroll well
    // before this fires and still get the staggered entrance.
    const safety = setTimeout(() => {
      document
        .querySelectorAll('.landing .reveal-init:not(.revealed)')
        .forEach((el) => el.classList.add('revealed'));
    }, 2500);
    return () => {
      clearTimeout(safety);
      clearTimeout(commitTimer);
    };
  });
</script>

<svelte:document
  onpointerdown={onPointerDown}
  onpointerup={onPointerUp}
  onpointercancel={() => (mouseDown = false)}
  ondragend={() => (mouseDown = false)}
  onselectionchange={onSelectionChange}
/>

<div class="landing">
  <div class="room">
    <div class="rail" aria-hidden="true">
      <span>3 min read</span>
      <span>{highlights.length} {highlights.length === 1 ? 'highlight' : 'highlights'}</span>
    </div>

    <article class="essay" aria-labelledby="essay-h">
      <p class="essay-meta">skyreader.app · Essay</p>
      <h1 id="essay-h">The good stuff should stick.</h1>
      <p class="byline">Skyreader, a reader for everything you follow</p>
      <!-- Phones get the way in up top; the margin, which carries it on wider
           screens, falls below the essay there. -->
      <div class="start-inline">
        <button class="cta-primary" onclick={() => startReading('top')} disabled={starting}>
          {starting ? 'Preparing your reading room…' : 'Start Reading'}
        </button>
        <a href="/auth/login">Sign in</a>
      </div>
      {#if startError && startedFrom === 'top'}
        <p class="start-error start-error--top" role="alert">{startError}</p>
      {/if}

      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="essay-body marginalia-ink" bind:this={essayEl} onclick={onEssayClick}>
        <p>
          Most of what we read disappears. Not because it was bad, but because it was scattered: a
          link in a newsletter, a paper in a downloads folder, a post that scrolled past at
          midnight. By the time it matters, it's gone, or it has changed, or you can't remember
          where you saw it.
        </p>
        <p>
          Skyreader is a reader built against that. Everything you follow comes into one calm place,
          in the order it was published, with no algorithm choosing for you: feeds and newsletters,
          your Bluesky likes and bookmarks, YouTube channels, PDFs and books.
        </p>
        <p>
          When something is worth keeping, you mark it. Highlights stay on the passage, even on the
          original pages of a PDF, and your notes sit in the margin beside them. Every save is
          snapshotted the moment you keep it, so <mark class="highlight" data-seed
            >the page you marked is the page you can still read</mark
          >.
        </p>
        <p>
          You're not reading alone, either. Under an article you can see who else is discussing it
          on Bluesky and Semble, quietly, without a timeline pulling at you.
        </p>
        <p>
          Later, when you need it, the line is still there, and your highlights and notes go with
          you as Markdown or BibTeX. That's the point of reading this way: it adds up.
        </p>
      </div>
      <p class="try">Try it: select any sentence above to highlight it.</p>

      <section class="discussion" aria-labelledby="discussion-h">
        <h2 id="discussion-h">Discussion</h2>
        <div class="post">
          <span class="avatar" aria-hidden="true">M</span>
          <div>
            <span class="handle">@mara.example</span>
            <p>
              "Every save is snapshotted the moment you keep it." The feature I didn't know I
              needed.
            </p>
          </div>
        </div>
        <div class="post">
          <span class="avatar avatar--b" aria-hidden="true">R</span>
          <div>
            <span class="handle">@rui.example</span>
            <p>Finally, the PDF and the newsletter in the same place.</p>
          </div>
        </div>
        <p class="sample">Sample discussion</p>
      </section>
    </article>

    <aside class="margin" aria-label="Your highlights and getting started">
      <section class="panel" aria-labelledby="hls-h">
        <h2 id="hls-h" class="panel-head" tabindex="-1" bind:this={panelHeading}>
          <span>Your highlights</span>
          <span class="panel-count" aria-live="polite">{highlights.length}</span>
        </h2>
        {#if highlights.length}
          <ul class="hls">
            {#each highlights as h (h.id)}
              <li class="hl-item">
                <button type="button" class="hl-quote" onclick={() => showPassage(h.id)}>
                  {h.text}
                </button>
                <textarea
                  class="hl-note"
                  rows="1"
                  placeholder="Add a note"
                  aria-label="Note on this highlight"
                  bind:value={h.note}
                  bind:this={noteInputs[h.id]}></textarea>
                <button
                  type="button"
                  class="hl-remove"
                  aria-label={`Remove highlight: ${h.text}`}
                  onclick={() => removeHighlight(h.id)}
                >
                  <Icon name="x" size={14} />
                </button>
              </li>
            {/each}
          </ul>
        {/if}
        {#if highlights.length < 2}
          <p class="panel-hint">Select text in the essay to add one.</p>
        {/if}
      </section>

      <section class="panel panel--start" aria-label="Get started">
        <p>
          This is how everything reads in Skyreader: your sources in full, with your marks and notes
          beside them.
        </p>
        <button class="cta-primary" onclick={() => startReading('margin')} disabled={starting}>
          {starting ? 'Preparing your reading room…' : 'Start Reading'}
          {#if !starting}<Icon name="arrow-right" size={16} />{/if}
        </button>
        {#if startError && startedFrom === 'margin'}
          <p class="start-error" role="alert">{startError}</p>
        {/if}
        <p class="fine">
          Free to read, no account needed. <a href="/auth/login">Sign in</a> when you want it on every
          device.
        </p>
      </section>
    </aside>
  </div>

  {#if pending}
    <button
      type="button"
      class="mark-btn"
      onpointerdown={onMarkPress}
      onclick={() => pending && commit(pending)}
    >
      <Icon name="highlighter" size={16} /> Highlight
    </button>
  {/if}

  <!-- ── What you just did ─────────────────────────────────── -->
  <section class="section" aria-labelledby="did-h">
    <div class="section-head" use:reveal>
      <h2 id="did-h">That's the whole idea.</h2>
      <p>What you just did on this page is what Skyreader does with everything you follow.</p>
    </div>
    <ul class="did" use:reveal={{ delay: 80 }}>
      <li>
        <span class="did-cue">you read an essay</span>
        <h3>Read in one calm place</h3>
        <p>
          RSS and Atom, Atmosphere publications, Bluesky likes and bookmarks, YouTube channels, with
          transcripts for videos you save. Newsletters by email, PDFs and EPUBs with Supporter. In
          order, no algorithm.
        </p>
      </li>
      <li>
        <span class="did-cue">you highlighted a line</span>
        <h3>Mark what matters</h3>
        <p>
          Highlights and margin notes on any source, a PDF's original pages included, and a review
          that brings them back.
        </p>
      </li>
      <li>
        <span class="did-cue">every save is kept</span>
        <h3>Keep it as you read it</h3>
        <p>
          A snapshot of every save, taken the moment you keep it, with the Wayback Machine as a
          fallback.
        </p>
      </li>
      <li>
        <span class="did-cue">you saw who else read it</span>
        <h3>Read alongside others</h3>
        <p>
          The discussion around an article from Bluesky and Semble, and linkblogs from people you
          follow.
        </p>
      </li>
      <li>
        <span class="did-cue">wherever you find it</span>
        <h3>Save from anywhere</h3>
        <p>
          A browser extension for Chrome and Firefox, your phone's share sheet once Skyreader is
          installed, and offline reading for when the signal drops.
        </p>
      </li>
      <li>
        <span class="did-cue">it's yours</span>
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
      <h2 id="cta-h">Read everything like this.</h2>
      <p>
        Start with a few good sources, no account needed. Sign in when you want it on every device.
      </p>
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
    --gold: #f5c518;
    --space-section: clamp(4.5rem, 9vw, 7.5rem);
    /* The layout's sticky header, which the margin panel tucks under. */
    --header-clear: 5rem;
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

  /* ── The room: rail · essay · margin, the reader's own shape ── */
  .room {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 42rem) minmax(16rem, 1fr);
    gap: clamp(1.25rem, 3vw, 3rem);
    align-items: start;
    max-width: 90rem;
    margin: 0 auto;
    padding-block: clamp(2.5rem, 7vh, 5.5rem) clamp(3rem, 6vw, 4.5rem);
  }
  .rail {
    white-space: nowrap;
    position: sticky;
    top: var(--header-clear);
    display: grid;
    gap: 0.6rem;
    justify-items: end;
    padding-top: 0.2rem;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .essay {
    min-width: 0;
  }
  .essay-meta {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--muted);
    margin-bottom: 1rem;
  }
  .essay h1 {
    font-size: clamp(2.75rem, 6vw, 5rem);
    font-weight: 800;
    line-height: 1;
    letter-spacing: -0.035em;
    text-wrap: balance;
  }
  .byline {
    margin: 1rem 0 2rem;
    font-size: var(--text-lg);
    color: var(--muted);
  }
  .start-inline {
    display: none;
    align-items: center;
    gap: 1.25rem;
    margin: -0.75rem 0 2rem;
    font-weight: var(--weight-medium);
  }
  .start-inline a {
    color: var(--ink);
  }
  .essay-body {
    font-family: var(--font-literata);
    font-size: clamp(1.1875rem, 1.35vw, 1.3125rem);
    line-height: 1.75;
  }
  .essay-body p + p {
    margin-top: 1.1em;
  }
  .try {
    margin-top: 1.5rem;
    font-size: var(--text-md);
    color: var(--muted);
  }
  .try::before {
    content: '';
    display: inline-block;
    width: 1.6em;
    height: 0.55em;
    margin-right: 0.5em;
    vertical-align: 0.05em;
    border-radius: 2px;
    background: color-mix(in srgb, var(--gold) 55%, transparent);
  }

  .discussion {
    margin-top: 2.5rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--color-border);
    display: grid;
    gap: 1rem;
  }
  .discussion h2 {
    font-size: var(--text-2xl);
    font-weight: var(--weight-bold);
  }
  .post {
    display: grid;
    grid-template-columns: 2rem 1fr;
    gap: 0.75rem;
    font-size: var(--text-lg);
    line-height: var(--leading-relaxed);
  }
  .avatar {
    display: grid;
    place-items: center;
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    background: color-mix(in srgb, var(--color-primary) 16%, transparent);
    color: var(--color-primary);
    font-size: var(--text-sm);
    font-weight: var(--weight-bold);
  }
  .avatar--b {
    background: color-mix(in srgb, var(--gold) 30%, transparent);
    color: var(--ink-note);
  }
  .handle {
    font-weight: var(--weight-semibold);
  }
  .sample {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--muted);
  }

  /* ── The margin ──────────────────────────────────────────── */
  .margin {
    position: sticky;
    top: var(--header-clear);
    display: grid;
    gap: 1rem;
  }
  .panel {
    border: 1px solid var(--color-border);
    border-radius: 12px;
    padding: 1rem;
    background: var(--color-bg);
  }
  .panel-head {
    display: flex;
    justify-content: space-between;
    margin-bottom: 0.75rem;
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .hls {
    list-style: none;
    display: grid;
    gap: 0.85rem;
    max-height: min(22rem, 45vh);
    overflow-y: auto;
  }
  .hl-item {
    position: relative;
    padding: 0.1rem 1.75rem 0.1rem 0.75rem;
    border-left: 3px solid var(--gold);
  }
  .hl-quote {
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
    padding: 0;
    border: 0;
    background: none;
    text-align: left;
    font-family: var(--font-literata);
    font-size: var(--text-lg);
    line-height: 1.45;
    color: var(--ink);
    cursor: pointer;
  }
  .hl-note {
    display: block;
    width: 100%;
    margin-top: 0.3rem;
    padding: 0.15rem 0;
    border: 0;
    border-bottom: 1px dashed var(--color-border);
    background: transparent;
    resize: none;
    field-sizing: content;
    font-family: var(--font-hand);
    font-size: 1rem;
    line-height: 1.35;
    color: var(--ink-note);
  }
  .hl-note::placeholder {
    color: var(--ink-note-soft);
  }
  .hl-note:focus {
    outline: none;
    border-bottom-color: var(--color-primary);
  }
  .hl-remove {
    position: absolute;
    top: 0;
    right: 0;
    display: grid;
    place-items: center;
    width: 1.5rem;
    height: 1.5rem;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--muted);
    cursor: pointer;
    opacity: 0.6;
  }
  .hl-item:hover .hl-remove,
  .hl-remove:focus-visible {
    opacity: 1;
  }
  .panel-hint {
    margin-top: 0.75rem;
    font-size: var(--text-md);
    color: var(--muted);
  }
  .panel--start p {
    font-size: var(--text-lg);
    line-height: 1.5;
    color: var(--muted);
    margin-bottom: 1rem;
  }
  .panel--start .fine {
    margin: 0.85rem 0 0;
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

  .start-error--top {
    margin: -1.25rem 0 2rem;
  }
  /* Only ever shown when Start Reading couldn't seed the local library. */
  .start-error {
    margin-top: 0.75rem;
    font-size: var(--text-sm);
    color: var(--color-error);
  }

  /* Touch and keyboard selections: commit on request, clear of the
     selection's own callout at the top of it. */
  .mark-btn {
    position: fixed;
    left: 50%;
    bottom: calc(1.25rem + env(safe-area-inset-bottom));
    z-index: 50;
    transform: translateX(-50%);
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.7rem 1.15rem;
    border: 1px solid color-mix(in srgb, var(--gold) 70%, var(--ink));
    border-radius: 999px;
    background: var(--gold);
    color: #1a1a1a;
    font-weight: var(--weight-semibold);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
    cursor: pointer;
  }

  /* ── CTAs ────────────────────────────────────────────────── */
  .cta-primary {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1.25rem;
    border: none;
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
  .cta-primary:focus-visible,
  .hl-quote:focus-visible,
  .hl-remove:focus-visible,
  .mark-btn:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
    border-radius: 4px;
  }

  /* ── Sections below the essay ────────────────────────────── */
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

  .did {
    list-style: none;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    column-gap: clamp(1.25rem, 3vw, 2.5rem);
    border-top: 1px solid var(--color-border);
  }
  .did li {
    padding: 1.4rem 0 1.5rem;
    border-bottom: 1px solid var(--color-border);
    min-width: 0;
  }
  .did-cue {
    display: block;
    margin-bottom: 0.5rem;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--color-primary);
  }
  .did h3 {
    font-size: var(--text-2xl);
    font-weight: var(--weight-bold);
    line-height: 1.2;
    letter-spacing: -0.01em;
  }
  .did p {
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
  @media (max-width: 1100px) {
    .room {
      grid-template-columns: minmax(0, 1fr) minmax(15rem, 19rem);
    }
    .rail {
      display: none;
    }
  }
  @media (max-width: 800px) {
    .room {
      grid-template-columns: minmax(0, 1fr);
    }
    .margin {
      position: static;
    }
    .start-inline {
      display: flex;
    }
    .did {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  /* iOS Safari zooms the viewport when a focused input is smaller than 16px. */
  @media (hover: none) and (pointer: coarse) {
    .hl-note {
      font-size: max(1rem, 16px);
    }
    .hl-remove {
      opacity: 1;
    }
  }
</style>
