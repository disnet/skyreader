<script lang="ts">
  // The landing page's shot of the app: the real feed cards (ArticleCardView),
  // marker ink (marginaliaInk), sidebar rows (FeedItem) and Discussion
  // panel (AtmospherePanel), fed sample data and driven by a short scripted
  // tour. Every one of those is presentational, so the landing chunk still
  // carries none of the app's data layer (see +layout.svelte).
  //
  // The frame is decoration for sighted visitors: it's inert and hidden from
  // assistive tech, and the step buttons under it carry the tour in words.
  //
  // With `opening`, the shot starts as the web's clutter (WebGather) settling
  // onto its feed cards, and the tour plays once it has landed.
  import { onMount, tick, untrack } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import WebGather from './WebGather.svelte';
  import ArticleCardView from '$lib/components/ArticleCardView.svelte';
  import AtmospherePanel from '$lib/components/feed/AtmospherePanel.svelte';
  import FeedItem from '$lib/components/sidebar/FeedItem.svelte';
  import { bracketPath, inkVariant, installMarginaliaInk } from '$lib/utils/marginaliaInk';
  import type { Subscription } from '$lib/types';
  import {
    article,
    discussionEntries,
    discussionFilters,
    discussionLanes,
    featuredCard,
    keptShelfItem,
    shelfItems,
    sources,
    timelineCards,
  } from './showcaseData';

  // `ms` is how long each step holds the frame. The scene plays inside it and
  // the rest is a pause to look, so the step's progress bar runs at a steady
  // rate from empty to full.
  interface Props {
    /** Open on the web's clutter settling onto the feed. */
    opening?: boolean;
    /** The clutter is gone; the page can finish its headline. */
    onsettle?: () => void;
  }
  let { opening = false, onsettle }: Props = $props();

  const STEPS = [
    { id: 'follow', label: 'Follow', caption: 'Everything you follow, in one calm list', ms: 6500 },
    { id: 'read', label: 'Read', caption: 'A clean reader for every piece', ms: 6000 },
    { id: 'mark', label: 'Mark', caption: 'Highlights and notes in the margin', ms: 12000 },
    { id: 'discuss', label: 'Discuss', caption: 'The conversation around it', ms: 8000 },
    { id: 'keep', label: 'Keep', caption: 'Keep what matters', ms: 14000 },
  ] as const;
  type StepId = (typeof STEPS)[number]['id'];

  let step = $state<StepId>('follow');
  // Watched time spent in the current step, for its progress bar.
  let elapsed = $state(0);
  const stepIndex = $derived(STEPS.findIndex((x) => x.id === step));
  // Under reduced motion each step simply shows its end state.
  const reduceMotion =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // While the opening plays, the frame waits underneath, hidden. It plays
  // once, on mount, so a later change to `opening` means nothing.
  const playOpening = untrack(() => opening) && !reduceMotion;
  let gathering = $state(playOpening);
  let frameShown = $state(!playOpening);

  // ── Scene state ─────────────────────────────────────────────
  let readerOpen = $state(false);
  let marked = $state(false);
  let noteChars = $state(0);
  let kept = $state(false);
  let toast = $state(false);
  // Which page the main column shows: the feed list, or the Shelf the tour ends on.
  let view = $state<'feeds' | 'queue' | 'shelf'>('feeds');
  // `text` swaps the arrow for an I-beam over the article.
  let cursor = $state({ x: 0, y: 0, shown: false, down: false, text: false });

  let frameEl = $state<HTMLElement | null>(null);
  let cardEls = $state<(HTMLElement | null)[]>([]);
  const featuredEl = $derived(cardEls[timelineCards.indexOf(featuredCard)] ?? null);
  let passageEl = $state<HTMLElement | null>(null);
  let readerScrollEl = $state<HTMLElement | null>(null);
  let discussionEl = $state<HTMLElement | null>(null);
  let keepBtnEl = $state<HTMLElement | null>(null);
  let libraryNavEl = $state<HTMLElement | null>(null);
  let shelfTabEl = $state<HTMLElement | null>(null);
  let passageBlockHeight = $state(0);

  const noteText = article.note;
  // The Queue the Library opens on: the kept article and a few other saves.
  const queueItems = [keptShelfItem, shelfItems[1], shelfItems[0], shelfItems[3]];
  const inkId = 'showcase-highlight';
  const subscriptionFor = (s: (typeof sources)[number]) =>
    ({ title: s.title, customIconUrl: s.favicon, feedUrl: '' }) as unknown as Subscription;

  // ── Playback ────────────────────────────────────────────────
  // One run at a time: starting a new one (a step button)
  // bumps runId, and any wait belonging to an older run throws Stop.
  class Stop extends Error {}
  let runId = 0;
  let visible = false;

  async function wait(ms: number, id: number) {
    let left = ms;
    while (left > 0) {
      if (id !== runId) throw new Stop();
      // Hold still while nobody's watching: off screen or tab hidden. (Not on
      // hover: a pointer resting mid-screen sits on the frame and would freeze
      // it with nothing to say so.)
      const watched = visible && !document.hidden;
      const slice = watched ? Math.min(left, 100) : 400;
      await new Promise((r) => setTimeout(r, slice));
      if (watched && id === runId) {
        left -= slice;
        elapsed += slice;
      }
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

  async function moveTo(id: number, p: { x: number; y: number } | null, text = false) {
    if (!p) return;
    cursor = { ...cursor, ...p, shown: true, text };
    await wait(1100, id);
  }

  async function press(id: number) {
    cursor = { ...cursor, down: true };
    await wait(160, id);
    cursor = { ...cursor, down: false };
  }

  /** Put the frame in the state a step starts from, with no animation owed. */
  function setUp(s: StepId) {
    const at = STEPS.findIndex((x) => x.id === s);
    readerOpen = at >= 2;
    marked = at >= 3;
    noteChars = at >= 3 ? noteText.length : 0;
    kept = false;
    toast = false;
    view = 'feeds';
    // A jump can land mid-press; don't carry a pressed cursor into the next step.
    cursor = { ...cursor, down: false, text: false };
    // Discuss scrolls on from where Mark left the article, and Keep from where
    // Discuss did; the steps before them start at the top.
    if (readerScrollEl && at < 3) readerScrollEl.scrollTop = 0;
  }

  /** The state a step ends in: what reduced motion shows for it. */
  function settle(s: StepId) {
    setUp(s);
    if (s === 'read') readerOpen = true;
    if (s === 'mark') {
      marked = true;
      noteChars = noteText.length;
      tick().then(() => scrollToPassage(false));
    }
    if (s === 'discuss') tick().then(() => scrollToDiscussion(false));
    if (s === 'keep') {
      kept = true;
      readerOpen = false;
      view = 'shelf';
    }
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
    elapsed = 0;
    setUp(s);
    await tick();
    if (id !== runId) throw new Stop();
    if (s === 'follow') {
      // Down the sources, then over to the first piece in the list.
      const rows = frameEl?.querySelectorAll(
        '.side-nav > :not(.nav-item):not(.nav-group):not(.side-rule):not(.side-label)'
      );
      await moveTo(id, pointAt(rows?.[0] ?? null, -20));
      await moveTo(id, pointAt(rows?.[rows.length - 1] ?? null, -20));
      await moveTo(id, pointAt(featuredEl, 0, -40));
    } else if (s === 'read') {
      await wait(400, id);
      const readerBtn = [...(featuredEl?.querySelectorAll('button') ?? [])].find((b) =>
        b.textContent?.includes('Reader')
      );
      await moveTo(id, pointAt(readerBtn ?? featuredEl));
      await press(id);
      readerOpen = true;
    } else if (s === 'mark') {
      // Double-click a paragraph to highlight all of it, as in the reader.
      scrollToPassage(true);
      await wait(1200, id);
      await moveTo(id, pointAt(passageEl, 0, -8), true);
      await wait(500, id);
      await press(id);
      await wait(90, id);
      await press(id);
      marked = true;
      await wait(900, id);
      cursor = { ...cursor, shown: false };
      await wait(600, id);
      for (let i = 1; i <= noteText.length; i++) {
        noteChars = i;
        await wait(55, id);
      }
    } else if (s === 'discuss') {
      cursor = { ...cursor, shown: false };
      await wait(1000, id);
      scrollToDiscussion(true);
    } else if (s === 'keep') {
      await wait(400, id);
      await moveTo(id, pointAt(keepBtnEl));
      await press(id);
      kept = true;
      toast = true;
      await wait(1600, id);
      toast = false;
      readerOpen = false;
      await wait(1000, id);
      // Library in the sidebar opens the Queue, as it does in the app; the
      // switch at its top turns to the Shelf. On a phone the sidebar is hidden,
      // so the Library simply opens.
      if (libraryNavEl?.offsetParent) {
        await moveTo(id, pointAt(libraryNavEl, -30));
        await press(id);
      }
      view = 'queue';
      await wait(900, id);
      await tick();
      await moveTo(id, pointAt(shelfTabEl));
      await press(id);
      view = 'shelf';
      await wait(600, id);
      cursor = { ...cursor, shown: false };
    }
    // Hold what the scene left for the rest of the step.
    const total = STEPS.find((x) => x.id === s)!.ms;
    await wait(Math.max(total - elapsed, 600), id);
  }

  async function play(from: number) {
    const id = ++runId;
    try {
      // Plays through once and stays on the Shelf; a step button replays from there.
      for (let i = from; i < STEPS.length; i++) await playStep(STEPS[i].id, id);
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
    if (!gathering) play(STEPS.findIndex((x) => x.id === s));
  }

  /** The step's progress bar: done, playing (by watched time), or to come. */
  function fill(i: number) {
    if (i < stepIndex) return 1;
    if (i > stepIndex) return 0;
    return reduceMotion ? 1 : Math.min(elapsed / STEPS[i].ms, 1);
  }

  function gathered() {
    gathering = false;
    play(0);
  }

  let showcaseEl = $state<HTMLElement | null>(null);
  let restored = 0;

  onMount(() => {
    installMarginaliaInk();
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting), {
      threshold: 0.35,
    });
    if (frameEl) io.observe(frameEl);
    if (reduceMotion) {
      step = 'mark';
      settle('mark');
      onsettle?.();
    } else if (!opening) {
      onsettle?.();
      play(0);
    } else {
      // Back on the page below the top of the shot (the back button, a
      // restored scroll), the opening would play out of sight: skip to the tour.
      const skip = () => {
        if (!gathering || !showcaseEl || showcaseEl.getBoundingClientRect().top >= 0) return;
        frameShown = true;
        onsettle?.();
        gathered();
      };
      skip();
      restored = requestAnimationFrame(skip);
    }
    return () => {
      io.disconnect();
      cancelAnimationFrame(restored);
      runId++;
    };
  });

  const bracket = $derived(bracketPath(inkId, Math.max(passageBlockHeight - 8, 20)));
</script>

<div class="showcase" bind:this={showcaseEl}>
  <p class="sr-only">
    A sample of the Skyreader app: articles from a blog, a newsletter, YouTube and Bluesky in one
    list; one opens in the reader; a sentence is highlighted with a note in the margin; the
    discussion from Bluesky, blogs and Semble shows underneath; and the article is kept on the
    Shelf.
  </p>

  <div class="stage" class:veiled={!frameShown}>
    {#if gathering}
      <WebGather
        targets={() => cardEls}
        frame={() => frameEl}
        onsettle={() => onsettle?.()}
        onland={() => (frameShown = true)}
        ondone={gathered}
      />
    {/if}

    <div>
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
                <span class="nav-row" class:active={view === 'feeds'}>
                  <span class="nav-icon"><Icon name="inbox" /></span>
                  <span class="nav-label">Feeds</span>
                  <span class="nav-count">12</span>
                </span>
              </div>
              <span class="nav-row" class:active={view !== 'feeds'} bind:this={libraryNavEl}>
                <span class="nav-icon"><Icon name="shelf" /></span>
                <span class="nav-label">Library</span>
                <span class="nav-count">3</span>
              </span>
              <span class="nav-item"
                ><span class="nav-icon"><Icon name="highlighter" /></span>Highlights</span
              >
              <span class="side-rule"></span>
              <span class="side-label">Sources</span>
              {#each sources as s (s.title)}
                <FeedItem
                  subscription={subscriptionFor(s)}
                  unreadCount={s.unread}
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
            {#if view !== 'feeds'}
              <header class="toolbar">
                <span class="tool-title"
                  ><Icon name={view === 'shelf' ? 'shelf' : 'bookmark'} size={18} />
                  {view === 'shelf' ? 'Shelf' : 'Queue'}</span
                >
              </header>
              <div class="card-surface">
                <div class="shelf">
                  <div class="lib-switch">
                    <span class:on={view === 'queue'}>Queue</span>
                    <span class:on={view === 'shelf'} bind:this={shelfTabEl}>Shelf</span>
                  </div>
                  {#if view === 'queue'}
                    <div class="queue">
                      {#each queueItems as q (q.title)}
                        <div class="queue-row">
                          <Icon name={q.kind === 'Article' ? 'file-text' : 'book-open'} size={16} />
                          <span class="queue-text">
                            <span class="queue-title">{q.title}</span>
                            <span class="shelf-meta"><b>{q.kind}</b> {q.byline}</span>
                          </span>
                        </div>
                      {/each}
                    </div>
                  {:else}
                    <div class="shelf-filters">
                      <span class="shelf-chip">Everything {shelfItems.length + 1}</span>
                      <span class="kind-switch"
                        ><span class="on">All</span><span>Books</span><span>PDFs</span><span
                          >Articles</span
                        ></span
                      >
                    </div>
                    <p class="shelf-label">Everything</p>
                    <div class="shelf-grid">
                      {#each [keptShelfItem, ...shelfItems] as item (item.title)}
                        <div class="shelf-card" class:fresh={item === keptShelfItem}>
                          <div class="cover" data-cover={item.cover}>
                            <span class="cover-title">{item.title}</span>
                            {#if item.excerpt}<span class="cover-excerpt">{item.excerpt}</span>{/if}
                            <span class="cover-author">{item.byline}</span>
                            {#if item.percent}
                              <span class="cover-progress"
                                ><span style:width="{item.percent}%"></span></span
                              >
                            {/if}
                          </div>
                          <span class="shelf-title">{item.title}</span>
                          <span class="shelf-meta"><b>{item.kind}</b> {item.byline}</span>
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>
              </div>
            {:else}
              <header class="toolbar">
                <span class="tool-title"><Icon name="inbox" size={18} /> Feeds</span>
                <span class="tool-status"
                  >Updated just now <Icon name="refresh-cw" size={13} /></span
                >
                <span class="tool-spacer"></span>
                <span class="tool-btn"><Icon name="list" size={15} /> List</span>
                <span class="tool-btn on"><Icon name="newspaper" size={15} /> Expand</span>
                <span class="tool-btn"><Icon name="type" size={15} /> Style</span>
              </header>
              <div class="card-surface">
                <div class="cards">
                  {#each timelineCards as c, i (c.itemUrl)}
                    <div bind:this={cardEls[i]}>
                      {#if c === featuredCard}
                        <ArticleCardView {...c} isSaved={kept && !readerOpen} />
                      {:else}
                        <ArticleCardView {...c} />
                      {/if}
                    </div>
                  {/each}
                </div>
              </div>
            {/if}
          </section>
        </div>

        <!-- The reader, over the whole window, as it opens in the app. -->
        <div class="reader" class:open={readerOpen}>
          <header class="reader-bar">
            <span class="r-btn"><Icon name="arrow-left" size={16} /><span>Back</span></span>
            <span class="r-actions">
              <span class="r-btn"><Icon name="type" size={16} /><span>Style</span></span>
              <span class="r-btn hide-narrow"
                ><Icon name="share" size={16} /><span>Share</span></span
              >
              <span class="r-btn hide-narrow"
                ><Icon name="thumbs-up" size={16} /><span>Recommend</span></span
              >
              <span class="r-btn" class:kept bind:this={keepBtnEl}>
                <Icon name={kept ? 'check' : 'shelf'} size={16} />
                <span>{kept ? 'On Shelf' : 'Add to Shelf'}</span>
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
                  <p bind:this={passageEl}>
                    {#if marked}<mark
                        class="highlight ink-drawing"
                        data-ink={String(inkVariant(inkId))}>{article.passage}</mark
                      >{:else}{article.passage}{/if}
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
            <div class="toast"><Icon name="check" size={14} /> Added to your Shelf</div>
          {/if}
        </div>

        <span
          class="cursor"
          class:shown={cursor.shown}
          class:down={cursor.down}
          class:text={cursor.text}
          style:transform="translate({cursor.x}px, {cursor.y}px)"
        >
          {#if cursor.text}
            <svg class="ibeam" viewBox="0 0 12 24" width="12" height="24"
              ><path
                d="M3 3h2.5L6 4l.5-1H9M6 4v16M3 21h2.5L6 20l.5 1H9"
                fill="none"
                stroke="#1a1a1a"
                stroke-width="1.4"
                stroke-linecap="round"
              /></svg
            >
          {:else}
            <svg viewBox="0 0 24 24" width="22" height="22"
              ><path
                d="M5 3l14 8-6.5 1.5L9 19z"
                fill="#1a1a1a"
                stroke="#fff"
                stroke-width="1.5"
                stroke-linejoin="round"
              /></svg
            >
          {/if}
        </span>
      </div>
    </div>

    <div class="steps" role="group" aria-label="Tour of the app" inert={gathering}>
      {#each STEPS as s, i (s.id)}
        <button
          type="button"
          class="step"
          class:on={step === s.id}
          aria-pressed={step === s.id}
          onclick={() => choose(s.id)}
        >
          <span class="step-bar" aria-hidden="true">
            <span class="step-fill" style:transform="scaleX({fill(i)})"></span>
          </span>
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
</div>

<style>
  .showcase {
    --frame-h: clamp(30rem, 62vh, 42rem);
    width: 100%;
    max-width: 76rem;
    margin: 0 auto;
  }
  .stage {
    position: relative;
  }
  /* The frame and its steps wait under the opening, then fade in as it lands. */
  .stage > div:not(:global(.gather)),
  .steps,
  .sample {
    transition: opacity 0.7s cubic-bezier(0.22, 0.8, 0.24, 1);
  }
  .stage.veiled > div:not(:global(.gather)),
  .veiled .steps,
  .veiled .sample {
    opacity: 0;
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
  /* The Shelf, as shelf/ShelfItem draws its grid. */
  .shelf {
    padding: 1rem clamp(0.75rem, 2vw, 1.5rem);
    animation: fade-in 0.45s ease;
  }
  .lib-switch {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-bg-secondary);
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    color: var(--color-text-secondary);
  }
  .lib-switch span {
    padding: 0.3125rem 1rem;
    border-radius: 6px;
  }
  .lib-switch .on {
    background: var(--color-bg);
    color: var(--color-text);
    box-shadow: 0 0 0 1px var(--color-border);
  }
  .shelf-filters {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
  .kind-switch {
    display: inline-flex;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    overflow: hidden;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }
  .kind-switch span {
    padding: 0.25rem 0.65rem;
  }
  .kind-switch span + span {
    border-left: 1px solid var(--color-border);
  }
  .kind-switch .on {
    background: color-mix(in srgb, var(--color-primary) 8%, transparent);
    color: var(--color-primary);
  }
  .queue {
    margin-top: 0.75rem;
    animation: fade-in 0.35s ease;
  }
  .queue-row {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.75rem 0.5rem;
    border-bottom: 1px solid var(--color-border);
    color: var(--color-text-secondary);
  }
  .queue-text {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 0;
  }
  .queue-title {
    font-size: var(--text-lg);
    font-weight: var(--weight-medium);
    line-height: var(--leading-snug);
    color: var(--color-text);
  }
  .shelf-chip {
    display: inline-block;
    padding: 0.3rem 0.8rem;
    border: 1px solid var(--color-primary);
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-primary) 8%, transparent);
    color: var(--color-primary);
    font-size: var(--text-sm);
  }
  .shelf-label {
    margin: 1.25rem 0 0.6rem;
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--color-text-secondary);
  }
  .shelf-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(8.5rem, 1fr));
    gap: 1.25rem 1rem;
  }
  .shelf-card {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .shelf-card.fresh {
    animation: shelf-in 0.8s cubic-bezier(0.2, 0.7, 0.2, 1) 0.2s both;
  }
  .cover {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    aspect-ratio: 2 / 3;
    padding: 0.875rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    overflow: hidden;
    background: var(--color-bg-secondary);
  }
  .cover[data-cover='pdf'] {
    background: var(--color-bg);
  }
  .cover[data-cover='book'] {
    border-left: 6px solid var(--color-border);
  }
  .cover-title {
    font-family: var(--font-serif);
    font-size: var(--text-lg);
    line-height: var(--leading-tight);
  }
  .cover[data-cover='article'] .cover-title {
    font-size: var(--text-md);
  }
  .cover-excerpt {
    flex: 1 1 0;
    min-height: 0;
    overflow: hidden;
    font-family: var(--font-serif);
    font-size: var(--text-xs);
    line-height: var(--leading-normal);
    color: var(--color-text-secondary);
    -webkit-mask-image: linear-gradient(to bottom, #000 55%, transparent);
    mask-image: linear-gradient(to bottom, #000 55%, transparent);
  }
  .cover-author {
    margin-top: auto;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }
  .cover-progress {
    position: absolute;
    inset: auto 0 0 0;
    height: 3px;
    background: rgba(0, 0, 0, 0.08);
  }
  .cover-progress span {
    display: block;
    height: 100%;
    background: var(--color-primary);
  }
  .shelf-title {
    margin-top: 0.5rem;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    line-height: var(--leading-snug);
  }
  .shelf-meta {
    margin-top: 0.125rem;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }
  .shelf-meta b {
    font-weight: var(--weight-medium);
  }
  @keyframes fade-in {
    from {
      opacity: 0;
    }
  }
  @keyframes shelf-in {
    from {
      opacity: 0;
      transform: translateY(10px) scale(0.97);
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
      transform 0.85s cubic-bezier(0.2, 0.7, 0.2, 1),
      opacity 0.45s ease;
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
      transform 1s cubic-bezier(0.45, 0, 0.2, 1),
      opacity 0.3s;
  }
  /* The I-beam's middle sits on the point, as a text cursor's does. */
  .cursor .ibeam {
    margin: -12px 0 0 -6px;
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
    position: relative;
    padding: 0.75rem 0.5rem 0.25rem;
    border: 0;
    background: none;
    text-align: left;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition:
      color 0.2s,
      border-color 0.2s;
  }
  .step.on {
    color: var(--color-text);
  }
  .step-bar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    overflow: hidden;
    border-radius: 1px;
    background: var(--color-border);
  }
  .step-fill {
    display: block;
    height: 100%;
    background: var(--color-primary);
    transform-origin: left;
    transition: transform 100ms linear;
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
    align-content: start;
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
    .shelf-grid {
      grid-template-columns: repeat(auto-fill, minmax(5.25rem, 1fr));
      gap: 1rem 0.6rem;
    }
    .cover {
      padding: 0.6rem 0.5rem;
    }
    .cover-title,
    .cover[data-cover='article'] .cover-title {
      font-size: var(--text-sm);
    }
    .shelf-title {
      font-size: var(--text-sm);
    }
    .cover-excerpt {
      display: none;
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
    /* Five labels share a phone's width; the top rule marks the step. */
    .step-n {
      display: none;
    }
    .step-label {
      font-size: var(--text-sm);
    }
  }
</style>
