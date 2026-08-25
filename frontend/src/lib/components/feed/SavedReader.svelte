<script lang="ts">
  import type { FeedDisplayItem } from '$lib/stores/feedView.svelte';
  import {
    normalizeDisplayItem,
    getAuthorLabel,
    getDisplayContent,
    extractSembleMetadata,
    extractMarginMetadata,
  } from '$lib/utils/displayItem';
  import { getExternalArticleLink } from '$lib/utils/linkPost';
  import { linkPostContentStore } from '$lib/stores/linkPostContent.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { integrationSaveStore } from '$lib/stores/integrationSave.svelte';
  import { socialStore } from '$lib/stores/social.svelte';
  import { db } from '$lib/services/db';
  import { saveCollectionPiece, isCollectionPieceSaved } from '$lib/utils/collectionPiece';
  import { sanitizeHtml } from '$lib/utils/sanitize';
  import { formatRelativeDate } from '$lib/utils/date';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { profileService } from '$lib/services/profiles';
  import { bskyEmbed } from '$lib/actions/bsky-embed';
  import Icon from '$lib/components/Icon.svelte';
  import PopoverMenu from '$lib/components/PopoverMenu.svelte';
  import TagMenu from '$lib/components/feed/TagMenu.svelte';
  import LinkContextMenu from '$lib/components/feed/LinkContextMenu.svelte';
  import BottomSheet from '$lib/components/common/BottomSheet.svelte';
  import AppearanceToolbar from '$lib/components/feed/AppearanceToolbar.svelte';
  import ReaderBottomBar, { READER_BAR_INSET } from '$lib/components/feed/ReaderBottomBar.svelte';
  import ReadingModeToggle from '$lib/components/feed/ReadingModeToggle.svelte';
  import ReaderDiscussion from '$lib/components/feed/ReaderDiscussion.svelte';
  import { useParagraphTracking } from '$lib/hooks/useParagraphTracking.svelte';
  import { useLinkInterception } from '$lib/hooks/useLinkInterception.svelte';
  import { useHighlights } from '$lib/hooks/useHighlights.svelte';
  import { useCommunityHighlights } from '$lib/hooks/useCommunityHighlights.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { linkblogStore } from '$lib/stores/linkblog.svelte';
  import { shareComposerStore } from '$lib/stores/shareComposer.svelte';
  import { shareDraftsStore } from '$lib/stores/shareDrafts.svelte';
  import { shareTargetForDisplayItem } from '$lib/utils/shareTarget';
  import HighlightPopover from '$lib/components/feed/HighlightPopover.svelte';
  import CommunityHighlightPopover from '$lib/components/feed/CommunityHighlightPopover.svelte';
  import NotePeek from '$lib/components/feed/NotePeek.svelte';
  import CollectionMagazine from '$lib/components/feed/CollectionMagazine.svelte';
  import PagedView, { type PagedController } from '$lib/components/feed/PagedView.svelte';
  import { magazineThemeVars } from '$lib/utils/magazineTheme';
  import { preferences } from '$lib/stores/preferences.svelte';
  import { mobileStore } from '$lib/stores/mediaQuery.svelte';
  import { tick, onMount, onDestroy, untrack } from 'svelte';

  let {
    readerItem,
    onClose,
    onArchive,
    onRemove,
    onToggleSave,
  }: {
    readerItem: FeedDisplayItem;
    onClose: () => void;
    onArchive?: () => void;
    onRemove?: () => void;
    onToggleSave?: () => void;
  } = $props();

  // Saving out to Semble / Margin. The picker is global (mounted in AppShell),
  // so the reader offers these wherever it is hosted rather than only on the
  // pages that used to own the picker's state.
  let canSaveToIntegration = $derived(Boolean(auth.user));

  function saveToSemble() {
    integrationSaveStore.openPicker('semble', extractSembleMetadata(readerItem));
  }

  function saveToMargin() {
    integrationSaveStore.openPicker('margin', extractMarginMetadata(readerItem));
  }

  let styleMenuOpen = $state(false);
  let styleSheetOpen = $state(false);
  let tagMenuOpen = $state(false);
  let overflowMenuOpen = $state(false);
  let overflowRef = $state<HTMLDivElement | null>(null);
  // The mobile Tag popover normally anchors to its bottom-bar button. Saved
  // articles use that slot for Community instead, so Tag (reached from the
  // actions sheet) anchors to that stable slot after the sheet closes.
  let tagBtnRef = $state<HTMLButtonElement | null>(null);
  let mobileTagBtnRef = $state<HTMLButtonElement | null>(null);
  let mobileCommunityBtnRef = $state<HTMLButtonElement | null>(null);
  let mobileTagAnchorRef = $derived(
    readerItem.type === 'saved' ? mobileCommunityBtnRef : mobileTagBtnRef
  );
  let controlsVisible = $state(true);
  // Desktop header hides on scroll-down, but stays put while a header-anchored
  // menu (Style/Tag/overflow ⋯) is open so its popover doesn't slide off-screen.
  let headerHidden = $derived(
    !controlsVisible && !styleMenuOpen && !tagMenuOpen && !overflowMenuOpen
  );
  let lastScrollY = $state(0);
  let suppressScrollHide = $state(false);
  let overlayEl: HTMLElement | undefined = $state();
  let readerBodyEl: HTMLElement | undefined = $state();
  let headerRef = $state<HTMLElement | undefined>(undefined);

  // Reading-progress indicator: fills left-to-right as the reader scrolls through
  // the article body. Scroll-driven (not paragraph-driven) for smooth
  // frame-by-frame motion; measured against the body's end rather than raw
  // scrollHeight so it hits ~100% at the end of the text, not the bottom of the
  // discussion section below it. It is drawn twice: as the bar's own bottom rail,
  // and as a bare hairline that takes over once the bar slides away.
  let readingProgress = $state(0); // 0–1
  let progressVisible = $state(false);
  let progressRaf: number | null = null;

  // The bar's title slot stays empty while the article's own H1 is on screen and
  // fades in once it scrolls away, so the full-bleed bar always says what you're
  // in without duplicating the headline right beneath it.
  let articleHeaderEl: HTMLElement | undefined = $state();
  let titleVisible = $state(false);

  // Paged mode has nothing to scroll, so the rail tracks page position instead.
  let pagedPage = $state(0);
  let pagedTotal = $state(1);

  let itemKey = $derived(readerItem.key);
  let itemTags = $derived(itemLabelsStore.getTagsForItem(itemKey));

  let labelItemType = $derived.by((): 'article' | 'document' | 'saved' => readerItem.type);

  // Compute reading progress as scrollTop / (article-body-end − clientHeight),
  // clamped to 0–1. The overlay scrolls past the body into the discussion +
  // bottom padding, so measuring against the body's bottom edge makes the bar
  // reach ~100% at the end of the text. If the article fits on screen (or isn't
  // meaningfully scrollable), hide the bar rather than pinning it at 100%.
  function updateReadingProgress() {
    if (!overlayEl || !readerBodyEl) return;
    const clientHeight = overlayEl.clientHeight;
    const scrollTop = overlayEl.scrollTop;
    // Body bottom in the overlay's scroll coordinate space.
    const bodyBottom =
      readerBodyEl.getBoundingClientRect().bottom -
      overlayEl.getBoundingClientRect().top +
      scrollTop;
    const denom = bodyBottom - clientHeight;
    if (denom <= 8) {
      progressVisible = false;
      readingProgress = 0;
      return;
    }
    progressVisible = true;
    readingProgress = Math.min(1, Math.max(0, scrollTop / denom));
  }

  // Hand the title to the bar once the article's own header has left the top of
  // the overlay. Measured against the overlay (not the bar) so the handoff point
  // doesn't move when the bar itself slides in and out.
  function updateTitleVisibility() {
    if (paged) return; // page position drives it there
    if (!overlayEl || !articleHeaderEl) return;
    const overlayTop = overlayEl.getBoundingClientRect().top;
    titleVisible = articleHeaderEl.getBoundingClientRect().bottom < overlayTop + 8;
  }

  function scheduleProgressUpdate() {
    if (progressRaf != null) return;
    progressRaf = requestAnimationFrame(() => {
      progressRaf = null;
      updateReadingProgress();
      updateTitleVisibility();
    });
  }

  function handleScroll() {
    if (!overlayEl) return;
    scheduleProgressUpdate();

    if (suppressScrollHide) return;
    const currentY = overlayEl.scrollTop;
    const delta = currentY - lastScrollY;
    // Ignore tiny fluctuations (momentum settling on mobile)
    if (Math.abs(delta) < 3) return;
    if (delta > 0 && currentY > 60) {
      controlsVisible = false;
    } else if (delta < -10) {
      // Require meaningful upward scroll to show controls
      controlsVisible = true;
    }
    lastScrollY = currentY;
  }

  // Feed info (articles only)
  let sub = $derived(
    readerItem.type === 'article'
      ? subscriptionsStore.subscriptions.find((s) => s.id === readerItem.item.subscriptionId)
      : undefined
  );
  let feedTitle = $derived(sub?.customTitle || sub?.title || '');

  // Normalize data from different item types using shared utility
  let normalized = $derived(normalizeDisplayItem(readerItem, sub));
  let title = $derived(normalized.title);
  let itemUrl = $derived(normalized.url);
  let publishedAt = $derived(normalized.publishedAt);
  let faviconUrl = $derived(normalized.faviconUrl);

  // Link post: the external article URL, if this reader item is one. Opening the
  // reader fetches the full article in-app (the leaflet note + card is the
  // fallback shown until it arrives).
  let linkPostUrl = $derived(
    readerItem.type === 'document' ? getExternalArticleLink(readerItem.item) : undefined
  );

  // A curated Collection (Standard Reader "edition"): render the structured
  // editorial → pieces → colophon layout in place of the document body.
  let collection = $derived(
    readerItem.type === 'document' ? readerItem.item.readerCollection : undefined
  );
  // The edition title for the magazine masthead (the document's own title).
  let collectionTitle = $derived(
    readerItem.type === 'document' ? readerItem.item.title : undefined
  );
  // An edition always renders as the themed magazine; its publication palette +
  // fonts paint the whole reader surface (not just the content column).
  let magazineVars = $derived(collection ? magazineThemeVars(collection) : '');

  $effect(() => {
    if (linkPostUrl) linkPostContentStore.fetch(linkPostUrl);
  });

  // The fetched external article for a link post (carries the real author).
  let linkPostArticle = $derived(
    linkPostUrl && readerItem.type === 'document'
      ? linkPostContentStore.get(linkPostUrl)
      : undefined
  );

  // Saved items keep only metadata in memory (the body was stripped to keep the
  // saved store small); pull the full text back from IndexedDB by rkey when the
  // reader opens. Resets and refetches whenever the reader item changes.
  let lazySavedContent = $state<string | null>(null);
  $effect(() => {
    lazySavedContent = null;
    if (readerItem.type !== 'saved' || !readerItem.item.rkey) return;
    const rkey = readerItem.item.rkey;
    let cancelled = false;
    savesStore.getContent(rkey).then((c) => {
      if (!cancelled) lazySavedContent = c;
    });
    return () => {
      cancelled = true;
    };
  });

  // An article's full body, lazy-loaded for saved feed articles shown via the
  // 'article' path (a save whose source article is still in the feed renders as
  // type 'article', not 'saved'). Prefer the saved copy's stored body — that's
  // the full extracted text captured at save time, whereas the feed's own RSS
  // body is often just an excerpt. Fall back to the feed body in IndexedDB (the
  // in-memory article is "light", its content stripped — see toLightArticle).
  let lazyArticleContent = $state<string | null>(null);
  // Whether that body is the user's own saved snapshot rather than the feed's —
  // the display ladder below treats the two differently.
  let lazyArticleIsSavedCopy = $state(false);
  $effect(() => {
    lazyArticleContent = null;
    lazyArticleIsSavedCopy = false;
    if (readerItem.type !== 'article') return;
    const {
      id,
      guid,
      subscriptionId,
      content: inMemoryContent,
      contentTruncated,
      url,
    } = readerItem.item;
    let cancelled = false;
    (async () => {
      try {
        const saved = savesStore.getByGuid(guid);
        if (saved?.rkey) {
          const savedBody = await savesStore.getContent(saved.rkey);
          if (savedBody) {
            if (!cancelled) {
              lazyArticleContent = savedBody;
              lazyArticleIsSavedCopy = true;
            }
            return;
          }
        }
        // Not saved (or no stored body): use the in-memory body if present, else
        // read the feed body back from IndexedDB by id, or by guid for rows
        // merged this session that don't have an id yet.
        if (inMemoryContent) return;
        let row = id != null ? await db.articles.get(id) : undefined;
        if (!row && guid) {
          row = await db.articles
            .where('guid')
            .equals(guid)
            .filter((a) => a.subscriptionId === subscriptionId)
            .first();
        }
        const cachedContent = row?.content ?? '';
        if (!cancelled) lazyArticleContent = cachedContent;
        if (!cancelled && !cachedContent && contentTruncated && url) {
          // Keep the store's reactive entry map out of this effect's dependency
          // graph. Failed extracts delete their entry so a later open can retry;
          // tracking that deletion here would create an immediate retry loop.
          untrack(() => linkPostContentStore.fetch(url));
        }
      } catch {
        if (!cancelled) lazyArticleContent = '';
        if (!cancelled && contentTruncated && url) {
          untrack(() => linkPostContentStore.fetch(url));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  // A document's flat text, lazy-loaded for stripped social-feed docs whose body
  // isn't recognized structured content (rare). Resets per reader item.
  let lazyDocText = $state<string | null>(null);
  $effect(() => {
    lazyDocText = null;
    if (readerItem.type !== 'document' || readerItem.item.textContent) return;
    const recordUri = readerItem.item.recordUri;
    let cancelled = false;
    socialStore.getTextContent(recordUri).then((t) => {
      if (!cancelled) lazyDocText = t;
    });
    return () => {
      cancelled = true;
    };
  });

  let displayContent = $derived.by(() => {
    // In the reader we show the external article itself — not the sharer's note.
    if (linkPostArticle?.content) return linkPostArticle.content;
    // Prefer the lazily-loaded body for saved items; normalized.displayContent
    // falls back to the description until it arrives.
    if (readerItem.type === 'saved' && lazySavedContent) return lazySavedContent;
    // A save's own snapshot still outranks everything — it's the body the user
    // kept (and what their highlights are anchored in).
    if (readerItem.type === 'article' && lazyArticleIsSavedCopy && lazyArticleContent)
      return lazyArticleContent;
    // Otherwise an extract of the original wins over the feed's body, matching
    // ArticleCard: the entry only exists because something asked for it (Shift+F,
    // the ⋯ menu, the truncated-article nudge), and an RSS body is often just an
    // excerpt. It's also how an oversized body — dropped at ingest — gets here.
    const extractedArticle =
      readerItem.type === 'article' ? linkPostContentStore.get(readerItem.item.url) : undefined;
    if (extractedArticle?.content) return extractedArticle.content;
    // Else the feed body for an article rendered via the 'article' path — it was
    // stripped from memory and is read back from IndexedDB above.
    if (readerItem.type === 'article' && lazyArticleContent) return lazyArticleContent;
    // For a stripped document, re-render with the lazily-loaded textContent fed
    // back in — structured `content` still wins inside getDisplayContent, so this
    // only changes the unrecognized-format fallback (description → full text).
    if (readerItem.type === 'document' && lazyDocText && !readerItem.item.textContent) {
      return getDisplayContent({
        type: 'document',
        item: { ...readerItem.item, textContent: lazyDocText },
        key: readerItem.key,
      });
    }
    return normalized.displayContent;
  });

  // Author info (documents)
  let authorProfile = $state<{ handle?: string } | null>(null);
  $effect(() => {
    const did = normalized.authorDid;
    if (did) {
      profileService.getProfile(did).then((p) => {
        authorProfile = p;
      });
    } else {
      authorProfile = null;
    }
  });
  // For a link post the reader shows the external article, so attribute its
  // real author (from the extract) rather than the person who shared it.
  let authorLabel = $derived.by(() => {
    if (linkPostUrl && readerItem.type === 'document') {
      return linkPostArticle?.author ? `by ${linkPostArticle.author}` : '';
    }
    return getAuthorLabel(readerItem, authorProfile);
  });

  // The bar's subtitle: the most specific source we know — the feed, then the
  // author, then the bare domain.
  let sourceLabel = $derived.by(() => {
    if (feedTitle) return feedTitle;
    if (authorLabel) return authorLabel.replace(/^by\s+/i, '');
    if (!itemUrl) return '';
    try {
      return new URL(itemUrl).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  });

  let isArchived = $derived(itemLabelsStore.isArchived(itemKey));
  let isSaved = $derived(itemLabelsStore.isSaved(itemKey));

  // ── Share from the reader chrome ────────────────────────────────────────────
  // A share control lives in the bar (desktop and mobile) so sharing is in
  // reach at any scroll position — and on any page in paged mode — instead of
  // only at the end of the article. It opens the same composer drawer the
  // Discussion rail uses; drafting docks under the article.
  let canShareLinkblog = $derived(
    Boolean(auth.user) && !preferences.linkblogDisabled && Boolean(itemUrl)
  );
  let sharedNow = $derived(itemUrl ? linkblogStore.isShared(itemUrl) : false);
  let hasShareDraft = $derived(itemUrl ? shareDraftsStore.hasDraft(itemUrl) : false);

  function openShareComposer() {
    const target = shareTargetForDisplayItem(
      readerItem,
      { url: itemUrl, title, publishedAt },
      linkPostArticle?.author ?? undefined
    );
    if (!target) return;
    if (sharedNow) {
      shareComposerStore.open({
        article: target.article,
        itemKey: readerItem.key,
        mode: 'edit',
        initialNote: linkblogStore.getNote(itemUrl) ?? '',
      });
    } else {
      shareComposerStore.open({
        article: target.article,
        repostUri: target.repostUri,
        itemKey: readerItem.key,
        mode: 'create',
      });
    }
  }

  // While the composer drawer is open for this article, the highlight popover
  // offers "quote in your share draft".
  let composerOpenHere = $derived(itemUrl ? shareComposerStore.isOpenFor(itemUrl) : false);

  function quoteSelectionToShare() {
    const state = highlightsHook.popoverState;
    if (!state) return;
    const text =
      state.pendingSelector?.exact ??
      (state.highlightId
        ? itemLabelsStore.getHighlights(itemKey).find((h) => h.id === state.highlightId)?.selector
            .exact
        : undefined);
    if (text) shareComposerStore.appendQuote(text);
  }

  let sanitizedContent = $derived(sanitizeHtml(displayContent, itemUrl));

  // Kindle-style paged reading. When on, the article flows into columns turned a
  // page at a time instead of scrolling; the scroll-driven paragraph highlight and
  // progress bar are disabled (see the `enabled`/`!paged` guards below) and the
  // Discussion section is dropped for a focused read.
  let paged = $derived(preferences.readerViewMode === 'paged');
  let pagedController = $state<PagedController>();
  let pagedRestoredForKey: string | null = null;
  let pagedSaveTimer: ReturnType<typeof setTimeout> | undefined;

  // One value feeds both drawings of the rail: scroll fraction while scrolling,
  // page position while paged. The bar's bottom edge means the same thing either
  // way, which is what makes it readable as a single edge.
  let railProgress = $derived(
    paged ? (pagedTotal > 1 ? pagedPage / (pagedTotal - 1) : 0) : readingProgress
  );
  let railVisible = $derived(paged ? pagedTotal > 1 : progressVisible);

  // Paged mode: the H1 lives on page one, so the bar takes the title from page two.
  $effect(() => {
    if (paged) {
      titleVisible = pagedPage > 0;
      return;
    }
    // Leaving paged mode: re-measure against the restored scroll position rather
    // than inheriting the page-based answer until the reader happens to scroll.
    void tick().then(updateTitleVisibility);
  });

  const PARA_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, blockquote, pre, figure, li';
  function detectReaderParagraphs(): HTMLElement[] {
    if (!readerBodyEl) return [];
    return (Array.from(readerBodyEl.querySelectorAll(PARA_SELECTOR)) as HTMLElement[]).filter(
      (el) => (el.textContent?.trim().length ?? 0) >= 20
    );
  }

  // Save the furthest paragraph that has been paged past, reusing the same
  // read-progress store the scroll reader writes — so position is stable across
  // reflows (font size / width changes repaginate but the paragraph is unchanged).
  function handlePagedPageChange(page: number) {
    if (!paged || !pagedController) return;
    const paras = detectReaderParagraphs();
    if (!paras.length) return;
    let furthest = 0;
    for (let i = 0; i < paras.length; i++) {
      if (pagedController.pageOfElement(paras[i]) <= page) furthest = i;
    }
    if (pagedSaveTimer) clearTimeout(pagedSaveTimer);
    pagedSaveTimer = setTimeout(() => {
      itemLabelsStore.setReadProgress(itemKey, labelItemType, furthest, paras.length);
    }, 500);
  }

  // Restore the saved page once the paginator has measured. Retries on content
  // settle (lazy bodies) until the paragraphs exist, mirroring the scroll reader's
  // 'partial' handling.
  $effect(() => {
    void sanitizedContent;
    if (!paged || !pagedController || !readerBodyEl) return;
    const key = itemKey;
    if (pagedRestoredForKey === key) return;
    const saved = itemLabelsStore.getReadProgress(key);
    if (!saved || saved.paragraphIndex <= 0) {
      pagedRestoredForKey = key;
      return;
    }
    const timer = setTimeout(() => {
      const paras = detectReaderParagraphs();
      if (!paras.length) return; // body not loaded yet — retry on next settle
      const idx = Math.min(saved.paragraphIndex, paras.length - 1);
      pagedController?.goToElement(paras[idx]);
      pagedRestoredForKey = key;
    }, 300);
    return () => clearTimeout(timer);
  });

  onDestroy(() => {
    if (pagedSaveTimer) clearTimeout(pagedSaveTimer);
  });

  let readTimeMinutes = $derived.by(() => {
    const text = displayContent.replace(/<[^>]*>/g, '');
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(wordCount / 200));
  });

  let overflowItems = $derived.by(() => {
    const items: {
      label: string;
      icon?: string;
      variant?: 'default' | 'danger';
      active?: boolean;
      keepOpen?: boolean;
      onclick: () => void;
    }[] = [];

    items.push({
      label: `Tag${itemTags.length > 0 ? ` (${itemTags.length})` : ''}`,
      icon: 'tag',
      onclick: () => {
        tagMenuOpen = true;
      },
    });

    if (onToggleSave) {
      items.push({
        label: isSaved ? 'Unsave' : 'Save',
        icon: 'bookmark',
        onclick: () => onToggleSave!(),
      });
    }

    if (canSaveToIntegration) {
      items.push({
        label: 'Save to Semble',
        icon: 'semble',
        onclick: saveToSemble,
      });
      items.push({
        label: 'Save to Margin',
        icon: 'margin',
        onclick: saveToMargin,
      });
    }

    if (onRemove) {
      items.push({
        label: deleteConfirming ? 'Confirm delete?' : 'Delete',
        icon: 'trash',
        variant: deleteConfirming ? 'danger' : 'default',
        keepOpen: !deleteConfirming,
        onclick: handleDeleteClick,
      });
    }

    items.push({
      label: 'Open in browser',
      icon: 'external-link',
      onclick: handleOpenUrl,
    });

    return items;
  });

  function handleKeydown(e: KeyboardEvent) {
    // This runs in the capture phase (so it beats the feed's own shortcuts), which
    // means a textarea's bubble-phase stopPropagation can't shield it — guard here
    // instead. Ignore keystrokes coming from an editable element (e.g. the share
    // note box) so letters like t/e/s type normally rather than firing shortcuts.
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.isContentEditable ||
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT')
    ) {
      return;
    }
    if (tagMenuOpen) {
      e.stopPropagation();
      return;
    }
    const noMod = !e.metaKey && !e.ctrlKey && !e.altKey;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'e' && noMod && onArchive) {
      e.preventDefault();
      e.stopPropagation();
      onArchive();
    } else if (e.key === 's' && noMod && onToggleSave) {
      e.preventDefault();
      e.stopPropagation();
      onToggleSave();
    } else if (e.key === 't' && noMod) {
      e.preventDefault();
      e.stopPropagation();
      tagMenuOpen = !tagMenuOpen;
    } else if (e.key === 'ArrowDown' && noMod) {
      e.preventDefault();
      e.stopPropagation();
      paragraphTracking.nextParagraph();
    } else if (e.key === 'ArrowUp' && noMod) {
      e.preventDefault();
      e.stopPropagation();
      paragraphTracking.prevParagraph();
    } else if (e.key === 'h' && noMod) {
      e.preventDefault();
      e.stopPropagation();
      highlightsHook.toggleParagraphHighlight(paragraphTracking.currentParagraphIndex);
    }
  }

  // Lock body scroll and prevent touch events from bubbling to PullToRefresh
  // while the reader overlay is open.
  function stopTouchPropagation(e: TouchEvent) {
    e.stopPropagation();
  }

  // Dismiss the inline desktop style row when clicking outside the header
  // (it stays pinned, so it mirrors the feed nav's click-outside behavior).
  function handleClickOutside(e: MouseEvent) {
    if (!styleMenuOpen) return;
    if (headerRef && !headerRef.contains(e.target as Node)) {
      styleMenuOpen = false;
    }
  }

  onMount(() => {
    document.body.style.overflow = 'hidden';
    // The overlay covers the sidebar, so anything that normally centers on the
    // content column (the share composer) has to center on the viewport while
    // it's up. This class is that signal.
    document.body.classList.add('reader-open');
    document.addEventListener('keydown', handleKeydown, true);
    document.addEventListener('click', handleClickOutside);
    // The reader is a DOM child of PullToRefresh, so touch events bubble up
    // and trigger pull-to-refresh even though the reader is a fixed overlay.
    overlayEl?.addEventListener('touchstart', stopTouchPropagation, {
      passive: true,
    });
    overlayEl?.addEventListener('touchmove', stopTouchPropagation, {
      passive: true,
    });
    overlayEl?.addEventListener('touchend', stopTouchPropagation, {
      passive: true,
    });
  });
  onDestroy(() => {
    document.body.style.overflow = '';
    document.body.classList.remove('reader-open');
    if (progressRaf != null) {
      cancelAnimationFrame(progressRaf);
      progressRaf = null;
    }
    document.removeEventListener('keydown', handleKeydown, true);
    document.removeEventListener('click', handleClickOutside);
    overlayEl?.removeEventListener('touchstart', stopTouchPropagation);
    overlayEl?.removeEventListener('touchmove', stopTouchPropagation);
    overlayEl?.removeEventListener('touchend', stopTouchPropagation);
  });

  // Paragraph tracking for read progress
  const paragraphTracking = useParagraphTracking({
    contentEl: () => readerBodyEl,
    scrollRoot: () => overlayEl,
    itemKey: () => itemKey,
    itemType: () => labelItemType,
    // Scroll-driven — disabled in paged mode (paged position is tracked by page).
    enabled: () => !paged,
  });

  // Link interception for showing context menu on link clicks
  const linkInterception = useLinkInterception({
    contentEl: () => readerBodyEl,
    enabled: () => true,
    // Paged mode: a footnote jump turns to the target's page (scrolling would
    // slide the paged viewport sideways and desync every later page turn).
    pagedController: () => pagedController,
  });

  // Highlights hook
  const highlightsHook = useHighlights({
    contentEl: () => readerBodyEl,
    itemKey: () => itemKey,
    itemType: () => labelItemType,
    enabled: () => true,
    itemUrl: () => itemUrl,
    itemTitle: () => title,
  });
  const communityHighlightsHook = useCommunityHighlights({
    contentEl: () => readerBodyEl,
    itemUrl: () => itemUrl,
    enabled: () => readerItem.type === 'saved' && preferences.communityHighlights,
    load: () => readerItem.type === 'saved',
  });

  function toggleCommunityHighlights() {
    if (!preferences.communityHighlights) communityHighlightsHook.retry();
    preferences.setCommunityHighlights(!preferences.communityHighlights);
  }

  // Set up observer when the reader body is mounted — and re-run it whenever the
  // rendered content changes. Saved/article bodies load lazily (see the lazy*
  // effects above), so the first frame shows only the short description fallback;
  // depending on `sanitizedContent` here re-detects paragraphs against the full
  // body once it lands. `restoredForKey` gates the position restore to once per
  // item, but keeps retrying while a restore comes back `'partial'` (the saved
  // paragraph isn't in the detected set yet because the body is still loading).
  let restoredForKey: string | null = null;
  $effect(() => {
    void sanitizedContent; // re-run when the lazily-loaded body settles
    const key = itemKey;
    if (readerBodyEl && overlayEl) {
      tick().then(() => {
        paragraphTracking.setupObserver();
        linkInterception.attach();
        highlightsHook.attach();
        communityHighlightsHook.attach();
        // The scroll-driven progress bar + paragraph position restore only apply
        // to scroll mode; paged mode handles its own page restore (see above).
        if (paged) return;
        // Re-measure now that the (possibly lazily-loaded) body has settled, so
        // the bar reflects the current scroll position immediately.
        updateReadingProgress();
        if (restoredForKey === key) return;
        setTimeout(() => {
          if (restoredForKey === key) return;
          suppressScrollHide = true;
          const result = paragraphTracking.restorePosition();
          // 'exact'/'none' are terminal; 'partial' means retry on the next
          // content settle (the full body hasn't arrived yet).
          if (result !== 'partial') restoredForKey = key;
          if (result !== 'none') {
            // Wait for smooth scroll to finish before re-enabling header hide
            setTimeout(() => {
              if (overlayEl) lastScrollY = overlayEl.scrollTop;
              suppressScrollHide = false;
              updateReadingProgress();
            }, 600);
          } else {
            suppressScrollHide = false;
          }
        }, 100);
      });
    }
    return () => {
      paragraphTracking.cleanup();
      linkInterception.detach();
      highlightsHook.detach();
      communityHighlightsHook.detach();
    };
  });

  let deleteConfirming = $state(false);
  let deleteTimer: ReturnType<typeof setTimeout> | undefined;

  function handleDeleteClick() {
    if (deleteConfirming) {
      clearTimeout(deleteTimer);
      deleteConfirming = false;
      onRemove?.();
    } else {
      deleteConfirming = true;
      deleteTimer = setTimeout(() => {
        deleteConfirming = false;
      }, 3000);
    }
  }

  function handleOpenUrl() {
    if (itemUrl) window.open(itemUrl, '_blank', 'noopener');
  }
</script>

<div
  class="reader-overlay"
  class:magazine-mode={!!collection}
  class:paged
  style={collection ? `${magazineVars};background:var(--mag-bg);color:var(--mag-fg)` : ''}
  bind:this={overlayEl}
  onscroll={handleScroll}
>
  <!-- Reading progress, drawing two. A bare One-Blue hairline that stands in for
       the bar's own rail while that bar is off-screen, so progress is never lost
       mid-read. It pins to whichever edge the bar occupies: the top on desktop
       (clearing the notch), the bottom on mobile (clearing the home indicator). -->
  <div
    class="reading-progress"
    class:visible={railVisible}
    class:detached={headerHidden}
    class:bar-hidden={!controlsVisible}
    role="progressbar"
    aria-label="Reading progress"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={Math.round(railProgress * 100)}
  >
    <div class="reading-progress-fill" style:transform={`scaleX(${railProgress})`}></div>
  </div>

  <!-- Desktop: top bar — full-bleed, spanning the viewport rather than tracking
       the reading column, so it frames the page identically in scroll and paged
       mode (which use different content widths). -->
  <header class="reader-header desktop-only" class:hidden={headerHidden} bind:this={headerRef}>
    <div class="reader-header-bar">
      <div class="reader-actions-left">
        <button class="action-btn" onclick={onClose} title="Back (Escape)">
          <Icon name="arrow-left" size={16} />
          <span class="action-label">Back</span>
        </button>
      </div>

      <!-- Takes over from the article's H1 once that scrolls away. Decorative:
           the heading itself is the accessible name for the article. -->
      <div class="reader-bar-title" class:visible={titleVisible} aria-hidden="true">
        <span class="reader-bar-title-text">{title}</span>
        {#if sourceLabel}
          <span class="reader-bar-title-source">{sourceLabel}</span>
        {/if}
      </div>

      <div class="reader-actions-right">
        <button
          class="action-btn"
          class:active={styleMenuOpen}
          onclick={() => (styleMenuOpen = !styleMenuOpen)}
          title="Style"
        >
          <Icon name="type" size={16} />
          <span class="action-label">Style</span>
        </button>

        <button
          class="action-btn"
          class:active={paged}
          onclick={() => preferences.toggleReaderViewMode()}
          title={paged ? 'Switch to scroll view' : 'Switch to paged view'}
        >
          <Icon name={paged ? 'align-justify' : 'book-open'} size={16} />
          <span class="action-label">{paged ? 'Scroll' : 'Pages'}</span>
        </button>

        <span class="action-separator"></span>

        {#if readerItem.type === 'saved'}
          <button
            class="action-btn"
            class:active={preferences.communityHighlights}
            aria-pressed={preferences.communityHighlights}
            aria-label={communityHighlightsHook.count === undefined
              ? 'Community highlights'
              : `${communityHighlightsHook.count}${communityHighlightsHook.capped ? ' or more' : ''} community highlight${communityHighlightsHook.count === 1 ? '' : 's'}`}
            onclick={toggleCommunityHighlights}
            title="Passages highlighted by readers on margin.at"
          >
            <Icon name="users" size={16} />
            <span class="action-label">Community</span>
            {#if communityHighlightsHook.count !== undefined}
              <span class="action-count">
                ({communityHighlightsHook.count}{communityHighlightsHook.capped ? '+' : ''})
              </span>
            {/if}
          </button>
        {/if}

        {#if canShareLinkblog}
          <button
            class="action-btn"
            class:active={sharedNow}
            onclick={openShareComposer}
            title={sharedNow
              ? 'Shared to your linkblog — edit your note'
              : hasShareDraft
                ? 'Resume your share draft'
                : 'Share to your linkblog'}
          >
            <Icon name="share" size={16} />
            <span class="action-label">
              {sharedNow ? 'Shared' : hasShareDraft ? 'Draft' : 'Share'}
            </span>
          </button>
        {/if}

        {#if onArchive}
          <button
            class="action-btn"
            onclick={() => onArchive()}
            title={isArchived ? 'Move to inbox' : 'Archive (e)'}
          >
            <Icon name={isArchived ? 'inbox' : 'archive'} size={16} />
            <span class="action-label">{isArchived ? 'Inbox' : 'Archive'}</span>
          </button>
        {/if}

        {#if onToggleSave}
          <button
            class="action-btn"
            class:active={isSaved}
            onclick={() => onToggleSave!()}
            title={isSaved ? 'Unsave' : 'Save (s)'}
          >
            <Icon name="bookmark" size={16} />
            <span class="action-label">{isSaved ? 'Unsave' : 'Save'}</span>
          </button>
        {/if}

        <button
          class="action-btn"
          class:active={tagMenuOpen}
          bind:this={tagBtnRef}
          onclick={() => (tagMenuOpen = !tagMenuOpen)}
          title="Tag (t)"
        >
          <Icon name="tag" size={16} />
          <span class="action-label">Tag{itemTags.length > 0 ? ` (${itemTags.length})` : ''}</span>
        </button>

        <div class="overflow-menu-wrapper" bind:this={overflowRef}>
          <PopoverMenu items={overflowItems} bind:open={overflowMenuOpen} />
        </div>
      </div>
    </div>

    <!-- Inline style row: a flat extension of the header bar (not a floating
           pill), shown beneath the controls when Style is toggled. -->
    {#if styleMenuOpen}
      <div class="reader-style-row">
        <AppearanceToolbar />
      </div>
    {/if}

    <!-- Desktop only: the mobile menu below anchors to the bottom bar's tag
         button instead. Mounting both would register two document-level keydown
         handlers, and the number-key tag shortcuts would cancel each other out. -->
    {#if tagMenuOpen && !mobileStore.isMobile}
      <TagMenu
        {itemKey}
        itemType={labelItemType}
        anchorEl={tagBtnRef}
        onClose={() => (tagMenuOpen = false)}
      />
    {/if}

    <!-- The bar's bottom edge *is* the progress rail: a full-bleed track that
         fills One Blue as you move through the piece. One element does the job
         of the divider and the progress bar, so the bar reads as a definite
         edge instead of fading into the page. -->
    <div class="reader-rail" aria-hidden="true">
      <div class="reader-rail-fill" style:transform={`scaleX(${railProgress})`}></div>
    </div>
  </header>

  <!-- Mobile: one flat bar along the bottom edge, its top rail carrying reading
       progress. Lives outside .reader-container so the paged column's flex
       layout never has to account for it. -->
  <ReaderBottomBar
    progress={railProgress}
    eased={paged}
    visible={controlsVisible}
    onBack={onClose}
    {onArchive}
    {isArchived}
    {onToggleSave}
    {isSaved}
    onShare={canShareLinkblog ? openShareComposer : undefined}
    shareActive={sharedNow}
    onCommunity={readerItem.type === 'saved' ? toggleCommunityHighlights : undefined}
    communityCount={communityHighlightsHook.count}
    communityCapped={communityHighlightsHook.capped}
    communityActive={preferences.communityHighlights}
    bind:communityButtonEl={mobileCommunityBtnRef}
    onTag={readerItem.type !== 'saved' ? () => (tagMenuOpen = !tagMenuOpen) : undefined}
    tagCount={itemTags.length}
    tagActive={tagMenuOpen}
    bind:tagButtonEl={mobileTagBtnRef}
    onMore={() => (styleSheetOpen = true)}
    moreActive={styleSheetOpen}
  />

  <div class="reader-container" class:paged>
    <!-- Mobile: style & actions bottom sheet -->
    {#if mobileStore.isMobile}
      <BottomSheet
        open={styleSheetOpen}
        onclose={() => (styleSheetOpen = false)}
        title="Style & Actions"
      >
        <div class="style-sheet-content">
          <div class="style-sheet-section">
            <div class="style-sheet-label">Appearance</div>
            <div class="toolbar-wrapper">
              <AppearanceToolbar />
            </div>
            <ReadingModeToggle />
          </div>

          <div class="style-sheet-section">
            <div class="style-sheet-label">Actions</div>
            <div class="style-sheet-actions">
              <button
                class="sheet-action-btn"
                onclick={() => {
                  styleSheetOpen = false;
                  tagMenuOpen = true;
                }}
              >
                <Icon name="tag" size={18} />
                <span>Tag{itemTags.length > 0 ? ` (${itemTags.length})` : ''}</span>
              </button>
              {#if onToggleSave}
                <button
                  class="sheet-action-btn"
                  onclick={() => {
                    onToggleSave!();
                    styleSheetOpen = false;
                  }}
                >
                  <Icon name="bookmark" size={18} />
                  <span>{isSaved ? 'Unsave' : 'Save'}</span>
                </button>
              {/if}
              {#if canSaveToIntegration}
                <button
                  class="sheet-action-btn"
                  onclick={() => {
                    saveToSemble();
                    styleSheetOpen = false;
                  }}
                >
                  <Icon name="semble" size={18} />
                  <span>Save to Semble</span>
                </button>
                <button
                  class="sheet-action-btn"
                  onclick={() => {
                    saveToMargin();
                    styleSheetOpen = false;
                  }}
                >
                  <Icon name="margin" size={18} />
                  <span>Save to Margin</span>
                </button>
              {/if}
              <button
                class="sheet-action-btn"
                onclick={() => {
                  handleOpenUrl();
                  styleSheetOpen = false;
                }}
              >
                <Icon name="external-link" size={18} />
                <span>Open in browser</span>
              </button>
              {#if onRemove}
                <button
                  class="sheet-action-btn danger"
                  onclick={() => {
                    if (deleteConfirming) {
                      clearTimeout(deleteTimer);
                      deleteConfirming = false;
                      onRemove!();
                      styleSheetOpen = false;
                    } else {
                      deleteConfirming = true;
                      deleteTimer = setTimeout(() => (deleteConfirming = false), 3000);
                    }
                  }}
                >
                  <Icon name="trash" size={18} />
                  <span>{deleteConfirming ? 'Confirm delete?' : 'Delete'}</span>
                </button>
              {/if}
            </div>
          </div>
        </div>
      </BottomSheet>

      {#if tagMenuOpen}
        <TagMenu
          {itemKey}
          itemType={labelItemType}
          anchorEl={mobileTagAnchorRef}
          onClose={() => (tagMenuOpen = false)}
        />
      {/if}
    {/if}

    {#if linkInterception.menuState}
      {#key linkInterception.menuState.url + linkInterception.menuState.anchorRect.top}
        <LinkContextMenu
          url={linkInterception.menuState.url}
          linkText={linkInterception.menuState.linkText}
          anchorRect={linkInterception.menuState.anchorRect}
          onClose={linkInterception.closeMenu}
        />
      {/key}
    {/if}

    <!-- The article header + body, shared verbatim between scroll and paged modes
         (same DOM element, so `readerBodyEl` + hooks bind identically either way). -->
    {#snippet articleContent()}
      <div class="reader-article-header" bind:this={articleHeaderEl}>
        <h1 class="reader-title">{title}</h1>
        <div class="reader-meta">
          {#if faviconUrl}
            <img src={faviconUrl} alt="" class="reader-favicon" />
          {/if}
          {#if feedTitle}
            <a href="/feeds?feed={sub?.id}" class="reader-feed">{feedTitle}</a>
          {/if}
          {#if authorLabel}
            <span class="reader-author">{authorLabel}</span>
          {/if}
          <span class="reader-date">{formatRelativeDate(publishedAt)}</span>
          <span class="reader-read-time">
            <Icon name="clock" size={12} />
            {readTimeMinutes} min read
          </span>
        </div>
        {#if itemTags.length > 0}
          <div class="reader-tags">
            {#each itemTags as tag}
              <span class="reader-tag-chip">{tag}</span>
            {/each}
          </div>
        {/if}
      </div>

      <div class="reader-body-wrapper">
        {#if collection}
          <!-- Rendered outside .reader-body so its prose globals (p/ol/li/
               blockquote margins) don't bleed into the edition's own card
               layout. -->
          <div class="reader-collection-host">
            <CollectionMagazine
              {collection}
              title={collectionTitle}
              onSavePiece={saveCollectionPiece}
              isPieceSaved={isCollectionPieceSaved}
              pagedController={() => pagedController}
            />
          </div>
        {:else}
          <div class="reader-body" bind:this={readerBodyEl} use:bskyEmbed>
            {@html sanitizedContent}
          </div>
        {/if}
      </div>

      <!-- Share-to-linkblog + discussion rails. Part of the shared content so they
           sit at the end in scroll mode and flow onto the final page(s) when
           paged. -->
      <ReaderDiscussion {readerItem} />
    {/snippet}

    {#if paged}
      <!-- Kindle-style paged reading. -->
      <PagedView
        bottomInset={mobileStore.isMobile ? READER_BAR_INSET : 0}
        deps={() => [sanitizedContent, preferences.articleFont, preferences.articleFontSize]}
        bind:currentPage={pagedPage}
        bind:totalPages={pagedTotal}
        oncontroller={(c) => (pagedController = c)}
        onpagechange={(page) => handlePagedPageChange(page)}
      >
        {@render articleContent()}
      </PagedView>
    {:else}
      <article class="reader-article">
        {@render articleContent()}
      </article>
    {/if}
  </div>
</div>

{#if highlightsHook.popoverState}
  <HighlightPopover
    mode={highlightsHook.popoverState.mode}
    anchorRect={highlightsHook.popoverState.anchorRect}
    getAnchorRect={highlightsHook.popoverAnchorRect}
    onHighlight={highlightsHook.createHighlightFromPopover}
    onHighlightToMargin={highlightsHook.createHighlightFromPopoverToMargin}
    onRemove={highlightsHook.removeHighlightFromPopover}
    onSaveToMargin={highlightsHook.savePopoverHighlightToMargin}
    onSaveNote={highlightsHook.saveNoteFromPopover}
    onQuoteToShare={composerOpenHere ? quoteSelectionToShare : undefined}
    existingNote={highlightsHook.popoverHighlightNote}
    marginSaved={highlightsHook.popoverHighlightSavedToMargin}
    onClose={highlightsHook.closePopover}
  />
{/if}

{#if communityHighlightsHook.popoverState}
  <CommunityHighlightPopover
    group={communityHighlightsHook.popoverState.group}
    anchorRect={communityHighlightsHook.popoverState.anchorRect}
    getAnchorRect={communityHighlightsHook.popoverAnchorRect}
    {itemUrl}
    capped={communityHighlightsHook.capped}
    onClose={communityHighlightsHook.closePopover}
  />
{/if}

{#if highlightsHook.notePeek}
  <NotePeek note={highlightsHook.notePeek.note} anchorRect={highlightsHook.notePeek.anchorRect} />
{/if}

<style>
  .reader-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 100;
    background: var(--color-bg, #ffffff);
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  /* Paged mode: the overlay no longer scrolls — it's a flex column (header on top,
     the paged column filling the rest). The container drops its 800px cap so the
     paginator can use its own wider band and take the full remaining height. */
  .reader-overlay.paged {
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .reader-container.paged {
    flex: 1;
    min-height: 0;
    max-width: none;
    width: 100%;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .reader-container.paged :global(.paged-root) {
    flex: 1 1 0;
    min-height: 0;
    height: auto;
  }

  /* Edition view: the chrome takes the publication's own palette (not the app's
     default) so it belongs to the magazine rather than cutting across it — and
     stays opaque, since a pinned bar must occlude the article moving beneath it
     rather than let text bleed through. Declared as variables so the mobile bar,
     which lives in its own component, repaints from the same source. */
  .reader-overlay.magazine-mode {
    --reader-chrome-bg: var(--mag-bg);
    --reader-chrome-fg: color-mix(in srgb, var(--mag-fg) 78%, var(--mag-bg));
    --reader-chrome-accent: var(--mag-accent);
    --reader-rail-track: color-mix(in srgb, var(--mag-fg) 18%, transparent);
    --reader-rail-fill: var(--mag-accent);
  }

  .reader-overlay.magazine-mode .reader-header {
    background: var(--reader-chrome-bg);
  }

  .reader-overlay.magazine-mode .reader-rail {
    background: var(--reader-rail-track);
  }

  .reader-overlay.magazine-mode .reader-rail-fill {
    background: var(--reader-rail-fill);
  }

  .reader-overlay.magazine-mode .reader-bar-title-text {
    color: var(--mag-fg);
  }

  /* Tinted from the edition's own foreground toward its background (not toward
     transparent, and never gray) so it stays legible on any publication palette. */
  .reader-overlay.magazine-mode .reader-bar-title-source {
    color: color-mix(in srgb, var(--mag-fg) 78%, var(--mag-bg));
  }

  /* Detached progress hairline. Fixed above the sticky header (z 10) but below
     RefreshProgressBar (z 500) so the refresh bar wins on the rare overlap.
     Flat-by-default: transparent track, One Blue fill, no shadow — no track
     here, so it reads as progress rather than as a stray divider.

     It only ever draws while the bar that owns the rail is off-screen; otherwise
     two lines would show the same value. Desktop watches the top bar, mobile the
     bottom one. */
  .reading-progress {
    position: fixed;
    top: env(safe-area-inset-top, 0px);
    left: 0;
    right: 0;
    height: 2px;
    z-index: 200;
    background: transparent;
    overflow: hidden;
    opacity: 0;
    transition: opacity 0.25s ease;
    pointer-events: none;
  }

  @media (min-width: 1001px) {
    .reading-progress.visible.detached {
      opacity: 1;
    }
  }

  .reading-progress-fill {
    height: 2px;
    background: var(--reader-rail-fill, var(--color-primary, #0066cc));
    transform-origin: left;
    /* No transition — scroll drives the fill frame-by-frame for smooth motion. */
    will-change: transform;
  }

  @media (max-width: 1000px) {
    /* Pinned to the bottom, above the home indicator: it stands in for the
       mobile bar's top rail, so it belongs at that bar's edge. Opaque, and
       carrying the inset as padding rather than as an offset, so like the bar
       it replaces it occludes the article moving beneath it instead of leaving
       a sliver of text visible under the home indicator. */
    .reading-progress {
      top: auto;
      bottom: 0;
      height: auto;
      padding-bottom: env(safe-area-inset-bottom, 0px);
      background: var(--reader-chrome-bg, var(--color-bg, #fff));
    }

    .reading-progress.visible.bar-hidden {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .reading-progress {
      transition: none;
    }
  }

  /* The overlay is an opaque full-screen layer that covers the sidebar, so the
     reading column centers in the whole viewport — its inner bands all use
     `max-width: 800px; margin: 0 auto`. (Don't pad past the sidebar width here:
     the sidebar isn't visible in reading mode, so that just shifts the column
     off-center to the right.) */

  /* Same 800px band and 1rem inset as the feed body (.feed-page-body + the
     card's `padding: 0 1rem`). */
  .reader-container {
    max-width: 800px;
    margin: 0 auto;
    padding: 0 1rem 4rem;
  }

  /* A flat, solid bar pinned to the top of the overlay, full-bleed edge to edge.
     It deliberately does *not* track the reading column: scroll mode centers an
     800px article and paged mode a 1200px spread, so a column-width bar lands in
     the wrong place in one of them. Framing the viewport is the one geometry
     that's right in both. Flat-by-default: no blur, no shadow — the rail at the
     bottom is the only edge it needs. */
  .reader-header {
    position: sticky;
    top: 0;
    z-index: 10;
    /* Column flex so the bar and the inline style row stack vertically and each
       stretches to the full width. (The .desktop-only class also sets
       display:flex; this makes the direction explicit — without it the bar
       becomes a shrink-wrapped row item and its space-between collapses.) */
    display: flex;
    flex-direction: column;
    background: var(--color-bg, #ffffff);
    margin-bottom: 0.5rem;
    /* Hide on scroll-down / reveal on scroll-up — matches the mobile bottom
       bar's motion. The header is position:sticky overlaying content, so
       translating it off-screen reclaims vertical space without reflow. */
    transition: transform 0.25s ease;
  }

  .reader-header.hidden {
    transform: translateY(-100%);
  }

  /* The rail: the bar's bottom edge and its reading-progress indicator, one
     element. The track is a solid 2px in Divider so the edge is unmistakable at
     any scroll position (this replaces the old fade-in hairline), and the fill
     is One Blue driven by the same 0–1 value in both scroll and paged mode. */
  .reader-rail {
    position: relative;
    flex-shrink: 0;
    height: 2px;
    overflow: hidden;
    background: var(--color-border);
  }

  .reader-rail-fill {
    height: 100%;
    background: var(--color-primary, #0066cc);
    transform-origin: left;
    /* No transition in scroll mode — scroll drives it frame-by-frame. Paged mode
       jumps a whole page at a time, so it gets an eased settle below. */
    will-change: transform;
  }

  .reader-overlay.paged .reader-rail-fill {
    transition: transform 0.34s cubic-bezier(0.22, 1, 0.36, 1);
  }

  @media (prefers-reduced-motion: reduce) {
    .reader-header {
      transition: none;
    }

    .reader-overlay.paged .reader-rail-fill {
      transition: none;
    }
  }

  .reader-header-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    width: 100%;
    /* Full-bleed: inset from the viewport edges, not centered in a column. */
    padding: 0.625rem clamp(0.75rem, 1.5vw, 1.5rem);
  }

  .reader-actions-left,
  .reader-actions-right {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: 0.5rem;
    /* Never let the title slot squeeze the controls. */
    flex-shrink: 0;
  }

  /* The title slot fills the width the full-bleed bar opened up. It centers in
     the space left between Back and the actions rather than in the viewport, so
     it can never slide underneath either group. */
  .reader-bar-title {
    display: flex;
    align-items: baseline;
    justify-content: center;
    gap: 0.5rem;
    flex: 1 1 auto;
    min-width: 0;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.25s ease;
  }

  .reader-bar-title.visible {
    opacity: 1;
  }

  .reader-bar-title-text {
    overflow: hidden;
    color: var(--color-text);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .reader-bar-title-source {
    flex-shrink: 0;
    max-width: 14ch;
    overflow: hidden;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (prefers-reduced-motion: reduce) {
    .reader-bar-title {
      transition: none;
    }
  }

  /* Matches the feed header's .view-toggle button: padded, 6px radius, grey
     hover/active rather than a floating pill. */
  .action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    background: none;
    border: none;
    padding: 0.4rem 0.6rem;
    border-radius: 6px;
    cursor: pointer;
    color: var(--color-text-secondary);
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }

  .action-label {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }

  .action-count {
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
  }

  .action-btn:hover:not(.active) {
    color: var(--color-text);
  }

  .action-btn.active {
    background: var(--color-bg-secondary, #f5f5f5);
    color: var(--color-text);
  }

  .overflow-menu-wrapper {
    display: flex;
    align-items: center;
  }

  .overflow-menu-wrapper :global(.menu-trigger) {
    width: auto;
    height: auto;
    padding: 0.4rem;
    border-radius: 6px;
    background: none;
    color: var(--color-text-secondary);
  }

  .overflow-menu-wrapper :global(.menu-trigger:hover) {
    background: var(--color-bg-secondary, #f5f5f5);
    color: var(--color-text);
  }

  .action-separator {
    width: 1px;
    height: 1rem;
    background: var(--color-border, #e5e7eb);
    opacity: 0.5;
    flex-shrink: 0;
  }

  /* Desktop/mobile visibility (the mobile bar carries its own breakpoint guard) */
  .desktop-only {
    display: flex;
  }

  @media (max-width: 1000px) {
    .desktop-only {
      display: none !important;
    }
  }

  /* Inline style row: a flat extension of the bar, right-aligned beneath the
     controls it belongs to and sharing their full-bleed inset. No floating pill —
     it sits in normal flow above the rail (closes on click-outside). */
  .reader-style-row {
    display: flex;
    justify-content: flex-end;
    width: 100%;
    padding: 0 clamp(0.75rem, 1.5vw, 1.5rem) 0.625rem;
  }

  .reader-article-header {
    margin-bottom: 2rem;
  }

  .reader-title {
    font-size: var(--text-4xl);
    font-weight: var(--weight-bold);
    line-height: var(--leading-tight);
    color: var(--color-text);
    margin: 0 0 0.75rem;
  }

  .reader-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .reader-favicon {
    width: 16px;
    height: 16px;
    border-radius: 3px;
  }

  .reader-feed {
    font-weight: var(--weight-medium);
    color: var(--color-text-secondary);
    text-decoration: none;
  }

  .reader-feed:hover {
    color: var(--color-primary, #0066cc);
  }

  .reader-read-time {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
  }

  .reader-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-top: 0.5rem;
  }

  .reader-tag-chip {
    display: inline-flex;
    align-items: center;
    padding: 0.125rem 0.5rem;
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    background: rgba(37, 99, 235, 0.08);
    color: var(--color-primary, #2563eb);
    border-radius: 999px;
  }

  .reader-body-wrapper {
    position: relative;
  }

  /* Host for a curated edition. Deliberately bare — CollectionReader owns its own
     typography, and keeping it out of .reader-body avoids the prose globals. */
  .reader-collection-host {
    position: relative;
  }

  .reader-body {
    position: relative;
    font-family: var(--article-font, Georgia, 'Times New Roman', serif);
    font-size: var(--article-font-size, 1.0625rem);
    line-height: 1.8;
    color: var(--color-text);
    overflow-wrap: break-word;
    /* Disable iOS double-tap-to-zoom so double-tap reaches the highlight
       handler (mirrors .article-content in the card view). */
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }

  .reader-body :global(img),
  .reader-body :global(svg) {
    max-width: 100%;
    height: auto;
    border-radius: 4px;
    margin: 1rem 0;
  }

  .reader-body :global(video) {
    max-width: 100%;
    height: auto;
    border-radius: 6px;
    margin: 1rem 0;
    cursor: auto;
  }

  .reader-body :global(iframe) {
    display: block;
    width: 100%;
    max-width: 100%;
    aspect-ratio: 16 / 9;
    height: auto;
    border: 0;
    border-radius: 6px;
    margin: 1rem 0;
    cursor: auto;
  }

  .reader-body :global(a) {
    color: var(--color-primary, #0066cc);
  }

  .reader-body :global(pre) {
    background: var(--color-bg-secondary, #f3f4f6);
    padding: 1rem;
    border-radius: 6px;
    overflow-x: auto;
    font-size: var(--text-md);
  }

  .reader-body :global(table) {
    display: block;
    max-width: 100%;
    overflow-x: auto;
  }

  /* Native MathML. Display equations get their own line and scroll rather than
     forcing the column wider; inline math just rides along with the text. */
  .reader-body :global(math[display='block']) {
    display: block;
    max-width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    margin: 1rem 0;
    padding-bottom: 0.25rem;
  }

  .reader-body :global(math) {
    max-width: 100%;
  }

  .reader-body :global(blockquote) {
    border-left: 3px solid var(--color-border);
    margin: 1rem 0;
    padding-left: 1rem;
    color: var(--color-text-secondary);
  }

  .reader-body :global(p) {
    margin: 1rem 0;
  }

  .reader-body :global(p:first-child) {
    margin-top: 0;
  }

  .reader-body :global(h1),
  .reader-body :global(h2),
  .reader-body :global(h3),
  .reader-body :global(h4) {
    margin: 1.5rem 0 0.75rem;
    line-height: var(--leading-tight);
  }

  .reader-body :global(ul),
  .reader-body :global(ol) {
    margin: 1rem 0;
    padding-left: 2rem;
  }

  .reader-body :global(li) {
    margin: 0.25rem 0;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }

  .reader-body :global(mark.highlight) {
    background-color: color-mix(in srgb, #f5c518 25%, transparent);
    border-radius: 1px;
    cursor: pointer;
    transition: background-color 0.2s ease;
  }

  .reader-body :global(mark.highlight:hover) {
    background-color: color-mix(in srgb, #f5c518 40%, transparent);
  }

  .reader-body :global(mark.community-highlight) {
    color: inherit;
    background: transparent;
    text-decoration: underline dotted #7a8694 1.5px;
    text-underline-offset: 0.18em;
    cursor: pointer;
  }

  :global([data-theme='dark']) .reader-body :global(mark.community-highlight) {
    text-decoration-color: #9aa6b2;
  }

  /* Leaflet footnote styling is shared by every surface that renders leaflet
     content, so it lives in app.css rather than here. */

  /* On narrower desktops, drop the action labels to icons — matches the feed
     header's 1100px breakpoint so both collapse at the same width. */
  @media (max-width: 1100px) {
    .action-label {
      display: none;
    }

    .action-btn {
      padding: 0.4rem;
    }
  }

  /* Style bottom sheet content */
  .style-sheet-content {
    padding: 0.5rem 1.25rem 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .style-sheet-section {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  .style-sheet-label {
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wider);
    padding-left: 0.25rem;
  }

  .style-sheet-content .toolbar-wrapper {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .style-sheet-content .toolbar-wrapper :global(.appearance-toolbar) {
    background: none;
    box-shadow: none;
    backdrop-filter: none;
    padding: 0;
    border-radius: 0;
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  .style-sheet-content .toolbar-wrapper :global(.size-btn) {
    padding: 0.6rem;
  }

  .style-sheet-content .toolbar-wrapper :global(.size-value) {
    font-size: var(--text-lg);
    min-width: 1.75rem;
  }

  .style-sheet-content .toolbar-wrapper :global(.group-label) {
    display: block;
    font-size: var(--text-xs);
  }

  .style-sheet-actions {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--color-border);
    border-radius: 10px;
    overflow: hidden;
  }

  .sheet-action-btn {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    background: none;
    border: none;
    border-bottom: 1px solid var(--color-border);
    color: var(--color-text);
    font-size: var(--text-lg);
    text-align: left;
    width: 100%;
    transition: background 0.1s;
  }

  .sheet-action-btn:last-child {
    border-bottom: none;
  }

  .sheet-action-btn:active {
    background: var(--color-bg-secondary, #f5f5f5);
  }

  .sheet-action-btn :global(.icon) {
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }

  .sheet-action-btn.danger {
    color: var(--color-error, #dc2626);
  }

  .sheet-action-btn.danger :global(.icon) {
    color: var(--color-error, #dc2626);
  }

  @media (max-width: 1000px) {
    .reader-container {
      padding: 1rem 1rem calc(5rem + env(safe-area-inset-bottom, 0px));
    }
  }

  @media (max-width: 640px) {
    .reader-container {
      padding: 1rem 1rem calc(5rem + env(safe-area-inset-bottom, 0px));
    }

    .reader-title {
      font-size: 1.375rem;
    }
  }

  @media (prefers-color-scheme: dark) {
    .sheet-action-btn:active {
      background: rgba(255, 255, 255, 0.1);
    }
  }
</style>
