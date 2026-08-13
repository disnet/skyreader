<script lang="ts">
  // Harness for the mobile bottom chrome — both bars over a scrolling surface:
  // the reader's (with its progress rail, the detached hairline that stands in
  // while it's away, and the style sheet its last control opens) and the app's
  // (view switcher + actions). No auth, no backend (see ../+layout.ts).
  //
  // Both bars only exist below 1000px (each carries its own breakpoint guard), so
  // view this at a phone width. Above that you get the note and nothing else.
  import ReaderBottomBar from '$lib/components/feed/ReaderBottomBar.svelte';
  import MobileBottomBar from '$lib/components/feed/MobileBottomBar.svelte';
  import ReadingModeToggle from '$lib/components/feed/ReadingModeToggle.svelte';
  import AppearanceToolbar from '$lib/components/feed/AppearanceToolbar.svelte';
  import BottomSheet from '$lib/components/common/BottomSheet.svelte';
  import Icon from '$lib/components/Icon.svelte';

  // Which surface's chrome is under test.
  let surface = $state<'reader' | 'list'>('reader');

  let overlayEl = $state<HTMLElement>();
  let bodyEl = $state<HTMLElement>();
  let controlsVisible = $state(true);
  let progress = $state(0);
  let progressVisible = $state(false);
  let lastScrollY = 0;

  let isSaved = $state(false);
  let isArchived = $state(false);
  let tagMenuOpen = $state(false);
  let sheetOpen = $state(false);
  let tagButtonEl = $state<HTMLButtonElement | null>(null);

  // Mirrors SavedReader: progress measured against the body's end (not the
  // scroll height), controls hidden on a downward scroll past the fold.
  function handleScroll() {
    if (!overlayEl) return;
    const clientHeight = overlayEl.clientHeight;
    const scrollTop = overlayEl.scrollTop;

    // Progress is a reading-surface idea; the list has none (and no body to
    // measure), so only the hide-on-scroll half runs there.
    if (bodyEl) {
      const bodyBottom =
        bodyEl.getBoundingClientRect().bottom - overlayEl.getBoundingClientRect().top + scrollTop;
      const denom = bodyBottom - clientHeight;
      progressVisible = denom > 8;
      progress = progressVisible ? Math.min(1, Math.max(0, scrollTop / denom)) : 0;
    }

    const delta = scrollTop - lastScrollY;
    if (Math.abs(delta) < 3) return;
    if (delta > 0 && scrollTop > 60) controlsVisible = false;
    else if (delta < -10) controlsVisible = true;
    lastScrollY = scrollTop;
  }

  const paragraphs = [
    'A reading app earns its chrome the way a room earns its furniture: by what it lets you forget. The bar along the bottom edge is the whole of it — five controls, one rail, and the good sense to leave when you start reading.',
    'The rail is the bar’s top edge. Not a second line hovering somewhere above the text, not a stripe pinned under the notch, but the boundary between the chrome and the words, doing double duty as the measure of how far you have come.',
    'Scroll down and the bar slides off the bottom of the screen. The rail stays, a two-pixel hairline just above the home indicator, so the one thing worth keeping survives the disappearance of everything else.',
    'Scroll back up, even a little, and the whole bar returns beneath it. Nothing was lost; nothing had to be hunted for. The controls sit where a thumb already rests, which is the only argument for the bottom of the screen that has ever mattered.',
    'Five controls is a decision, not an accident. Back, archive, save, tag, and everything else behind one door. The reading-mode switch went through that door because switching between scroll and pages is something you do once a session, not once a paragraph.',
    'What remains is a surface you can read on a train with one hand, in a dark room at night, or on a cracked phone in bright sun. The text is the product. The bar is what it rests on.',
    'Long-form reading rewards patience from the interface. Every element that pulses, floats, or casts a shadow is asking for a share of attention that belongs to the sentence you are in the middle of.',
    'So the bar is flat and opaque. It does not blur what is behind it, because nothing needs to be behind it. It does not float, because it is not hovering over the page — it is where the page ends.',
  ];
</script>

<div class="reader-mock" bind:this={overlayEl} onscroll={handleScroll}>
  <div class="escape">
    <div class="surface-switch" role="group" aria-label="Surface">
      <button class:on={surface === 'reader'} onclick={() => (surface = 'reader')}>Reader</button>
      <button class:on={surface === 'list'} onclick={() => (surface = 'list')}>List</button>
    </div>
    <a href="/dev">← Harnesses</a>
  </div>

  <div
    class="reading-progress"
    class:visible={progressVisible}
    class:bar-hidden={!controlsVisible}
    role="progressbar"
    aria-label="Reading progress"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={Math.round(progress * 100)}
  >
    <div class="reading-progress-fill" style:transform={`scaleX(${progress})`}></div>
  </div>

  {#if surface === 'list'}
    <div class="mock-container mock-list">
      {#each paragraphs as paragraph, i}
        <article class="mock-row">
          <h2>{paragraph.split(' ').slice(0, 6).join(' ')}</h2>
          <p>{paragraph.slice(0, 120)}…</p>
          <span class="mock-row-meta">Feed {i + 1} · 3h</span>
        </article>
      {/each}
    </div>
  {:else}
    <article class="mock-container">
      <header class="mock-header">
        <h1>The bar at the bottom</h1>
        <div class="mock-meta">
          <span>Harness</span>
          <span>Aug 12</span>
          <span class="mock-time"><Icon name="clock" size={12} /> 4 min read</span>
        </div>
      </header>
      <div class="mock-body" bind:this={bodyEl}>
        {#each paragraphs as paragraph, i}
          <p>{paragraph}</p>
          <!-- Worst case for the translucent bar: a full-width dark figure drifting
               under it. Scroll one of these behind the controls to check they hold. -->
          {#if i === 1 || i === 6}
            <div class="mock-figure dark">dark figure</div>
          {:else if i === 4}
            <div class="mock-figure light">light figure</div>
          {/if}
        {/each}
      </div>
    </article>
  {/if}

  <p class="desktop-note">
    The reader bottom bar is mobile-only — narrow this window below 1000px to see it.
  </p>

  {#if surface === 'list'}
    <MobileBottomBar
      {controlsVisible}
      currentTitle="Everything"
      onScrollToTop={() => overlayEl?.scrollTo({ top: 0, behavior: 'smooth' })}
      onOpenFeedSwitcher={() => {}}
      onOpenFilterSheet={() => {}}
      onOpenNotifications={() => {}}
      hasActiveFilters={true}
    />
  {:else}
    <ReaderBottomBar
      {progress}
      visible={controlsVisible}
      onBack={() => history.back()}
      onArchive={() => (isArchived = !isArchived)}
      {isArchived}
      onToggleSave={() => (isSaved = !isSaved)}
      {isSaved}
      onTag={() => (tagMenuOpen = !tagMenuOpen)}
      tagCount={2}
      tagActive={tagMenuOpen}
      bind:tagButtonEl
      onMore={() => (sheetOpen = true)}
      moreActive={sheetOpen}
    />
  {/if}
</div>

<BottomSheet open={sheetOpen} onclose={() => (sheetOpen = false)} title="Style & Actions">
  <div class="sheet-content">
    <div class="sheet-section">
      <div class="sheet-label">Appearance</div>
      <div class="toolbar-wrapper"><AppearanceToolbar /></div>
      <ReadingModeToggle />
    </div>
    <div class="sheet-section">
      <div class="sheet-label">Actions</div>
      <div class="sheet-actions">
        <button class="sheet-action-btn"><Icon name="bookmark" size={18} /><span>Save</span></button
        >
        <button class="sheet-action-btn"
          ><Icon name="external-link" size={18} /><span>Open in browser</span></button
        >
        <button class="sheet-action-btn danger"
          ><Icon name="trash" size={18} /><span>Delete</span></button
        >
      </div>
    </div>
  </div>
</BottomSheet>

<style>
  .reader-mock {
    position: fixed;
    inset: 0;
    z-index: 100;
    overflow-y: auto;
    overscroll-behavior: contain;
    background: var(--color-bg);
    color: var(--color-text);
  }

  .escape {
    position: absolute;
    top: 0.75rem;
    right: 1rem;
    left: 1rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }

  .escape a {
    color: inherit;
  }

  .surface-switch {
    display: flex;
    overflow: hidden;
    border: 1px solid var(--color-border);
    border-radius: 8px;
  }

  .surface-switch button {
    padding: 0.25rem 0.625rem;
    border: 0;
    background: none;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }

  .surface-switch button + button {
    border-left: 1px solid var(--color-border);
  }

  .surface-switch button.on {
    background: var(--color-sidebar-active);
    color: var(--color-primary);
  }

  /* Stand-ins for a photo or a code block: the darkest and lightest things that
     can scroll behind the bar. One of each, since which one is the hard case
     flips with the theme — scroll either under the chrome to check it holds. */
  .mock-figure {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 220px;
    margin: 0 0 1.25em;
    border-radius: 8px;
    font-family: var(--font-sans-serif);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
  }

  .mock-figure.dark {
    background: #14213d;
    color: rgba(255, 255, 255, 0.5);
  }

  .mock-figure.light {
    background: #f1ece1;
    color: rgba(0, 0, 0, 0.45);
  }

  .mock-list {
    display: flex;
    flex-direction: column;
  }

  .mock-row {
    padding: 1rem 0;
    border-bottom: 1px solid var(--color-border);
  }

  .mock-row h2 {
    margin: 0 0 0.25rem;
    font-size: var(--text-base);
    font-weight: var(--weight-semibold);
  }

  .mock-row p {
    margin: 0 0 0.375rem;
    color: var(--color-text-secondary);
    font-size: var(--text-md);
  }

  .mock-row-meta {
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }

  .reading-progress {
    position: fixed;
    top: env(safe-area-inset-top, 0px);
    left: 0;
    right: 0;
    z-index: 200;
    height: 2px;
    overflow: hidden;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.25s ease;
  }

  .reading-progress-fill {
    height: 100%;
    background: var(--color-primary);
    transform-origin: left;
  }

  @media (max-width: 1000px) {
    .reading-progress {
      top: auto;
      bottom: env(safe-area-inset-bottom, 0px);
    }

    .reading-progress.visible.bar-hidden {
      opacity: 1;
    }

    .desktop-note {
      display: none;
    }
  }

  .mock-container {
    max-width: 800px;
    margin: 0 auto;
    padding: 3rem 1rem calc(5rem + env(safe-area-inset-bottom, 0px));
  }

  .mock-header {
    margin-bottom: 2rem;
  }

  .mock-header h1 {
    margin: 0 0 0.75rem;
    font-size: var(--text-4xl);
    font-weight: var(--weight-bold);
    line-height: var(--leading-tight);
  }

  .mock-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    color: var(--color-text-secondary);
    font-size: var(--text-md);
  }

  .mock-time {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }

  .mock-body {
    font-family: var(--article-font);
    font-size: var(--article-font-size);
    line-height: var(--leading-relaxed);
  }

  .mock-body p {
    margin: 0 0 1.25em;
  }

  .desktop-note {
    max-width: 800px;
    margin: 0 auto;
    padding: 0 1rem 3rem;
    color: var(--color-text-secondary);
    font-size: var(--text-md);
  }

  .sheet-content {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    padding: 0.5rem 1.25rem 1.5rem;
  }

  .sheet-section {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  .sheet-label {
    color: var(--color-text-secondary);
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
  }

  .toolbar-wrapper :global(.appearance-toolbar) {
    padding: 0;
    border-radius: 0;
    background: none;
    box-shadow: none;
    backdrop-filter: none;
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  .sheet-actions {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--color-border);
    border-radius: 10px;
  }

  .sheet-action-btn {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.75rem 1rem;
    border: 0;
    border-bottom: 1px solid var(--color-border);
    background: none;
    color: var(--color-text);
    font-size: var(--text-lg);
    text-align: left;
  }

  .sheet-action-btn:last-child {
    border-bottom: 0;
  }

  .sheet-action-btn.danger {
    color: var(--color-error);
  }
</style>
