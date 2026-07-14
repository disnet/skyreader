<script lang="ts">
  import { goto } from '$app/navigation';
  import { onDestroy, onMount } from 'svelte';
  import type { SavedItem } from '$lib/types';
  import type { MagazineArticleControls } from '$lib/components/feed/DailyMagazineArticle.svelte';
  import DailyMagazineArticle from '$lib/components/feed/DailyMagazineArticle.svelte';
  import ReaderChrome from '$lib/components/feed/ReaderChrome.svelte';
  import PagedView, { type PagedController } from '$lib/components/feed/PagedView.svelte';
  import { mobileStore } from '$lib/stores/mediaQuery.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
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
    buildDailyMagazine,
    formatMagazineDate,
    localDateKey,
    magazineIssueSummary,
    magazineReadingMinutes,
    savedItemDisplayKey,
    savedItemLabelKeys,
    savedItemMagazineKey,
    type DailyMagazineIssue,
  } from '$lib/utils/dailyMagazine';

  interface BodyState {
    status: 'loading' | 'ready' | 'missing';
    html: string;
  }

  let today = $state(new Date());
  let issue = $state<DailyMagazineIssue<SavedItem>>({
    dateKey: '',
    targetMinutes: preferences.dailyMagazineMinutes,
    totalMinutes: 0,
    items: [],
  });
  let issueSignature = $state('');
  let unarchivedSavedCount = $state(0);
  let eligibleCandidateCount = $state(0);
  let bodies = $state<Map<string, BodyState>>(new Map());
  let scrollEl = $state<HTMLElement>();
  let introEl = $state<HTMLElement>();
  let activeKey = $state('');
  let articleControls = $state<Map<string, MagazineArticleControls>>(new Map());
  let articleRoots = $state<Map<string, HTMLElement>>(new Map());
  let controlsVisible = $state(true);
  let scrolled = $state(false);
  let lastScrollY = $state(0);
  let readingProgress = $state(0);
  let progressVisible = $state(false);
  let scrollRaf: number | null = null;
  const openedSnapshot = new Map<string, boolean>();

  // Kindle-style paged reading for the issue. The whole magazine body flows into
  // columns; the active article (which ReaderChrome archives/tags) is derived from
  // the current page rather than scroll position.
  let paged = $derived(preferences.readerViewMode === 'paged');
  let pagedController = $state<PagedController>();

  function handleMagazinePageChange(page: number) {
    if (!paged || !pagedController || issue.items.length === 0) return;
    let nearestKey = savedItemDisplayKey(issue.items[0].item);
    for (const entry of issue.items) {
      const key = savedItemDisplayKey(entry.item);
      const root = articleRoots.get(key);
      if (!root) continue;
      if (pagedController.pageOfElement(root) <= page) nearestKey = key;
    }
    if (nearestKey !== activeKey) activeKey = nearestKey;
  }

  // Contents-list navigation. In scroll mode the native `#article-N` anchor jump
  // works; in paged mode nothing scrolls (overflow:hidden), so turn to the page
  // the article starts on instead.
  function jumpToArticle(e: MouseEvent, entry: (typeof issue.items)[number]) {
    if (!paged || !pagedController) return; // let the anchor scroll natively
    const root = articleRoots.get(savedItemDisplayKey(entry.item));
    if (!root) return;
    e.preventDefault();
    pagedController.goToElement(root);
  }

  let activeEntry = $derived(
    issue.items.find((entry) => savedItemDisplayKey(entry.item) === activeKey) ?? issue.items[0]
  );
  let activeItem = $derived(activeEntry?.item);
  let activeDisplayKey = $derived(activeItem ? savedItemDisplayKey(activeItem) : '');
  let activeTags = $derived(
    activeDisplayKey ? itemLabelsStore.getTagsForItem(activeDisplayKey) : []
  );
  let activeArchived = $derived(
    activeItem
      ? savedItemLabelKeys(activeItem).some((key) => itemLabelsStore.isArchived(key))
      : false
  );

  onMount(() => {
    today = new Date();
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

  $effect(() => {
    if (savesStore.loading || itemLabelsStore.isLoading) return;
    const candidates = [];
    let unarchived = 0;
    let eligible = 0;

    for (const item of savesStore.articles) {
      const labelKeys = savedItemLabelKeys(item);
      if (labelKeys.some((key) => itemLabelsStore.isArchived(key))) continue;
      unarchived += 1;
      const key = savedItemMagazineKey(item);
      if (!openedSnapshot.has(key)) {
        openedSnapshot.set(key, itemLabelsStore.getReadActivity(labelKeys) !== null);
      }
      if (magazineReadingMinutes(item.wordCount) !== null) eligible += 1;
      candidates.push({
        item,
        key,
        wordCount: item.wordCount,
        opened: openedSnapshot.get(key) ?? false,
        sortValue: Date.parse(item.savedAt),
      });
    }

    // Archive/read label changes must not move the mounted issue. The source
    // signature changes only when saves, reading times, the day, or target do.
    const sourceMembership = savesStore.articles
      .map((item) => `${savedItemMagazineKey(item)}:${item.wordCount ?? 'none'}`)
      .sort()
      .join('|');
    const signature = `${localDateKey(today)}|${preferences.dailyMagazineMinutes}|${preferences.dailyMagazineOrder}|${sourceMembership}`;
    if (signature === issueSignature) return;
    unarchivedSavedCount = unarchived;
    eligibleCandidateCount = eligible;
    issueSignature = signature;
    issue = buildDailyMagazine(
      candidates,
      preferences.dailyMagazineMinutes,
      today,
      preferences.dailyMagazineOrder
    );
    activeKey = issue.items[0] ? savedItemDisplayKey(issue.items[0].item) : '';
  });

  $effect(() => {
    const selected = issue.items;
    let cancelled = false;
    bodies = new Map(
      selected.map(({ key }) => [key, { status: 'loading', html: '' } as BodyState])
    );
    for (const { item, key } of selected) {
      savesStore.getContent(item.rkey).then((content) => {
        if (cancelled) return;
        const html = content?.trim() ? sanitizeHtml(content, item.url) : '';
        const next = new Map(bodies);
        next.set(key, html ? { status: 'ready', html } : { status: 'missing', html: '' });
        bodies = next;
      });
    }
    return () => {
      cancelled = true;
    };
  });

  let preparing = $derived(
    savesStore.loading || itemLabelsStore.isLoading || issueSignature.length === 0
  );

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
    if (!scrollEl || issue.items.length === 0) return;
    const line = scrollEl.getBoundingClientRect().top + scrollEl.clientHeight * 0.28;
    let nearest = issue.items[0];
    for (const entry of issue.items) {
      const key = savedItemDisplayKey(entry.item);
      const root = articleRoots.get(key);
      if (!root) continue;
      if (root.getBoundingClientRect().top <= line) nearest = entry;
      else break;
    }
    const nextKey = savedItemDisplayKey(nearest.item);
    if (nextKey !== activeKey) activeKey = nextKey;

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
      scrolled = currentY > 4;
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

  function toggleActiveArchive() {
    if (!activeItem) return;
    const shouldArchive = !activeArchived;
    const aliases = [savedItemDisplayKey(activeItem), ...savedItemLabelKeys(activeItem)].filter(
      (key, index, all) => key.length > 0 && all.indexOf(key) === index
    );
    void (async () => {
      for (const key of aliases) {
        if (shouldArchive) await itemLabelsStore.archiveItem(key, 'saved');
        else await itemLabelsStore.unarchiveItem(key, 'saved');
      }
    })();
  }
</script>

<svelte:head><title>Daily magazine - Skyreader</title></svelte:head>

<div class="daily-reader" class:paged bind:this={scrollEl} onscroll={handleScroll}>
  <ReaderChrome
    itemKey={activeDisplayKey}
    itemType="saved"
    itemTags={activeTags}
    isArchived={activeArchived}
    {controlsVisible}
    {scrolled}
    {readingProgress}
    {progressVisible}
    onClose={closeMagazine}
    onArchive={activeItem ? toggleActiveArchive : undefined}
    onOpenUrl={() => activeItem && window.open(activeItem.url, '_blank', 'noopener')}
    onContents={() =>
      paged
        ? pagedController?.goToPage(0)
        : introEl?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
    onNextParagraph={() => articleControls.get(activeDisplayKey)?.nextParagraph()}
    onPreviousParagraph={() => articleControls.get(activeDisplayKey)?.previousParagraph()}
    onHighlightParagraph={() => articleControls.get(activeDisplayKey)?.highlightParagraph()}
  />

  <main class="reader-container" class:paged>
    {#snippet magazineBody()}
      <section class="issue-intro" bind:this={introEl}>
        <p class="issue-date">{formatMagazineDate(today)}</p>
        <h1>Daily magazine</h1>
        {#if !preparing && issue.items.length}
          <p class="issue-summary">
            {magazineIssueSummary(issue.items.length, issue.totalMinutes)}
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
        </div>
      </section>

      {#if preparing}
        <section class="state" aria-live="polite">
          <h2>Preparing today’s issue</h2>
          <p>Gathering saved articles and reading times.</p>
        </section>
      {:else if savesStore.articles.length === 0}
        <section class="state">
          <h2>Your magazine starts with a save</h2>
          <p>Save an article, then return here for a daily issue.</p>
          <a href="/feeds">Browse your feeds</a>
        </section>
      {:else if unarchivedSavedCount === 0}
        <section class="state">
          <h2>No articles for today’s issue</h2>
          <p>Your saved articles are archived. Restore one to include it here.</p>
          <a href="/saved">View saved articles</a>
        </section>
      {:else if eligibleCandidateCount === 0}
        <section class="state">
          <h2>Reading times aren’t available yet</h2>
          <p>Today’s issue needs saved articles with a known reading time.</p>
          <a href="/saved">View saved articles</a>
        </section>
      {:else if issue.items.length === 0}
        <section class="state">
          <h2>Nothing fits this issue length</h2>
          <p>Choose a longer issue to make room for one of your saved articles.</p>
        </section>
      {:else}
        <nav class="contents" aria-labelledby="contents-title">
          <h2 id="contents-title">Today’s issue</h2>
          <ol>
            {#each issue.items as entry, index (entry.key)}
              <li>
                <a href={`#article-${index + 1}`} onclick={(e) => jumpToArticle(e, entry)}
                  ><span>{decodeEntities(entry.item.title || '') || entry.item.url}</span><span
                    >{entry.minutes} min</span
                  ></a
                >
              </li>
            {/each}
          </ol>
        </nav>

        <div class="reading-surface">
          {#each issue.items as entry, index (entry.key)}
            {@const body = bodies.get(entry.key) ?? { status: 'loading', html: '' }}
            {@const displayKey = savedItemDisplayKey(entry.item)}
            <DailyMagazineArticle
              item={entry.item}
              {index}
              count={issue.items.length}
              minutes={entry.minutes}
              bodyStatus={body.status}
              bodyHtml={body.html}
              active={displayKey === activeDisplayKey}
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
        bottomInset={mobileStore.isMobile ? 64 : 0}
        deps={() => [
          issue.items.length,
          bodies,
          preferences.articleFont,
          preferences.articleFontSize,
        ]}
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
