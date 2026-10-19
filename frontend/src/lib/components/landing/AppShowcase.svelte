<script lang="ts">
  // The landing page's shot of the app: the real feed cards (ArticleCardView),
  // highlight popover (HighlightPopover), sidebar rows (FeedItem) and Discussion
  // panel (AtmospherePanel), fed sample data and driven by a short scripted
  // tour. Every one of those is presentational, so the landing chunk still
  // carries none of the app's data layer (see +layout.svelte).
  //
  // The frame is decoration for sighted visitors: it's inert and hidden from
  // assistive tech, and the step buttons under it carry the tour in words.
  import { onMount, tick } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import ArticleCardView from '$lib/components/ArticleCardView.svelte';
  import AtmospherePanel from '$lib/components/feed/AtmospherePanel.svelte';
  import HighlightPopover from '$lib/components/feed/HighlightPopover.svelte';
  import FeedItem from '$lib/components/sidebar/FeedItem.svelte';
  import { bracketPath, inkVariant, installMarginaliaInk } from '$lib/utils/marginaliaInk';
  import type { Subscription } from '$lib/types';
  import {
    arrivingCard,
    article,
    discussionEntries,
    discussionFilters,
    discussionLanes,
    featuredCard,
    sources,
    timelineCards,
  } from './showcaseData';

  const STEPS = [
    { id: 'follow', label: 'Follow', caption: 'Everything you follow, in one calm list' },
    { id: 'read', label: 'Read', caption: 'A clean reader for every piece' },
    { id: 'mark', label: 'Mark', caption: 'Highlights and notes in the margin' },
    { id: 'discuss', label: 'Discuss', caption: 'The conversation around it' },
    { id: 'keep', label: 'Keep', caption: 'Keep what matters' },
  ] as const;
  type StepId = (typeof STEPS)[number]['id'];

  let step = $state<StepId>('follow');

  // ── Scene state ─────────────────────────────────────────────
  let arrived = $state(false);
  let readerOpen = $state(false);
  let dragging = $state(false);
  let selected = $state(false);
  let popoverRect = $state<DOMRect | null>(null);
  let marked = $state(false);
  let noteChars = $state(0);
  let kept = $state(false);
  let toast = $state(false);
  let cursor = $state({ x: 0, y: 0, shown: false, down: false, slow: false });

  let frameEl = $state<HTMLElement | null>(null);
  let featuredEl = $state<HTMLElement | null>(null);
  let passageEl = $state<HTMLElement | null>(null);
  let readerScrollEl = $state<HTMLElement | null>(null);
  let discussionEl = $state<HTMLElement | null>(null);
  let keepBtnEl = $state<HTMLElement | null>(null);
  let passageBlockHeight = $state(0);

  const noteText = article.note;
  const inkId = 'showcase-highlight';
  const subscriptionFor = (s: (typeof sources)[number]) =>
    ({ title: s.title, customIconUrl: s.favicon, feedUrl: '' }) as unknown as Subscription;

  // ── Playback ────────────────────────────────────────────────
  // One run at a time: starting a new one (a step button, or the loop wrapping)
  // bumps runId, and any wait belonging to an older run throws Stop.
  class Stop extends Error {}
  let runId = 0;
  let visible = false;
  let hovering = false;
  let reduceMotion = false;

  async function wait(ms: number, id: number) {
    let left = ms;
    while (left > 0) {
      if (id !== runId) throw new Stop();
      // Hold still while nobody's watching: off screen, tab hidden, or a
      // visitor hovering to read the frame. Except while the highlight popover
      // is up: it listens on the whole document (Escape, outside presses), so
      // it never outstays its moment.
      const watched = (visible && !hovering && !document.hidden) || popoverRect !== null;
      const slice = watched ? Math.min(left, 100) : 400;
      await new Promise((r) => setTimeout(r, slice));
      if (watched) left -= slice;
    }
    if (id !== runId) throw new Stop();
  }

  /** Where an element's centre (plus an offset) sits inside the frame. */
  function pointAt(el: Element | null, dx = 0, dy = 0) {
    if (!el || !frameEl) return null;
    const f = frameEl.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { x: r.left - f.left + r.width / 2 + dx, y: r.top - f.top + r.height / 2 + dy };
  }

  async function moveTo(id: number, p: { x: number; y: number } | null, slow = false) {
    if (!p) return;
    cursor = { ...cursor, ...p, shown: true, slow };
    await wait(slow ? 950 : 750, id);
  }

  async function press(id: number) {
    cursor = { ...cursor, down: true };
    await wait(160, id);
    cursor = { ...cursor, down: false };
  }

  /** Put the frame in the state a step starts from, with no animation owed. */
  function setUp(s: StepId) {
    const at = STEPS.findIndex((x) => x.id === s);
    arrived = at >= 1;
    readerOpen = at >= 2;
    dragging = false;
    selected = false;
    popoverRect = null;
    marked = at >= 3;
    noteChars = at >= 3 ? noteText.length : 0;
    kept = false;
    toast = false;
    // Keep picks up where Discuss left the page; every other step starts at
    // the top of the article.
    if (readerScrollEl && s !== 'keep') readerScrollEl.scrollTop = 0;
  }

  /** The state a step ends in: what reduced motion shows for it. */
  function settle(s: StepId) {
    setUp(s);
    if (s === 'follow') arrived = true;
    if (s === 'read') readerOpen = true;
    if (s === 'mark') {
      marked = true;
      noteChars = noteText.length;
      tick().then(() => scrollToPassage(false));
    }
    if (s === 'discuss') tick().then(() => scrollToDiscussion(false));
    if (s === 'keep') kept = true;
  }

  /** Scroll the reader so `el` sits `offset` px below its top edge. */
  function scrollReaderTo(el: Element | null, offset: number, smooth: boolean) {
    if (!readerScrollEl || !el) return;
    const top =
      el.getBoundingClientRect().top -
      readerScrollEl.getBoundingClientRect().top +
      readerScrollEl.scrollTop -
      offset;
    readerScrollEl.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
  }

  const scrollToDiscussion = (smooth: boolean) => scrollReaderTo(discussionEl, 24, smooth);

  /** On a short frame (a phone) the passage starts below the fold: bring it up. */
  function scrollToPassage(smooth: boolean) {
    const block = passageEl?.closest('.passage-block') ?? frameEl?.querySelector('.passage-block');
    if (!readerScrollEl || !block) return;
    const below = block.getBoundingClientRect().top - readerScrollEl.getBoundingClientRect().top;
    if (below > readerScrollEl.clientHeight * 0.45) scrollReaderTo(block, 72, smooth);
  }

  async function playStep(s: StepId, id: number) {
    step = s;
    setUp(s);
    await tick();
    if (id !== runId) throw new Stop();
    if (s === 'follow') {
      await moveTo(id, pointAt(frameEl, 120, 40));
      await wait(700, id);
      arrived = true;
      await wait(2400, id);
    } else if (s === 'read') {
      const readerBtn = [...(featuredEl?.querySelectorAll('button') ?? [])].find((b) =>
        b.textContent?.includes('Reader')
      );
      await moveTo(id, pointAt(readerBtn ?? featuredEl));
      await press(id);
      readerOpen = true;
      await wait(1600, id);
    } else if (s === 'mark') {
      scrollToPassage(true);
      await wait(900, id);
      const r = passageEl?.getBoundingClientRect();
      if (!r) return;
      await moveTo(id, pointAt(passageEl, -r.width / 2 + 4, -r.height / 2 + 12));
      cursor = { ...cursor, down: true };
      dragging = true;
      await moveTo(id, pointAt(passageEl, r.width / 2 - 40, r.height / 2 - 12), true);
      cursor = { ...cursor, down: false };
      dragging = false;
      selected = true;
      popoverRect = passageEl?.getBoundingClientRect() ?? null;
      await wait(500, id);
      await tick();
      if (id !== runId) throw new Stop();
      await moveTo(id, pointAt(document.querySelector('.showcase-popover .popover-btn.highlight')));
      await press(id);
      popoverRect = null;
      selected = false;
      marked = true;
      await wait(900, id);
      for (let i = 1; i <= noteText.length; i++) {
        noteChars = i;
        await wait(38, id);
      }
      await wait(2000, id);
    } else if (s === 'discuss') {
      cursor = { ...cursor, shown: false };
      await wait(600, id);
      scrollToDiscussion(true);
      await wait(3800, id);
    } else if (s === 'keep') {
      await moveTo(id, pointAt(keepBtnEl));
      await press(id);
      kept = true;
      toast = true;
      await wait(1500, id);
      toast = false;
      cursor = { ...cursor, shown: false };
      readerOpen = false;
      await wait(2400, id);
    }
  }

  async function play(from: number) {
    const id = ++runId;
    try {
      for (let i = from; ; i = (i + 1) % STEPS.length) await playStep(STEPS[i].id, id);
    } catch (e) {
      if (!(e instanceof Stop)) throw e;
    }
  }

  function choose(s: StepId) {
    if (reduceMotion) {
      runId++;
      step = s;
      settle(s);
      return;
    }
    play(STEPS.findIndex((x) => x.id === s));
  }

  onMount(() => {
    installMarginaliaInk();
    reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting), {
      threshold: 0.35,
    });
    if (frameEl) io.observe(frameEl);
    if (reduceMotion) {
      step = 'mark';
      settle('mark');
    } else {
      play(0);
    }
    return () => {
      io.disconnect();
      runId++;
    };
  });

  const bracket = $derived(bracketPath(inkId, Math.max(passageBlockHeight - 8, 20)));
</script>

<div class="showcase">
  <p class="sr-only">
    A sample of the Skyreader app: new articles arrive from a blog, a newsletter, YouTube and
    Bluesky; one opens in the reader; a sentence is highlighted with a note in the margin; the
    discussion from Bluesky, blogs and Semble shows underneath; and the article is kept on the
    Shelf.
  </p>

  <!-- The frame is inert, so the pointer never lands on it; hover is read
       off this wrapper instead. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div onpointerenter={() => (hovering = true)} onpointerleave={() => (hovering = false)}>
    <div class="frame" bind:this={frameEl} aria-hidden="true" inert>
      <div class="shell">
        <aside class="side">
          <div class="account">
            <span class="avatar"></span>
            <span class="handle">you.bsky.social</span>
          </div>
          <nav class="side-nav">
            <span class="nav-item"><span class="nav-icon"><Icon name="home" /></span>Home</span>
            <div class="nav-group">
              <span class="nav-row active">
                <span class="nav-icon"><Icon name="inbox" /></span>
                <span class="nav-label">Feeds</span>
                <span class="nav-count">{arrived ? 13 : 12}</span>
              </span>
            </div>
            <span class="nav-item"><span class="nav-icon"><Icon name="bookmark" /></span>Queue</span
            >
            <span class="nav-item"><span class="nav-icon"><Icon name="shelf" /></span>Shelf</span>
            <span class="nav-item"
              ><span class="nav-icon"><Icon name="highlighter" /></span>Highlights</span
            >
            <span class="side-rule"></span>
            <span class="side-label">Sources</span>
            {#each sources as s (s.title)}
              <FeedItem
                subscription={subscriptionFor(s)}
                unreadCount={s.unread + (arrived && s.kind === 'Newsletter' ? 1 : 0)}
                isActive={false}
                onSelect={() => {}}
                onContextMenu={() => {}}
                onTouchStart={() => {}}
                onTouchEnd={() => {}}
                onTouchMove={() => {}}
                onRetry={() => {}}
                onMoreClick={() => {}}
              />
            {/each}
          </nav>
        </aside>

        <section class="main">
          <header class="toolbar">
            <span class="tool-title"><Icon name="inbox" size={18} /> Feeds</span>
            <span class="tool-status">Updated just now <Icon name="refresh-cw" size={13} /></span>
            <span class="tool-spacer"></span>
            <span class="tool-btn"><Icon name="list" size={15} /> List</span>
            <span class="tool-btn on"><Icon name="newspaper" size={15} /> Expand</span>
            <span class="tool-btn"><Icon name="type" size={15} /> Style</span>
          </header>
          <div class="card-surface">
            <div class="cards">
              {#if arrived}
                <div class="arrive">
                  <ArticleCardView {...arrivingCard} />
                </div>
              {/if}
              {#each timelineCards as c (c.itemUrl)}
                {#if c === featuredCard}
                  <div bind:this={featuredEl}>
                    <ArticleCardView {...c} isSaved={kept && !readerOpen} />
                  </div>
                {:else}
                  <ArticleCardView {...c} />
                {/if}
              {/each}
            </div>
          </div>
        </section>
      </div>

      <!-- The reader, over the whole window, as it opens in the app. -->
      <div class="reader" class:open={readerOpen}>
        <header class="reader-bar">
          <span class="r-btn"><Icon name="arrow-left" size={16} /><span>Back</span></span>
          <span class="r-actions">
            <span class="r-btn"><Icon name="type" size={16} /><span>Style</span></span>
            <span class="r-btn hide-narrow"><Icon name="share" size={16} /><span>Share</span></span>
            <span class="r-btn hide-narrow"
              ><Icon name="thumbs-up" size={16} /><span>Recommend</span></span
            >
            <span class="r-btn" class:kept bind:this={keepBtnEl}>
              <Icon name={kept ? 'check' : 'shelf'} size={16} />
              <span>{kept ? 'On Shelf' : 'Keep on Shelf'}</span>
            </span>
          </span>
        </header>
        <div class="reader-scroll" bind:this={readerScrollEl}>
          <article class="reader-col">
            <h3 class="r-title">{article.title}</h3>
            <p class="r-meta">
              <img src={article.favicon} alt="" class="r-favicon" />
              <span class="r-source">{article.source}</span>
              <span>by {article.author}</span>
              <span><Icon name="clock" size={13} /> {article.readTime}</span>
            </p>
            <div class="r-body marginalia-ink">
              <p>{article.before}</p>
              <div class="passage-block" bind:clientHeight={passageBlockHeight}>
                <p>
                  {article.passageLead}{#if marked}<mark
                      class="highlight ink-drawing"
                      data-ink={String(inkVariant(inkId))}>{article.passage}</mark
                    >{:else}<span class="sel" class:dragging class:selected bind:this={passageEl}
                      >{article.passage}</span
                    >{/if}{article.passageTail}
                </p>
                {#if marked}
                  <div class="note">
                    <svg
                      class="bracket"
                      width="12"
                      height={Math.max(passageBlockHeight - 8, 20)}
                      viewBox="0 0 12 {Math.max(passageBlockHeight - 8, 20)}"
                    >
                      <path d={bracket} />
                    </svg>
                    <p class="note-text">{noteText.slice(0, noteChars)}</p>
                  </div>
                {/if}
              </div>
              <p>{article.after}</p>
            </div>
            <div class="discussion" bind:this={discussionEl}>
              <AtmospherePanel
                laneRow={discussionLanes}
                filters={discussionFilters}
                activeFilter="all"
                stream={{ loading: false, entries: discussionEntries }}
                lanesOpen
                itemUrl={featuredCard.itemUrl}
                showHeading
              />
            </div>
          </article>
        </div>
        {#if toast}
          <div class="toast"><Icon name="check" size={14} /> Kept on your Shelf</div>
        {/if}
      </div>

      {#if popoverRect}
        <div class="showcase-popover">
          <HighlightPopover
            mode="create"
            anchorRect={popoverRect}
            getAnchorRect={() => passageEl?.getBoundingClientRect() ?? popoverRect!}
            onHighlight={() => {}}
            onClose={() => (popoverRect = null)}
          />
        </div>
      {/if}

      <span
        class="cursor"
        class:shown={cursor.shown}
        class:down={cursor.down}
        class:slow={cursor.slow}
        style:transform="translate({cursor.x}px, {cursor.y}px)"
      >
        <svg viewBox="0 0 24 24" width="22" height="22"
          ><path
            d="M5 3l14 8-6.5 1.5L9 19z"
            fill="#1a1a1a"
            stroke="#fff"
            stroke-width="1.5"
            stroke-linejoin="round"
          /></svg
        >
      </span>
    </div>
  </div>

  <div class="steps" role="group" aria-label="Tour of the app">
    {#each STEPS as s, i (s.id)}
      <button
        type="button"
        class="step"
        class:on={step === s.id}
        aria-pressed={step === s.id}
        onclick={() => choose(s.id)}
      >
        <span class="step-n">{i + 1}</span>
        <span class="step-text">
          <span class="step-label">{s.label}</span>
          <span class="step-caption">{s.caption}</span>
        </span>
      </button>
    {/each}
  </div>
  <p class="sample">Sample sources, articles and people.</p>
</div>

<style>
  .showcase {
    --frame-h: clamp(30rem, 62vh, 42rem);
    width: 100%;
    max-width: 76rem;
    margin: 0 auto;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  /* ── The window ──────────────────────────────────────────── */
  .frame {
    position: relative;
    height: var(--frame-h);
    overflow: hidden;
    border: 1px solid var(--color-border);
    border-radius: 14px;
    background: var(--color-canvas, var(--color-bg-secondary));
    box-shadow:
      0 24px 60px -24px rgba(0, 0, 0, 0.25),
      0 2px 6px rgba(0, 0, 0, 0.05);
    text-align: left;
    user-select: none;
  }
  .shell {
    display: grid;
    grid-template-columns: 15rem minmax(0, 1fr);
    height: 100%;
    padding: 0 0.5rem 0.5rem 0;
  }

  /* Sidebar: the rail's own rows, at the app's density. */
  .side {
    padding: 0 0.5rem;
    overflow: hidden;
    color: var(--color-text);
  }
  .account {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-height: var(--shell-bar-height, 2.75rem);
    padding: 0 0.75rem;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
  }
  .avatar {
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 50%;
    background: color-mix(in srgb, var(--color-primary) 35%, var(--color-border));
  }
  .side-nav {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.5rem 0;
  }
  .nav-item,
  .nav-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
    border-radius: 12px;
    font-size: var(--text-md);
  }
  .nav-row.active {
    background-color: var(--color-sidebar-active, rgba(0, 102, 204, 0.1));
    color: var(--color-primary);
  }
  .nav-icon {
    flex-shrink: 0;
    width: 1.25rem;
    display: flex;
    justify-content: center;
  }
  .nav-label {
    flex: 1;
  }
  .nav-count {
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }
  .side-rule {
    height: 1px;
    background: var(--color-border);
    margin: 0.5rem 0.75rem;
  }
  .side-label {
    padding: 0 0.75rem;
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--color-text-secondary);
  }

  /* Main column: toolbar strip over the card, as AppShell lays it out. */
  .main {
    display: grid;
    grid-template-rows: var(--shell-bar-height, 2.75rem) minmax(0, 1fr);
    min-width: 0;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0 0.5rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    white-space: nowrap;
    overflow: hidden;
  }
  .tool-title {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: var(--text-xl);
    font-weight: var(--weight-semibold);
    color: var(--color-text);
  }
  .tool-status,
  .tool-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  .tool-spacer {
    flex: 1;
  }
  .tool-btn {
    padding: 0.3rem 0.6rem;
    border-radius: 6px;
  }
  .tool-btn.on {
    background: var(--color-bg);
    color: var(--color-text);
  }
  .card-surface {
    overflow: hidden;
    border: 1px solid var(--color-border);
    border-radius: var(--shell-radius, 12px);
    background: var(--color-bg);
  }
  .cards {
    padding: 0.75rem clamp(0.75rem, 2vw, 1.5rem);
  }
  .arrive {
    overflow: clip;
    animation: arrive 0.7s cubic-bezier(0.2, 0.7, 0.2, 1);
  }
  @keyframes arrive {
    from {
      opacity: 0;
      transform: translateY(-12px);
      max-height: 0;
    }
    to {
      opacity: 1;
      transform: none;
      max-height: 20rem;
    }
  }

  /* ── The reader ──────────────────────────────────────────── */
  .reader {
    position: absolute;
    inset: 0;
    z-index: 5;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    background: var(--color-bg);
    transform: translateY(100%);
    opacity: 0;
    transition:
      transform 0.55s cubic-bezier(0.2, 0.7, 0.2, 1),
      opacity 0.3s ease;
  }
  .reader.open {
    transform: none;
    opacity: 1;
  }
  .reader-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.625rem 1rem;
    border-bottom: 1px solid var(--color-border);
  }
  .r-actions {
    display: flex;
    gap: 0.5rem;
  }
  .r-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.4rem 0.6rem;
    border-radius: 6px;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    white-space: nowrap;
    transition:
      background-color 0.2s,
      color 0.2s;
  }
  .r-btn.kept {
    color: var(--color-primary);
    background: color-mix(in srgb, var(--color-primary) 10%, transparent);
  }
  .reader-scroll {
    overflow: hidden;
  }
  .reader-col {
    max-width: 40rem;
    margin: 0 auto;
    padding: 1.75rem 1.25rem 3rem;
    /* Room for the margin note, as the reader keeps on wide screens. */
    transform: translateX(-5rem);
  }
  .r-title {
    font-size: var(--text-4xl);
    font-weight: var(--weight-bold);
    line-height: var(--leading-tight);
    margin: 0 0 0.75rem;
  }
  .r-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1.75rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }
  .r-meta span {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }
  .r-favicon {
    width: 16px;
    height: 16px;
    border-radius: 3px;
  }
  .r-source {
    font-weight: var(--weight-medium);
  }
  .r-body {
    font-family: var(--article-font, Georgia, serif);
    font-size: var(--article-font-size, 1.0625rem);
    line-height: 1.8;
  }
  .r-body .passage-block,
  .r-body .passage-block + p {
    margin-top: 1rem;
  }
  .passage-block {
    position: relative;
  }
  /* A drag selection, drawn rather than real so the tour never touches the
     visitor's own selection. */
  .sel {
    background-image: linear-gradient(rgba(0, 102, 204, 0.22), rgba(0, 102, 204, 0.22));
    background-repeat: no-repeat;
    background-size: 0% 100%;
    -webkit-box-decoration-break: clone;
    box-decoration-break: clone;
  }
  .sel.dragging {
    transition: background-size 0.9s linear;
    background-size: 100% 100%;
  }
  .sel.selected {
    background-size: 100% 100%;
  }
  .note {
    position: absolute;
    top: 4px;
    left: calc(100% + 1rem);
    display: flex;
    gap: 0.6rem;
    width: 11rem;
  }
  .bracket {
    flex-shrink: 0;
    overflow: visible;
  }
  .bracket path {
    fill: none;
    stroke: var(--ink-note-soft);
    stroke-width: 1.3;
    stroke-linecap: round;
  }
  .note-text {
    margin: 0;
    font-family: var(--font-hand);
    font-size: 1rem;
    line-height: 1.35;
    color: var(--ink-note);
  }
  .discussion {
    margin-top: 2.5rem;
  }
  .toast {
    position: absolute;
    left: 50%;
    bottom: 1.25rem;
    transform: translateX(-50%);
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.55rem 0.9rem;
    border-radius: 999px;
    background: var(--color-text);
    color: var(--color-bg);
    font-size: var(--text-sm);
    animation: toast-in 0.35s ease;
  }
  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translate(-50%, 8px);
    }
  }

  /* ── Cursor ──────────────────────────────────────────────── */
  .cursor {
    position: absolute;
    top: 0;
    left: 0;
    z-index: 20;
    pointer-events: none;
    opacity: 0;
    transition:
      transform 0.7s cubic-bezier(0.45, 0, 0.2, 1),
      opacity 0.3s;
  }
  .cursor.slow {
    transition:
      transform 0.9s linear,
      opacity 0.3s;
  }
  .cursor.shown {
    opacity: 1;
  }
  .cursor svg {
    display: block;
    transition: transform 0.12s;
    filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.3));
  }
  .cursor.down svg {
    transform: scale(0.85);
  }

  /* ── Steps ───────────────────────────────────────────────── */
  .steps {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 0.5rem;
    margin-top: 1.25rem;
  }
  .step {
    display: flex;
    gap: 0.6rem;
    padding: 0.75rem 0.5rem 0.25rem;
    border: 0;
    border-top: 2px solid var(--color-border);
    background: none;
    text-align: left;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition:
      color 0.2s,
      border-color 0.2s;
  }
  .step.on {
    border-top-color: var(--color-primary);
    color: var(--color-text);
  }
  .step:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
    border-radius: 4px;
  }
  .step-n {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }
  .step.on .step-n {
    color: var(--color-primary);
  }
  .step-text {
    display: grid;
    gap: 0.15rem;
  }
  .step-label {
    font-weight: var(--weight-semibold);
  }
  .step-caption {
    font-size: var(--text-sm);
    line-height: 1.35;
  }
  .sample {
    margin-top: 0.75rem;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    text-align: center;
  }

  /* Reduced motion gets each step's end state, with nothing sliding there. */
  @media (prefers-reduced-motion: reduce) {
    .frame *,
    .frame *::before,
    .frame *::after {
      animation: none !important;
      transition: none !important;
    }
  }

  @media (max-width: 1000px) {
    .shell {
      grid-template-columns: minmax(0, 1fr);
      padding: 0 0.5rem 0.5rem;
    }
    .side {
      display: none;
    }
    .reader-col {
      transform: none;
    }
    .note {
      position: static;
      width: auto;
      margin-top: 0.5rem;
    }
    .bracket {
      display: none;
    }
  }
  @media (max-width: 700px) {
    .showcase {
      --frame-h: 32rem;
    }
    .hide-narrow,
    .tool-btn,
    .tool-status {
      display: none;
    }
    .r-title {
      font-size: var(--text-3xl);
    }
    .steps {
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 0.25rem;
    }
    .step {
      flex-direction: column;
      gap: 0.25rem;
      padding-inline: 0.15rem;
    }
    .step-caption {
      display: none;
    }
  }
</style>
