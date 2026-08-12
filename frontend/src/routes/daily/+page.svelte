<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { onDestroy, onMount } from 'svelte';
  import type { Magazine, MagazineItemSnapshot, SavedItem } from '$lib/types';
  import type { MagazineArticleControls } from '$lib/components/feed/DailyMagazineArticle.svelte';
  import DailyMagazineArticle from '$lib/components/feed/DailyMagazineArticle.svelte';
  import ArchiveMagazineModal from '$lib/components/feed/ArchiveMagazineModal.svelte';
  import ReaderChrome from '$lib/components/feed/ReaderChrome.svelte';
  import { READER_BAR_INSET } from '$lib/components/feed/ReaderBottomBar.svelte';
  import PagedView, { type PagedController } from '$lib/components/feed/PagedView.svelte';
  import { mobileStore } from '$lib/stores/mediaQuery.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { magazineStore } from '$lib/stores/magazine.svelte';
  import {
    DAILY_MAGAZINE_MINUTE_OPTIONS,
    DAILY_MAGAZINE_ORDER_OPTIONS,
    preferences,
    type DailyMagazineMinutes,
    type DailyMagazineOrder,
  } from '$lib/stores/preferences.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { viewTitleStore } from '$lib/stores/viewTitle.svelte';
  import { decodeEntities } from '$lib/utils/entities';
  import { sanitizeHtml } from '$lib/utils/sanitize';
  import {
    formatMagazineDate,
    magazineIssueSummary,
    savedItemDisplayKey,
  } from '$lib/utils/dailyMagazine';

  interface BodyState {
    status: 'loading' | 'ready' | 'missing';
    html: string;
  }

  // A rendered magazine entry: the frozen snapshot plus the live SavedItem it maps
  // to (or a read-only synthesis when the underlying save was later deleted).
  interface Entry {
    snap: MagazineItemSnapshot;
    item: SavedItem;
    displayKey: string;
  }

  // The magazine to read: an explicit `?id` (opening a specific past issue from
  // the Home rail), else the user's current (newest) durable issue. Frozen at
  // generate time, so newly saved articles never change it, and it resumes at the
  // same place on any device.
  let magazine = $derived.by<Magazine | null>(() => {
    const id = $page.url.searchParams.get('id');
    if (id) return magazineStore.getById(id) ?? null;
    return magazineStore.current;
  });

  // Live SavedItem lookup by rkey — frozen snapshots still fetch their body by rkey.
  let savedByRkey = $derived(new Map(savesStore.articles.map((s) => [s.rkey, s])));

  function synthesizeItem(snap: MagazineItemSnapshot): SavedItem {
    // Fallback for a snapshot whose save no longer exists — read-only. `uri` is
    // the frozen displayKey so savedItemDisplayKey() stays stable across the swap.
    return {
      rkey: snap.rkey,
      uri: snap.displayKey,
      url: snap.url,
      title: snap.title,
      author: snap.author,
      description: null,
      content: null,
      contentType: null,
      domain: snap.domain,
      image: snap.image,
      wordCount: snap.wordCount,
      publishedAt: null,
      savedAt: snap.savedAt ?? '',
      source: 'url',
    };
  }

  let entries = $derived.by<Entry[]>(() => {
    const mag = magazine;
    if (!mag) return [];
    return mag.items.map((snap) => {
      const item = savedByRkey.get(snap.rkey) ?? synthesizeItem(snap);
      return { snap, item, displayKey: savedItemDisplayKey(item) };
    });
  });

  let issueDate = $derived(magazine ? new Date(magazine.createdAt * 1000) : new Date());
  let totalMinutes = $derived(magazine?.params.totalMinutes ?? 0);

  // Only show a loading state until there is something to render.
  let preparing = $derived(
    !magazine && (magazineStore.loading || savesStore.loading || itemLabelsStore.isLoading)
  );

  let bodies = $state<Map<string, BodyState>>(new Map());
  let scrollEl = $state<HTMLElement>();
  let introEl = $state<HTMLElement>();
  let activeKey = $state('');
  let articleControls = $state<Map<string, MagazineArticleControls>>(new Map());
  let articleRoots = $state<Map<string, HTMLElement>>(new Map());
  let controlsVisible = $state(true);
  let lastScrollY = $state(0);
  let readingProgress = $state(0);
  let progressVisible = $state(false);
  // The bar names the article you're actually in, once the issue masthead has
  // scrolled away (the masthead already says "Daily magazine" while it's up).
  let barTitleVisible = $state(false);
  let scrollRaf: number | null = null;
  let generateHint = $state('');

  // Kindle-style paged reading for the issue. The whole magazine body flows into
  // columns; the active article (which ReaderChrome archives/tags) is derived from
  // the current page rather than scroll position.
  let paged = $derived(preferences.readerViewMode === 'paged');
  let pagedController = $state<PagedController>();
  let pagedPage = $state(0);
  let pagedTotal = $state(1);

  // One value for the bar's bottom rail: progress through the article you're
  // reading while scrolling, position through the issue while paged.
  let railProgress = $derived(
    paged ? (pagedTotal > 1 ? pagedPage / (pagedTotal - 1) : 0) : readingProgress
  );
  let railVisible = $derived(paged ? pagedTotal > 1 : progressVisible);

  // Paged mode: the masthead owns page one, so the bar takes over from page two.
  // Leaving paged mode resets it so the bar doesn't inherit the page-based answer
  // against a scroll position that still shows the masthead.
  $effect(() => {
    if (paged) barTitleVisible = pagedPage > 0;
    else barTitleVisible = false;
  });

  // Resume: restore to the stored spot once per magazine. Tracked by rkey so a
  // reroll (new magazine) restarts the restore. `resumeKey` is the article the
  // target should restore its paragraph into (scroll mode); captured once so it
  // doesn't chase the position as it's re-saved while reading.
  let resumedFor = $state<string | null>(null);
  let resumeKey = $state<string | null>(null);

  function handleMagazinePageChange(page: number) {
    if (!paged || !pagedController || entries.length === 0) return;
    let nearestKey = entries[0].displayKey;
    for (const entry of entries) {
      const root = articleRoots.get(entry.displayKey);
      if (!root) continue;
      if (pagedController.pageOfElement(root) <= page) nearestKey = entry.displayKey;
    }
    if (nearestKey !== activeKey) {
      activeKey = nearestKey;
      recordPosition(nearestKey);
    }
  }

  // Contents-list navigation. In scroll mode the native `#article-N` anchor jump
  // works; in paged mode nothing scrolls (overflow:hidden), so turn to the page
  // the article starts on instead.
  function jumpToArticle(e: MouseEvent, entry: Entry) {
    if (!paged || !pagedController) return; // let the anchor scroll natively
    const root = articleRoots.get(entry.displayKey);
    if (!root) return;
    e.preventDefault();
    pagedController.goToElement(root);
  }

  let activeEntry = $derived(entries.find((entry) => entry.displayKey === activeKey) ?? entries[0]);
  let activeItem = $derived(activeEntry?.item);
  let activeDisplayKey = $derived(activeEntry?.displayKey ?? '');

  onMount(() => {
    document.body.style.overflow = 'hidden';
    const stopTouch = (event: TouchEvent) => event.stopPropagation();
    scrollEl?.addEventListener('touchstart', stopTouch, { passive: true });
    scrollEl?.addEventListener('touchmove', stopTouch, { passive: true });
    scrollEl?.addEventListener('touchend', stopTouch, { passive: true });
    return () => {
      document.body.style.overflow = '';
      scrollEl?.removeEventListener('touchstart', stopTouch);
      scrollEl?.removeEventListener('touchmove', stopTouch);
      scrollEl?.removeEventListener('touchend', stopTouch);
    };
  });

  onDestroy(() => {
    if (scrollRaf !== null) cancelAnimationFrame(scrollRaf);
  });

  $effect(() => {
    viewTitleStore.set('Daily magazine');
    return () => viewTitleStore.set('');
  });

  // Fetch each entry's body lazily by rkey.
  $effect(() => {
    const selected = entries;
    let cancelled = false;
    bodies = new Map(
      selected.map(({ snap }) => [snap.key, { status: 'loading', html: '' } as BodyState])
    );
    for (const { snap, item } of selected) {
      savesStore.getContent(item.rkey).then((content) => {
        if (cancelled) return;
        const html = content?.trim() ? sanitizeHtml(content, item.url) : '';
        const next = new Map(bodies);
        next.set(snap.key, html ? { status: 'ready', html } : { status: 'missing', html: '' });
        bodies = next;
      });
    }
    return () => {
      cancelled = true;
    };
  });

  // Restore the reading position once per magazine.
  // - Scroll mode: hand the target article a `restore` flag so it scrolls to its
  //   own saved paragraph (via the per-article readProgress).
  // - Paged mode: turn to the page holding the saved paragraph's element (or the
  //   article's start). Driven here because the paginator lives here; waits for the
  //   controller AND the target body so the paragraph element exists and the jump
  //   isn't a no-op. `goToElement` pins the target through later reflows.
  // A fresh issue with no stored position seeds the pointer to the first article so
  // reading it alone still resumes next time.
  $effect(() => {
    const mag = magazine;
    if (!mag || entries.length === 0) return;
    if (resumedFor === mag.rkey) return;
    const stored = mag.position?.itemKey;
    const hasStored = !!stored && entries.some((e) => e.displayKey === stored);
    const key = hasStored ? (stored as string) : entries[0].displayKey;

    if (paged) {
      const targetEntry = entries.find((e) => e.displayKey === key);
      const status = targetEntry ? bodies.get(targetEntry.snap.key)?.status : undefined;
      // 'missing' still settles (no paragraphs → we fall back to the article start).
      const bodySettled = status === 'ready' || status === 'missing';
      if (hasStored) {
        const root = articleRoots.get(key);
        // Wait for the paginator, the article root, and its body — else
        // goToElement is a no-op or can't resolve the paragraph element.
        if (!root || !pagedController || !bodySettled) return;
      }
      resumeKey = null;
      activeKey = key;
      resumedFor = mag.rkey;
      if (hasStored) {
        const root = articleRoots.get(key)!;
        // Defer a frame so the just-rendered body is laid out before we resolve
        // the paragraph element and turn to its page.
        requestAnimationFrame(() => {
          const el = articleControls.get(key)?.restoreTargetElement() ?? root;
          pagedController?.goToElement(el);
        });
      }
    } else {
      resumeKey = hasStored ? key : null;
      activeKey = key;
      resumedFor = mag.rkey;
    }
    // Seed the pointer for a fresh issue so a single-article read still resumes.
    if (!hasStored) recordPosition(key);
  });

  // Persist the magazine-level resume pointer (which article + paragraph). The
  // store debounces, so calling this on every active-article / paragraph change is
  // fine. Guarded until the initial restore for this magazine has run so a startup
  // scroll can't clobber the stored position with the first article at paragraph 0.
  function recordPosition(key: string) {
    const mag = magazine;
    if (!mag || !key || resumedFor !== mag.rkey) return;
    const paragraphIndex = articleControls.get(key)?.currentParagraph() ?? 0;
    magazineStore.setPosition(mag.rkey, { itemKey: key, paragraphIndex, updatedAt: Date.now() });
  }

  function updateTarget(event: Event) {
    const minutes = Number((event.currentTarget as HTMLSelectElement).value);
    if (DAILY_MAGAZINE_MINUTE_OPTIONS.includes(minutes as DailyMagazineMinutes)) {
      preferences.setDailyMagazineMinutes(minutes as DailyMagazineMinutes);
    }
  }

  function updateOrder(event: Event) {
    const order = (event.currentTarget as HTMLSelectElement).value as DailyMagazineOrder;
    preferences.setDailyMagazineOrder(order);
  }

  // Generate / reroll: mint a fresh issue from the current saved pile at the
  // chosen length/order. Reroll replaces the current issue and restarts at the top.
  async function generate() {
    generateHint = '';
    const result = await magazineStore.generate();
    if (!result) {
      generateHint =
        savesStore.articles.length === 0
          ? 'Save an article first, then generate an issue.'
          : 'Nothing fits this issue length. Choose a longer issue and try again.';
      return;
    }
    resumedFor = null;
    // A reroll mints a new current issue; drop any pinned ?id so we show it.
    if ($page.url.searchParams.get('id')) {
      void goto('/daily');
      return;
    }
    if (paged) pagedController?.goToPage(0);
    else if (scrollEl) scrollEl.scrollTop = 0;
  }

  const reroll = generate;

  function registerControls(key: string, controls: MagazineArticleControls | null) {
    const next = new Map(articleControls);
    if (controls) next.set(key, controls);
    else next.delete(key);
    articleControls = next;
  }

  function registerRoot(key: string, root: HTMLElement | null) {
    const next = new Map(articleRoots);
    if (root) next.set(key, root);
    else next.delete(key);
    articleRoots = next;
  }

  function updateActiveArticle() {
    if (!scrollEl || entries.length === 0) return;
    const line = scrollEl.getBoundingClientRect().top + scrollEl.clientHeight * 0.28;
    let nearest = entries[0];
    for (const entry of entries) {
      const root = articleRoots.get(entry.displayKey);
      if (!root) continue;
      if (root.getBoundingClientRect().top <= line) nearest = entry;
      else break;
    }
    const nextKey = nearest.displayKey;
    if (nextKey !== activeKey) {
      activeKey = nextKey;
      recordPosition(nextKey);
    }

    const body = articleControls.get(nextKey)?.body();
    if (!body) {
      progressVisible = false;
      return;
    }
    const rootRect = scrollEl.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    const bodyTop = bodyRect.top - rootRect.top + scrollEl.scrollTop;
    const denominator = Math.max(1, body.offsetHeight - scrollEl.clientHeight * 0.5);
    readingProgress = Math.min(1, Math.max(0, (scrollEl.scrollTop - bodyTop) / denominator));
    progressVisible = body.offsetHeight > scrollEl.clientHeight * 0.6;
  }

  function handleScroll() {
    if (!scrollEl || scrollRaf !== null) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = null;
      const currentY = scrollEl?.scrollTop ?? 0;
      // Hand the title to the bar once the issue masthead has left the top.
      // Measured against the scroller, not the bar, so the handoff point doesn't
      // move as the bar slides in and out.
      if (scrollEl && introEl) {
        barTitleVisible =
          introEl.getBoundingClientRect().bottom < scrollEl.getBoundingClientRect().top + 8;
      }
      const delta = currentY - lastScrollY;
      if (delta > 3 && currentY > 60) controlsVisible = false;
      else if (delta < -10) controlsVisible = true;
      lastScrollY = currentY;
      updateActiveArticle();
    });
  }

  function closeMagazine() {
    if (history.length > 1 && document.referrer.startsWith(location.origin)) history.back();
    else void goto('/home');
  }

  // In the magazine reader the archive action operates on the *issue*, not the
  // article being read: it dismisses this magazine (soft-delete, synced across
  // devices) so it drops off Home. We first prompt about the issue's articles,
  // since dismissing a finished issue usually means you're done with its reads.
  let archivePromptOpen = $state(false);

  function archiveMagazine() {
    if (!magazine) return;
    archivePromptOpen = true;
  }

  // alsoArchiveArticles archives each article in the issue too, clearing them
  // from the saved inbox. Either way the issue is dismissed and the reader closes.
  function confirmArchiveMagazine(alsoArchiveArticles: boolean) {
    const mag = magazine;
    archivePromptOpen = false;
    if (!mag) return;
    if (alsoArchiveArticles) {
      for (const snap of mag.items) void itemLabelsStore.archiveItem(snap.displayKey, 'saved');
    }
    void magazineStore.remove(mag.rkey);
    closeMagazine();
  }

  function nextParagraph() {
    articleControls.get(activeDisplayKey)?.nextParagraph();
    recordPosition(activeDisplayKey);
  }

  function previousParagraph() {
    articleControls.get(activeDisplayKey)?.previousParagraph();
    recordPosition(activeDisplayKey);
  }
</script>

<svelte:head><title>Daily magazine - Skyreader</title></svelte:head>

<ArchiveMagazineModal
  open={archivePromptOpen}
  count={magazine?.items.length ?? 0}
  onclose={() => (archivePromptOpen = false)}
  onArchive={confirmArchiveMagazine}
/>

<div class="daily-reader" class:paged bind:this={scrollEl} onscroll={handleScroll}>
  <ReaderChrome
    itemKey={activeDisplayKey}
    itemType="saved"
    showTag={false}
    isArchived={false}
    {controlsVisible}
    readingProgress={railProgress}
    progressVisible={railVisible}
    barTitle={activeItem?.title ?? ''}
    barSource={activeItem?.domain ?? ''}
    {barTitleVisible}
    onClose={closeMagazine}
    onArchive={magazine ? archiveMagazine : undefined}
    onOpenUrl={() => activeItem && window.open(activeItem.url, '_blank', 'noopener')}
    onContents={() =>
      paged
        ? pagedController?.goToPage(0)
        : introEl?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
    onNextParagraph={nextParagraph}
    onPreviousParagraph={previousParagraph}
    onHighlightParagraph={() => articleControls.get(activeDisplayKey)?.highlightParagraph()}
  />

  <main class="reader-container" class:paged>
    {#snippet magazineBody()}
      <section class="issue-intro" bind:this={introEl}>
        <p class="issue-date">{formatMagazineDate(issueDate)}</p>
        <h1>Daily magazine</h1>
        {#if magazine && entries.length}
          <p class="issue-summary">
            {magazineIssueSummary(entries.length, totalMinutes)}
          </p>
        {/if}
        <div class="issue-controls">
          <label class="length-control">
            <span>Issue length</span>
            <select value={preferences.dailyMagazineMinutes} onchange={updateTarget}>
              {#each DAILY_MAGAZINE_MINUTE_OPTIONS as minutes}
                <option value={minutes}>{minutes} minutes</option>
              {/each}
            </select>
          </label>
          <label class="length-control">
            <span>Articles</span>
            <select value={preferences.dailyMagazineOrder} onchange={updateOrder}>
              {#each DAILY_MAGAZINE_ORDER_OPTIONS as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </label>
          {#if magazine}
            <button class="new-issue" onclick={reroll} disabled={magazineStore.generating}>
              {magazineStore.generating ? 'Generating…' : 'New issue'}
            </button>
          {/if}
        </div>
        {#if generateHint}<p class="issue-hint">{generateHint}</p>{/if}
      </section>

      {#if preparing}
        <section class="state" aria-live="polite">
          <h2>Preparing your issue</h2>
          <p>Gathering saved articles and reading times.</p>
        </section>
      {:else if !magazine}
        {#if savesStore.articles.length === 0}
          <section class="state">
            <h2>Your magazine starts with a save</h2>
            <p>Save an article, then generate an issue to read across devices.</p>
            <a href="/feeds">Browse your feeds</a>
          </section>
        {:else}
          <section class="state">
            <h2>Generate your reading issue</h2>
            <p>
              Build an issue from your saved articles. It stays put — new saves won’t change it —
              and picks up where you left off on any device.
            </p>
            <button class="generate" onclick={generate} disabled={magazineStore.generating}>
              {magazineStore.generating ? 'Generating…' : 'Generate issue'}
            </button>
          </section>
        {/if}
      {:else if entries.length === 0}
        <section class="state">
          <h2>This issue is empty</h2>
          <p>Generate a new one from your saved articles.</p>
          <button class="generate" onclick={reroll} disabled={magazineStore.generating}>
            {magazineStore.generating ? 'Generating…' : 'New issue'}
          </button>
        </section>
      {:else}
        <nav class="contents" aria-labelledby="contents-title">
          <h2 id="contents-title">This issue</h2>
          <ol>
            {#each entries as entry, index (entry.snap.key)}
              <li>
                <a href={`#article-${index + 1}`} onclick={(e) => jumpToArticle(e, entry)}
                  ><span>{decodeEntities(entry.item.title || '') || entry.item.url}</span><span
                    >{entry.snap.minutes} min</span
                  ></a
                >
              </li>
            {/each}
          </ol>
        </nav>

        <div class="reading-surface">
          {#each entries as entry, index (entry.snap.key)}
            {@const body = bodies.get(entry.snap.key) ?? { status: 'loading', html: '' }}
            <DailyMagazineArticle
              item={entry.item}
              {index}
              count={entries.length}
              minutes={entry.snap.minutes}
              bodyStatus={body.status}
              bodyHtml={body.html}
              active={entry.displayKey === activeDisplayKey}
              restore={resumeKey !== null && entry.displayKey === resumeKey}
              {paged}
              {pagedController}
              scrollRoot={scrollEl}
              {registerControls}
              {registerRoot}
            />
          {/each}
        </div>
      {/if}
    {/snippet}

    {#if paged}
      <PagedView
        bottomInset={mobileStore.isMobile ? READER_BAR_INSET : 0}
        deps={() => [entries.length, bodies, preferences.articleFont, preferences.articleFontSize]}
        bind:currentPage={pagedPage}
        bind:totalPages={pagedTotal}
        oncontroller={(c) => (pagedController = c)}
        onpagechange={(page) => handleMagazinePageChange(page)}
      >
        {@render magazineBody()}
      </PagedView>
    {:else}
      {@render magazineBody()}
    {/if}
  </main>
</div>

<style>
  .daily-reader {
    position: fixed;
    inset: 0;
    z-index: 100;
    overflow-y: auto;
    overscroll-behavior: contain;
    background: var(--color-bg);
    color: var(--color-text);
  }
  /* Paged mode: no scroll — the chrome sits on top and the paginator fills the
     rest, dropping the 800px cap so it can use its own wider column band. */
  .daily-reader.paged {
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .reader-container {
    width: 100%;
    max-width: 800px;
    margin: 0 auto;
    padding: 0 1rem 4rem;
  }
  .reader-container.paged {
    flex: 1;
    min-height: 0;
    max-width: none;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .reader-container.paged :global(.paged-root) {
    flex: 1 1 0;
    min-height: 0;
    height: auto;
  }
  .issue-intro {
    display: grid;
    gap: 0.35rem;
    padding: clamp(2rem, 6vw, 3.5rem) 0 1.75rem;
    scroll-margin-top: 4rem;
  }
  .issue-date,
  .issue-summary {
    margin: 0;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }
  .issue-intro h1 {
    margin: 0;
    font-size: 1.25rem;
    line-height: var(--leading-tight);
  }
  .issue-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 1rem;
    margin-top: 0.5rem;
  }
  .length-control {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: fit-content;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }
  select {
    min-height: 2.25rem;
    padding: 0.35rem 1.8rem 0.35rem 0.6rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-text);
    font: inherit;
  }
  .new-issue {
    min-height: 2.25rem;
    padding: 0.35rem 0.9rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-text);
    font: inherit;
    font-weight: var(--weight-medium);
    cursor: pointer;
  }
  .new-issue:hover:not(:disabled) {
    border-color: var(--color-primary);
    color: var(--color-primary);
  }
  .new-issue:disabled,
  .generate:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .issue-hint {
    margin: 0.25rem 0 0;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }
  .state {
    display: grid;
    gap: 0.5rem;
    padding: 1.5rem 0;
    border-block: 1px solid var(--color-border);
  }
  .state h2,
  .contents h2 {
    margin: 0;
    font-size: 1.125rem;
    line-height: var(--leading-tight);
  }
  .state p {
    margin: 0;
    color: var(--color-text-secondary);
  }
  .state a {
    width: fit-content;
    color: var(--color-primary);
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
  }
  .generate {
    width: fit-content;
    margin-top: 0.25rem;
    min-height: 2.5rem;
    padding: 0.45rem 1.1rem;
    border: 0;
    border-radius: 6px;
    background: var(--color-primary);
    color: #fff;
    font: inherit;
    font-weight: var(--weight-semibold);
    cursor: pointer;
  }
  .generate:hover:not(:disabled) {
    filter: brightness(0.95);
  }
  .contents {
    padding: 1.25rem 0 1.5rem;
    border-block: 1px solid var(--color-border);
  }
  .contents ol {
    display: grid;
    gap: 0.75rem;
    margin: 1rem 0 0;
    padding-left: 1.5rem;
  }
  .contents li {
    padding-left: 0.25rem;
  }
  .contents a {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    color: var(--color-text);
    line-height: var(--leading-snug);
    text-decoration: none;
  }
  .contents a span:last-child {
    flex: 0 0 auto;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }
  .contents a:hover span:first-child {
    color: var(--color-primary);
    text-decoration: underline;
  }
  @media (max-width: 1000px) {
    .reader-container {
      padding: 1rem 1rem calc(5rem + env(safe-area-inset-bottom, 0px));
    }
    .issue-intro {
      padding-top: 1rem;
    }
  }
</style>
