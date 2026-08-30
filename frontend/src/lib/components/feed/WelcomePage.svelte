<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { api } from '$lib/services/api';

  let starting = $state(false);
  async function startReading() {
    if (starting) return;
    starting = true;
    auth.enterGuestMode();
    try {
      const { channels } = await api.getStarterFeeds();
      await subscriptionsStore.addBulk(
        channels.flatMap((channel) =>
          channel.feeds.map((feed) => ({ ...feed, category: channel.name }))
        )
      );
      await goto('/feeds');
    } catch (error) {
      auth.exitGuestMode();
      console.error('Could not start guest reading:', error);
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

  // ── Margin-note popup: keep it on-screen ─────────────────────
  // The note is centered under its marker, but the marker can wrap close
  // to a viewport edge (notably on narrow phones), which clipped the popup.
  // This nudges the centered popup horizontally so it always clears the
  // viewport by a small gutter, recomputed on hover/focus and resize.
  function clampPopup(node: HTMLElement) {
    if (typeof window === 'undefined') return;
    const gutter = 12;
    const anchor = node.parentElement; // .note-anchor
    let nudge = 0;
    // Measure the popup *with the current nudge applied* and correct only by
    // the overshoot, so a correctly-placed popup never resets to 0 (which
    // would otherwise commit a transition start and make it flick on click).
    const update = () => {
      const rect = node.getBoundingClientRect();
      let correction = 0;
      if (rect.left < gutter) correction = gutter - rect.left;
      else if (rect.right > window.innerWidth - gutter)
        correction = window.innerWidth - gutter - rect.right;
      if (Math.abs(correction) < 0.5) return;
      nudge = Math.round(nudge + correction);
      node.style.setProperty('--nudge', `${nudge}px`);
    };
    anchor?.addEventListener('pointerenter', update);
    anchor?.addEventListener('focusin', update);
    window.addEventListener('resize', update);
    update();
    return {
      destroy() {
        anchor?.removeEventListener('pointerenter', update);
        anchor?.removeEventListener('focusin', update);
        window.removeEventListener('resize', update);
      },
    };
  }

  // ── Hero highlight draw ──────────────────────────────────────
  let motion = $state(false); // becomes true on mount when motion allowed
  let heroDrawn = $state(false);

  // ── Live reading demo state (scoped to the demo card only) ───
  // Light-touch demo: a highlighted phrase, a margin note that reveals on
  // hover/focus of its marker, and a share box you can type a thought into.
  let shareNote = $state(''); // linkblog share note draft

  const sources = [
    {
      icon: 'rss',
      label: 'RSS feeds',
      kind: 'blogs, news, anything with a feed',
      soon: false,
      more: false,
    },
    {
      icon: 'at-sign',
      label: 'The Atmosphere',
      kind: 'standard.site publication across the Atmosphere',
      soon: false,
      more: false,
    },
    {
      icon: 'inbox',
      label: 'Newsletters',
      kind: 'a private address for your inbox',
      soon: true,
      more: false,
    },
    {
      icon: 'bluesky',
      label: 'Bluesky',
      kind: 'posts from the accounts you pick',
      soon: true,
      more: false,
    },
    { icon: 'plus', label: 'More sources', kind: 'coming soon', soon: false, more: true },
  ] as const;

  const stream = [
    { title: 'The case for slow software', src: 'Newsletter', time: '2h', unread: true },
    { title: 'Notes on attention and the open web', src: 'RSS', time: '4h', unread: true },
    { title: 'A field guide to RSS in 2026', src: 'Blog', time: '6h', unread: false },
    { title: 'Why I still keep a reading list', src: 'Bluesky', time: '1d', unread: false },
  ];

  // Saved shelf demo: the few pieces pulled out of the stream to read properly.
  // One is marked available offline to make the read-anywhere promise concrete.
  const saved = [
    { title: 'The case for slow software', meta: 'Newsletter · saved 2h ago', offline: true },
    { title: 'Notes on attention and the open web', meta: 'RSS · saved yesterday', offline: false },
    { title: 'A field guide to RSS in 2026', meta: 'Blog · saved 3d ago', offline: false },
  ];

  onMount(() => {
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
  <!-- ── Hero ──────────────────────────────────────────────── -->
  <header class="hero">
    <h1 class="hero-title">
      <span class="line" use:reveal>Read everything from everywhere.</span>
      <span class="line" use:reveal={{ delay: 90 }}>
        <mark class="hl" class:animate={motion} class:drawn={heroDrawn || !motion}
          >Make sense of it all.</mark
        >
      </span>
    </h1>
    <p class="hero-lead" use:reveal={{ delay: 180 }}>
      Skyreader gathers your reading from across the internet into one calm place and helps you make
      sense of it all.
    </p>
    <div class="hero-actions" use:reveal={{ delay: 260 }}>
      <a href="/auth/login" class="cta-primary"> Sign in </a>
      <a href="#read" class="cta-ghost">
        See how it reads
        <Icon name="arrow-down" size={16} />
      </a>
    </div>
    <p class="hero-note" use:reveal={{ delay: 320 }}>Free, in beta.</p>
  </header>

  <!-- ── One place ─────────────────────────────────────────── -->
  <section class="section section--sources" aria-labelledby="sources-h">
    <div class="section-head" use:reveal>
      <h2 id="sources-h">Craft your own stream from across the web.</h2>
      <p>
        Follow RSS feeds from any website and publications across the Atmosphere, with more sources
        coming soon. You pick every source, so the stream is yours by design. No algorithm, no
        reordering, no guessing what you missed.
      </p>
    </div>

    <div class="merge" use:reveal={{ delay: 80 }}>
      <ul class="sources" aria-label="Sources Skyreader can read">
        {#each sources as s}
          <li class="source-row" class:source-row--more={s.more}>
            <span class="source-icon"><Icon name={s.icon} size={18} /></span>
            <span class="source-text">
              <span class="source-label-row">
                <span class="source-label">{s.label}</span>
                {#if s.soon}<span class="soon-badge">Soon</span>{/if}
              </span>
              <span class="source-kind">{s.kind}</span>
            </span>
          </li>
        {/each}
      </ul>

      <div class="merge-arrow" aria-hidden="true">
        <Icon name="arrow-right" size={22} />
      </div>

      <div class="stream" aria-label="Your reading stream">
        <div class="stream-head">
          <span class="stream-title">Today</span>
          <span class="stream-count">4 new</span>
        </div>
        <ul class="stream-list">
          {#each stream as item}
            <li class="stream-item">
              <span class="dot" class:dot--unread={item.unread} aria-hidden="true"></span>
              <span class="stream-item-body">
                <span class="stream-item-title">{item.title}</span>
                <span class="stream-item-meta">{item.src} · {item.time}</span>
              </span>
            </li>
          {/each}
        </ul>
      </div>
    </div>
  </section>

  <!-- ── Save what matters ─────────────────────────────────── -->
  <section class="section section--save" aria-labelledby="save-h">
    <div class="section-head" use:reveal>
      <h2 id="save-h">Save what matters.</h2>
      <p>
        Your stream moves fast, and not everything deserves the same attention. Save what matters to
        you and dive deep.
      </p>
    </div>

    <div class="save-demo" use:reveal={{ delay: 80 }}>
      <!-- The save moment: one item, pulled out of the stream. -->
      <div class="save-moment">
        <span class="dot dot--unread" aria-hidden="true"></span>
        <span class="stream-item-body">
          <span class="stream-item-title">The case for slow software</span>
          <span class="stream-item-meta">Newsletter · 2h</span>
        </span>
        <span class="save-btn" aria-hidden="true">
          <Icon name="bookmark" size={16} /> Saved
        </span>
      </div>

      <div class="save-flow" aria-hidden="true">
        <Icon name="arrow-down" size={20} />
      </div>

      <!-- The shelf: what you chose to read properly, yours and offline-ready. -->
      <div class="shelf" aria-label="Your saved reading">
        <div class="shelf-head">
          <span class="shelf-title"><Icon name="bookmark" size={15} /> To read</span>
          <span class="shelf-count">3 saved</span>
        </div>
        <ul class="shelf-list">
          {#each saved as item}
            <li class="stream-item shelf-item">
              <span class="shelf-mark" aria-hidden="true"><Icon name="bookmark" size={14} /></span>
              <span class="stream-item-body">
                <span class="stream-item-title">{item.title}</span>
                <span class="stream-item-meta">{item.meta}</span>
              </span>
              {#if item.offline}
                <span class="offline-badge"><Icon name="check" size={11} /> Offline</span>
              {/if}
            </li>
          {/each}
        </ul>
        <p class="shelf-foot">
          Saved articles come with you and read offline. Get to them when you have the time.
        </p>
      </div>
    </div>
  </section>

  <!-- ── Make sense of it all (read deeply → understanding) ── -->
  <section id="read" class="section section--sense" aria-labelledby="sense-h">
    <div class="section-head" use:reveal>
      <h2 id="sense-h">Reading is how you think.</h2>
      <p>
        A clean reading view, free of clutter. Highlight what matters, make notes, and share your
        thoughts. Engaging with what you read makes it part of how you think.
      </p>
    </div>

    <figure class="reader" use:reveal={{ delay: 80 }}>
      <div class="reader-body">
        <p class="reader-meta">
          <Icon name="rss" size={13} /> from your feeds · 5 min read
        </p>
        <h3 class="reader-title">The quiet web is still out there</h3>
        <div class="reader-prose">
          <p>
            For a while it looked like the open web had been paved over. The feeds went quiet, the
            readers shut down, and everything funneled into a handful of timelines that decided, on
            your behalf, what was worth your attention.
          </p>
          <p>
            But the plumbing never left.
            <mark class="hl reader-hl"
              >Every site you love still publishes a feed, waiting for a reader patient enough to
              collect them.
            </mark><span class="note-anchor">
              <button
                type="button"
                class="note-marker"
                aria-label="Margin note"
                aria-describedby="demo-margin-note"
              >
                <Icon name="message-circle" size={13} />
              </button>
              <span id="demo-margin-note" class="note-popup" role="tooltip" use:clampPopup>
                Connects to last week's piece on maintenance over novelty. Save for the essay.
              </span>
            </span>The web didn't disappear. We just stopped tending it.
          </p>
        </div>

        <!-- Share moment: pass the piece on with a thought of your own. -->
        <div class="reader-share">
          <label class="share-label" for="demo-share-note">
            <Icon name="share-2" size={15} /> Share to your linkblog
          </label>
          <blockquote class="share-quote">Every site you love still publishes a feed</blockquote>
          <textarea
            id="demo-share-note"
            class="share-input"
            rows="2"
            bind:value={shareNote}
            placeholder="Add a thought…"></textarea>
        </div>
      </div>
    </figure>
    <ul class="sense-points" use:reveal={{ delay: 140 }}>
      <li>
        <span class="point-icon"><Icon name="users" size={20} /></span>
        <div>
          <h3>Follow people, not algorithms</h3>
          <p>
            See what the people you trust are actually reading, through their linkblogs.
            Recommendations with a name attached.
          </p>
        </div>
      </li>
      <li>
        <span class="point-icon point-icon--tools">
          <Icon name="semble" size={18} />
          <Icon name="margin" size={18} />
        </span>
        <div>
          <h3>Carry ideas further</h3>
          <p>
            Send highlights and notes to sensemaking tools like Semble and Margin, and connect what
            you read across everything else you're thinking about.
          </p>
        </div>
      </li>
    </ul>
  </section>

  <!-- ── Foundation (quiet) ────────────────────────────────── -->
  <section class="section section--foundation" aria-labelledby="found-h">
    <div class="foundation-inner" use:reveal>
      <h2 id="found-h">Yours, and built to last.</h2>
      <p>
        Skyreader is built on the Atmosphere, the open network behind Bluesky. Your subscriptions,
        saved articles, and shares live in your own portable Atmosphere account, so they outlast any
        app, including this one.
      </p>
    </div>
  </section>

  <!-- ── Final CTA ─────────────────────────────────────────── -->
  <section class="section section--cta" aria-label="Get started">
    <div class="cta-inner" use:reveal>
      <button class="cta-primary cta-primary--lg" onclick={startReading} disabled={starting}>
        {starting ? 'Preparing your reading room…' : 'Start Reading'}
      </button>
    </div>
  </section>
</div>

<style>
  /* ── Smooth in-page scroll for the "See how it reads" jump ── */
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
    max-width: 36rem;
    margin: 0 auto;
    padding-block: clamp(3.5rem, 11vw, 7.5rem) var(--space-section);
    text-align: center;
  }
  .hero-title {
    font-size: clamp(2.5rem, 5.8vw, 3.875rem);
    font-weight: var(--weight-bold);
    line-height: 1.06;
    letter-spacing: -0.025em;
    text-wrap: balance;
  }
  .hero-title .line {
    display: block;
  }
  .hero-lead {
    margin: clamp(1.5rem, 3vw, 2rem) auto 0;
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
    justify-content: center;
    align-items: center;
    margin-top: clamp(1.75rem, 3.5vw, 2.5rem);
  }
  .hero-note {
    margin-top: 1.25rem;
    font-size: var(--text-sm);
    color: var(--muted);
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
  .cta-ghost:focus-visible,
  .note-marker:focus-visible {
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

  /* ── One place: source list merging into a stream ───────── */
  .merge {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: start;
    gap: clamp(1rem, 3vw, 2.5rem);
    max-width: 60rem;
    margin: 0 auto;
  }
  .sources {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .source-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.7rem 0.85rem;
    border: 1px solid var(--color-border);
    border-radius: 10px;
    background: var(--color-bg);
  }
  .source-icon {
    display: grid;
    place-items: center;
    width: 2rem;
    height: 2rem;
    flex-shrink: 0;
    border-radius: 8px;
    background: var(--color-bg-secondary);
    color: var(--ink);
  }
  .source-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .source-label-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .source-label {
    font-weight: var(--weight-semibold);
    font-size: var(--text-lg);
  }
  .soon-badge {
    flex-shrink: 0;
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
    background: var(--color-bg-secondary);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    padding: 0.05rem 0.45rem;
    line-height: 1.55;
  }
  .source-kind {
    font-size: var(--text-sm);
    color: var(--muted);
  }
  /* Forward-looking placeholder row: reads as "not yet", not "broken". */
  .source-row--more {
    border-style: dashed;
    background: transparent;
  }
  .source-row--more .source-icon {
    background: transparent;
    border: 1px dashed var(--color-border);
    color: var(--muted);
  }
  .source-row--more .source-label {
    color: var(--muted);
    font-weight: var(--weight-medium);
  }
  .merge-arrow {
    display: grid;
    place-items: center;
    align-self: center;
    color: var(--muted);
  }
  .stream {
    border: 1px solid var(--color-border);
    border-radius: 12px;
    background: var(--color-bg);
    overflow: hidden;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  }
  .stream-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 0.85rem 1rem;
    border-bottom: 1px solid var(--color-border);
  }
  .stream-title {
    font-weight: var(--weight-bold);
    font-size: var(--text-lg);
  }
  .stream-count {
    font-size: var(--text-sm);
    color: var(--color-primary);
    font-weight: var(--weight-medium);
  }
  .stream-list {
    list-style: none;
  }
  .stream-item {
    display: flex;
    align-items: flex-start;
    gap: 0.65rem;
    padding: 0.7rem 1rem;
  }
  .stream-item + .stream-item {
    border-top: 1px solid var(--color-border);
  }
  .dot {
    width: 7px;
    height: 7px;
    margin-top: 0.5em;
    border-radius: 50%;
    background: transparent;
    border: 1.5px solid var(--color-border);
    flex-shrink: 0;
  }
  .dot--unread {
    background: var(--color-primary);
    border-color: var(--color-primary);
  }
  .stream-item-body {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .stream-item-title {
    font-weight: var(--weight-medium);
    line-height: var(--leading-snug);
  }
  .stream-item-meta {
    font-size: var(--text-sm);
    color: var(--muted);
    margin-top: 0.1rem;
  }

  /* ── Save: a stream item flowing into the "To read" shelf ── */
  .save-demo {
    max-width: 26rem;
    margin: 0 auto;
  }
  .save-moment {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    padding: 0.8rem 1rem;
    border: 1px solid var(--color-border);
    border-radius: 12px;
    background: var(--color-bg);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  }
  .save-moment .stream-item-body {
    flex: 1;
  }
  .save-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    flex-shrink: 0;
    padding: 0.4rem 0.7rem;
    border: 1px solid var(--color-primary);
    border-radius: 8px;
    background: color-mix(in srgb, var(--color-primary) 10%, transparent);
    color: var(--color-primary);
    font-weight: var(--weight-semibold);
    font-size: var(--text-sm);
    white-space: nowrap;
  }
  .save-flow {
    display: grid;
    place-items: center;
    color: var(--muted);
    margin-block: 0.5rem;
  }
  .shelf {
    border: 1px solid var(--color-border);
    border-radius: 12px;
    background: var(--color-bg);
    overflow: hidden;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  }
  .shelf-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.85rem 1rem;
    border-bottom: 1px solid var(--color-border);
  }
  .shelf-title {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    font-weight: var(--weight-bold);
    font-size: var(--text-lg);
  }
  .shelf-count {
    font-size: var(--text-sm);
    color: var(--muted);
  }
  .shelf-list {
    list-style: none;
  }
  .shelf-item {
    align-items: center;
  }
  .shelf-item .stream-item-body {
    flex: 1;
  }
  .shelf-mark {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    color: var(--muted);
  }
  .offline-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    flex-shrink: 0;
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
    background: var(--color-bg-secondary);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    padding: 0.05rem 0.45rem 0.05rem 0.35rem;
    line-height: 1.55;
  }
  .shelf-foot {
    padding: 0.8rem 1rem;
    border-top: 1px solid var(--color-border);
    font-size: var(--text-sm);
    color: var(--muted);
    line-height: var(--leading-relaxed);
  }

  /* ── Reader demo ─────────────────────────────────────────── */
  .reader {
    max-width: 44rem;
    margin: 0 auto;
    border: 1px solid var(--color-border);
    border-radius: 14px;
    background: var(--color-bg);
    /* No overflow clipping — the margin-note popup needs to escape the card.
       The body carries the matching radius so the corners still read clean. */
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.07);
    /* Reader surface colors, kept independent of the page theme so the demo
       always reads as a clean, true-white reading room. */
    --r-bg: #ffffff;
    --r-ink: #1a1a1a;
    --r-muted: #6a6a6a;
    --r-border: #e6e6e6;
    --r-gold: 34%;
    --reader-size: 1.1875rem;
  }

  .reader-body {
    position: relative;
    padding: clamp(1.5rem, 4vw, 2.5rem);
    background: var(--r-bg);
    color: var(--r-ink);
    border-radius: inherit;
  }
  .reader-meta {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: var(--text-sm);
    color: var(--r-muted);
    margin-bottom: 0.75rem;
  }
  .reader-title {
    font-family: var(--font-literata);
    font-size: calc(var(--reader-size) * 1.6);
    font-weight: 600;
    line-height: 1.2;
    letter-spacing: -0.01em;
    margin-bottom: 1rem;
  }
  .reader-prose {
    font-family: var(--font-literata);
    font-size: var(--reader-size);
    line-height: 1.65;
    max-width: 60ch;
  }
  .reader-prose p + p {
    margin-top: 1rem;
  }

  /* Static highlight — reads as part of the prose, no interaction. */
  .reader-hl {
    background-image: linear-gradient(
      to right,
      color-mix(in srgb, var(--gold) var(--r-gold), transparent) 0,
      color-mix(in srgb, var(--gold) var(--r-gold), transparent) 100%
    );
    color: inherit;
  }

  /* Margin note: a small marker that reveals the note on hover/focus. */
  .note-anchor {
    position: relative;
  }
  .note-marker {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    vertical-align: baseline;
    position: relative;
    top: 0.08em;
    width: 1.15em;
    height: 1.15em;
    margin-left: 0.15em;
    padding: 0;
    border: none;
    background: none;
    border-radius: 50%;
    color: #9a7700;
    cursor: pointer;
    transition: background-color 0.15s ease;
  }
  .note-marker:hover,
  .note-anchor:focus-within .note-marker {
    background-color: color-mix(in srgb, var(--gold) 30%, transparent);
  }
  .note-popup {
    /* Centered under the marker so the overhang is balanced on both sides —
       keeps it clear of the card and viewport edges wherever the marker wraps
       to. The card no longer clips it (overflow is visible). */
    position: absolute;
    top: calc(100% + 8px);
    left: 50%;
    z-index: 5;
    width: max-content;
    max-width: min(16rem, 72vw);
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--r-border);
    border-radius: 10px;
    background: var(--r-bg);
    box-shadow:
      0 4px 16px rgba(0, 0, 0, 0.15),
      0 1px 2px rgba(0, 0, 0, 0.08);
    font-family: var(--font-literata);
    font-style: italic;
    font-size: calc(var(--reader-size) * 0.92);
    line-height: 1.5;
    color: var(--r-muted);
    /* Hidden until the marker is hovered or focused. */
    opacity: 0;
    transform: translate(calc(-50% + var(--nudge, 0px)), 4px);
    pointer-events: none;
    transition:
      opacity 0.16s ease,
      transform 0.16s ease;
  }
  .note-marker:hover + .note-popup,
  .note-anchor:focus-within .note-popup {
    opacity: 1;
    transform: translate(calc(-50% + var(--nudge, 0px)), 0);
  }

  /* In-reader share moment: a quote + a box for a thought of your own. */
  .reader-share {
    margin-top: clamp(1.5rem, 4vw, 2rem);
    padding-top: clamp(1.25rem, 3vw, 1.5rem);
    border-top: 1px solid var(--r-border);
  }
  .share-label {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--r-muted);
  }
  .share-quote {
    margin: 0.85rem 0 0;
    padding-left: 0.85rem;
    border-left: 2px solid color-mix(in srgb, var(--gold) 55%, transparent);
    font-family: var(--font-literata);
    font-style: italic;
    font-size: calc(var(--reader-size) * 0.95);
    line-height: 1.5;
    color: var(--r-ink);
  }
  .share-input {
    width: 100%;
    box-sizing: border-box;
    margin-top: 0.85rem;
    padding: 0.6rem 0.7rem;
    border: 1px solid var(--r-border);
    border-radius: 9px;
    resize: none;
    font: inherit;
    font-size: 1rem;
    line-height: 1.5;
    color: var(--r-ink);
    background: var(--r-bg);
    transition:
      border-color 0.15s ease,
      box-shadow 0.15s ease;
  }
  .share-input::placeholder {
    color: var(--r-muted);
  }
  .share-input:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.18);
  }

  /* ── Make sense: two supporting points beneath the reader ── */
  .sense-points {
    list-style: none;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: clamp(1.5rem, 4vw, 2.5rem);
    max-width: 44rem;
    margin: clamp(2rem, 5vw, 3rem) auto 0;
  }
  .sense-points li {
    display: flex;
    gap: 1rem;
  }
  .point-icon {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    justify-content: center;
    width: 2.75rem;
    height: 2.75rem;
    flex-shrink: 0;
    border-radius: 10px;
    background: color-mix(in srgb, var(--color-primary) 10%, transparent);
    color: var(--color-primary);
  }
  .point-icon--tools {
    color: var(--ink);
  }
  .sense-points h3 {
    font-size: var(--text-xl);
    font-weight: var(--weight-semibold);
    line-height: 1.25;
  }
  .sense-points p {
    margin-top: 0.4rem;
    color: var(--muted);
    line-height: var(--leading-relaxed);
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

  /* ── Final CTA ───────────────────────────────────────────── */
  .section--cta {
    text-align: center;
  }

  /* ── Responsive ──────────────────────────────────────────── */
  @media (max-width: 780px) {
    .merge {
      grid-template-columns: 1fr;
      gap: 1rem;
      max-width: 30rem;
    }
    .merge-arrow {
      transform: rotate(90deg);
    }
    .sense-points {
      grid-template-columns: 1fr;
      max-width: 34rem;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .note-popup {
      transition: none;
    }
  }
</style>
