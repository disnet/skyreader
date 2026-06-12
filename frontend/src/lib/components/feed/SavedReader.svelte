<script lang="ts">
  import type { Article } from '$lib/types';
  import type { FeedDisplayItem } from '$lib/stores/feedView.svelte';
  import { normalizeDisplayItem, getAuthorLabel, getDisplayContent } from '$lib/utils/displayItem';
  import { getExternalArticleLink, formatQuoteSeed } from '$lib/utils/linkPost';
  import { linkPostContentStore } from '$lib/stores/linkPostContent.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { linkblogStore } from '$lib/stores/linkblog.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { socialStore } from '$lib/stores/social.svelte';
  import { db } from '$lib/services/db';
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
  import AtmospherePanel from '$lib/components/feed/AtmospherePanel.svelte';
  import { useAtmosphere } from '$lib/hooks/useAtmosphere.svelte';
  import type { LaneId } from '$lib/components/articleCardView.types';
  import { useParagraphTracking } from '$lib/hooks/useParagraphTracking.svelte';
  import { useLinkInterception } from '$lib/hooks/useLinkInterception.svelte';
  import { useHighlights } from '$lib/hooks/useHighlights.svelte';
  import HighlightPopover from '$lib/components/feed/HighlightPopover.svelte';
  import { preferences, type ArticleFont } from '$lib/stores/preferences.svelte';
  import { mobileStore } from '$lib/stores/mediaQuery.svelte';
  import { tick, onMount, onDestroy } from 'svelte';

  let {
    readerItem,
    onClose,
    onArchive,
    onRemove,
    onToggleSave,
    onSaveToSemble,
    onSaveToMargin,
  }: {
    readerItem: FeedDisplayItem;
    onClose: () => void;
    onArchive?: () => void;
    onRemove?: () => void;
    onToggleSave?: () => void;
    onSaveToSemble?: () => void;
    onSaveToMargin?: () => void;
  } = $props();

  let styleMenuOpen = $state(false);
  let styleSheetOpen = $state(false);
  let tagMenuOpen = $state(false);
  let overflowRef = $state<HTMLDivElement | null>(null);
  let tagBtnRef = $state<HTMLButtonElement | null>(null);
  let controlsVisible = $state(true);
  let scrolled = $state(false);
  let lastScrollY = $state(0);
  let suppressScrollHide = $state(false);
  let overlayEl: HTMLElement | undefined = $state();
  let readerBodyEl: HTMLElement | undefined = $state();
  let headerRef = $state<HTMLElement | undefined>(undefined);

  let itemKey = $derived(readerItem.key);
  let itemTags = $derived(itemLabelsStore.getTagsForItem(itemKey));

  let labelItemType = $derived.by((): 'article' | 'document' | 'saved' => readerItem.type);

  const fontOptions: { value: ArticleFont; label: string; family: string }[] = [
    { value: 'sans-serif', label: 'Sans', family: 'sans-serif' },
    { value: 'serif', label: 'Serif', family: 'serif' },
    { value: 'mono', label: 'Mono', family: 'monospace' },
    { value: 'literata', label: 'Literata', family: 'Literata, serif' },
  ];

  const sizeLabels: Record<string, string> = {
    xs: 'XS',
    sm: 'S',
    md: 'M',
    lg: 'L',
    xl: 'XL',
  };

  function handleScroll() {
    if (!overlayEl) return;
    // Scroll-aware divider: the desktop header blends into the page at the top
    // and grows its hairline divider once content scrolls underneath it. (The
    // header stays pinned — only the mobile bottom bar hides on scroll.)
    const next = overlayEl.scrollTop > 4;
    if (next !== scrolled) scrolled = next;

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
  $effect(() => {
    lazyArticleContent = null;
    if (readerItem.type !== 'article') return;
    const { id, guid, subscriptionId, content: inMemoryContent } = readerItem.item;
    let cancelled = false;
    (async () => {
      try {
        const saved = savesStore.getByGuid(guid);
        if (saved?.rkey) {
          const savedBody = await savesStore.getContent(saved.rkey);
          if (savedBody) {
            if (!cancelled) lazyArticleContent = savedBody;
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
        if (!cancelled) lazyArticleContent = row?.content ?? '';
      } catch {
        if (!cancelled) lazyArticleContent = '';
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
    // Same for a saved feed article rendered via the 'article' path — its body
    // was stripped from memory and is read back from IndexedDB above.
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

  let isArchived = $derived(itemLabelsStore.isArchived(itemKey));
  let isSaved = $derived(itemLabelsStore.isSaved(itemKey));
  // ── Sharing + Discussion (the Atmosphere) ──────────────────────────────────
  // Driven straight off linkblogStore, keyed on the item's URL — the same source
  // of truth the feed card uses — so the share, its note, and the lane counts
  // stay in lockstep whether the reader was opened from the feed or the saved
  // list. It all lives inline at the end of the article: a Share button that
  // becomes the note box once shared, then the discussion lanes.
  let sharedNow = $derived(linkblogStore.isShared(itemUrl));
  let currentShareNote = $derived(linkblogStore.getNote(itemUrl));
  let canShareLinkblog = $derived(Boolean(auth.user));

  // The article record to share for the Blogs lane, built from whichever item
  // type the reader is showing. A document carries its recordUri as repostUri so
  // a reshared link post credits the original.
  let shareTarget = $derived.by((): { article: Article; repostUri?: string } | null => {
    if (!itemUrl) return null;
    if (readerItem.type === 'article') return { article: readerItem.item };
    if (readerItem.type === 'saved') {
      const s = readerItem.item;
      return {
        article: {
          subscriptionId: 0,
          guid: s.url,
          url: s.url,
          title: s.title ?? s.url,
          author: s.author ?? undefined,
          summary: s.description ?? undefined,
          imageUrl: s.image ?? undefined,
          publishedAt: s.publishedAt ?? s.savedAt,
          fetchedAt: Date.now(),
        },
      };
    }
    const d = readerItem.item;
    const image = d.coverImageCid
      ? `https://cdn.bsky.app/img/feed_fullsize/plain/${d.authorDid}/${d.coverImageCid}@jpeg`
      : undefined;
    return {
      article: {
        subscriptionId: 0,
        guid: itemUrl,
        url: itemUrl,
        title: title || itemUrl,
        author: linkPostArticle?.author ?? undefined,
        summary: d.description ?? undefined,
        imageUrl: image,
        publishedAt,
        fetchedAt: Date.now(),
      },
      repostUri: d.recordUri,
    };
  });

  // Seed a fresh share's note with the item's excerpt as an editable quote.
  let seededQuote = $derived(formatQuoteSeed(shareTarget?.article.summary));

  async function shareNow() {
    const t = shareTarget;
    if (!t) return;
    await linkblogStore.shareLink(t.article, seededQuote ?? '', t.repostUri);
  }

  function applyShareNote(note: string) {
    linkblogStore.setNote(itemUrl, note);
  }

  async function removeShare() {
    await linkblogStore.unshare(itemUrl);
  }

  // Whether the user can contribute to a lane from the reader (mode-specific).
  // The Blogs lane defers to the dedicated Share button + note box below, so it
  // never offers its own [+] here — it stays a count-and-read affordance.
  function laneCanCreate(id: LaneId): boolean {
    switch (id) {
      case 'linkblog':
        return false;
      case 'semble':
        return Boolean(onSaveToSemble);
      case 'margin':
        return Boolean(onSaveToMargin);
      case 'bluesky':
        return true;
    }
  }

  const atmosphere = useAtmosphere({
    itemUrl: () => itemUrl,
    isShared: () => sharedNow,
    canCreate: laneCanCreate,
  });

  function createInLane(id: LaneId) {
    switch (id) {
      case 'linkblog':
        if (!sharedNow) void shareNow();
        break;
      case 'semble':
        onSaveToSemble?.();
        break;
      case 'margin':
        onSaveToMargin?.();
        break;
      case 'bluesky':
        window.open(
          `https://bsky.app/intent/compose?text=${encodeURIComponent(itemUrl)}`,
          '_blank',
          'noopener'
        );
        break;
    }
  }

  function openAuthor(did: string) {
    sidebarStore.openAddFeedModalForDid(did);
  }

  let sanitizedContent = $derived(sanitizeHtml(displayContent, itemUrl));

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

    if (onSaveToSemble) {
      items.push({
        label: 'Save to Semble',
        icon: 'semble',
        onclick: () => onSaveToSemble!(),
      });
    }

    if (onSaveToMargin) {
      items.push({
        label: 'Save to Margin',
        icon: 'margin',
        onclick: () => onSaveToMargin!(),
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
    enabled: () => true,
  });

  // Link interception for showing context menu on link clicks
  const linkInterception = useLinkInterception({
    contentEl: () => readerBodyEl,
    enabled: () => true,
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

<div class="reader-overlay" bind:this={overlayEl} onscroll={handleScroll}>
  <!-- Desktop: top header — a full-width flat bar (matches the feed header's
       800px band) so the chrome doesn't shift when opening the reader. The
       article below lives in its own narrower reading column. -->
  <header class="reader-header desktop-only" class:scrolled bind:this={headerRef}>
    <div class="reader-header-bar">
      <div class="reader-actions-left">
        <button class="action-btn" onclick={onClose} title="Back (Escape)">
          <Icon name="arrow-left" size={16} />
          <span class="action-label">Back</span>
        </button>
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

        <span class="action-separator"></span>

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
          <PopoverMenu items={overflowItems} />
        </div>
      </div>
    </div>

    <!-- Inline style row: a flat extension of the header bar (not a floating
           pill), shown beneath the controls when Style is toggled. -->
    {#if styleMenuOpen}
      <div class="reader-style-row">
        <div class="style-toolbar">
          <div class="toolbar-group">
            <span class="group-label">Font</span>
            <div class="segment-group" role="group" aria-label="Font style">
              {#each fontOptions as option}
                <button
                  class="segment-btn"
                  class:active={preferences.articleFont === option.value}
                  onclick={() => preferences.setArticleFont(option.value)}
                  title={option.label}
                >
                  <span class="font-preview" style:font-family={option.family}>Aa</span>
                </button>
              {/each}
            </div>
          </div>

          <span class="toolbar-divider"></span>

          <div class="toolbar-group">
            <span class="group-label">Size</span>
            <div class="size-controls" role="group" aria-label="Font size">
              <button
                class="size-btn"
                onclick={() => preferences.decreaseFontSize()}
                disabled={preferences.articleFontSize === 'xs'}
                title="Decrease font size"
              >
                <Icon name="minus" size={14} />
              </button>
              <span class="size-label">{sizeLabels[preferences.articleFontSize]}</span>
              <button
                class="size-btn"
                onclick={() => preferences.increaseFontSize()}
                disabled={preferences.articleFontSize === 'xl'}
                title="Increase font size"
              >
                <Icon name="plus" size={14} />
              </button>
            </div>
          </div>
        </div>
      </div>
    {/if}

    {#if tagMenuOpen}
      <TagMenu
        {itemKey}
        itemType={labelItemType}
        anchorEl={tagBtnRef}
        onClose={() => (tagMenuOpen = false)}
      />
    {/if}
  </header>

  <div class="reader-container">
    <!-- Mobile: bottom bar -->
    <div class="reader-bottom-bar mobile-only" class:hidden={!controlsVisible}>
      <button class="bottom-btn" onclick={onClose} title="Back (Escape)">
        <Icon name="arrow-left" size={20} />
      </button>

      <div class="bottom-bar-right">
        {#if onArchive}
          <button
            class="bottom-btn"
            onclick={() => onArchive()}
            title={isArchived ? 'Move to inbox' : 'Archive (e)'}
          >
            <Icon name={isArchived ? 'inbox' : 'archive'} size={20} />
          </button>
          <span class="bottom-separator"></span>
        {/if}
        {#if onToggleSave}
          <button
            class="bottom-btn"
            class:active={isSaved}
            onclick={() => onToggleSave!()}
            title={isSaved ? 'Unsave' : 'Save (s)'}
          >
            <Icon name="bookmark" size={20} />
          </button>
        {/if}
        <button
          class="bottom-btn"
          class:active={tagMenuOpen}
          bind:this={tagBtnRef}
          onclick={() => (tagMenuOpen = !tagMenuOpen)}
          title="Tag (t)"
        >
          <Icon name="tag" size={20} />
        </button>
        <span class="bottom-separator"></span>
        <button
          class="bottom-btn"
          class:active={styleSheetOpen}
          onclick={() => (styleSheetOpen = true)}
          title="Style & Actions"
        >
          <Icon name="sliders" size={20} />
        </button>
      </div>
    </div>

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
              {#if onSaveToSemble}
                <button
                  class="sheet-action-btn"
                  onclick={() => {
                    onSaveToSemble!();
                    styleSheetOpen = false;
                  }}
                >
                  <Icon name="semble" size={18} />
                  <span>Save to Semble</span>
                </button>
              {/if}
              {#if onSaveToMargin}
                <button
                  class="sheet-action-btn"
                  onclick={() => {
                    onSaveToMargin!();
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
          anchorEl={tagBtnRef}
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

    <article class="reader-article">
      <div class="reader-article-header">
        <h1 class="reader-title">{title}</h1>
        <div class="reader-meta">
          {#if faviconUrl}
            <img src={faviconUrl} alt="" class="reader-favicon" />
          {/if}
          {#if feedTitle}
            <a href="/?feed={sub?.id}" class="reader-feed">{feedTitle}</a>
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
        <div class="reader-body" bind:this={readerBodyEl} use:bskyEmbed>
          {@html sanitizedContent}
        </div>
      </div>

      <!-- End-of-article Discussion: a quiet separator, then sharing (a Share
           button that becomes the note box once shared, like the feed card) and
           the discussion lanes. Sits in the reading flow — finish the piece, the
           conversation is right there. -->
      <section class="reader-discussion" aria-label="Discussion">
        <div class="reader-discussion-divider"></div>
        {#if !sharedNow && canShareLinkblog}
          <button type="button" class="reader-share-cta" onclick={() => void shareNow()}>
            <Icon name="share" size={16} />
            <span>Share to your linkblog</span>
          </button>
        {/if}
        <AtmospherePanel
          laneRow={atmosphere.laneRow}
          expandedLane={atmosphere.expandedLane}
          expandedLaneItems={atmosphere.expandedLaneItems}
          currentlyShared={sharedNow}
          currentNote={currentShareNote}
          lanesOpen={true}
          panelId="reader-discussion-panel"
          onToggleLane={atmosphere.toggleLane}
          onCreateInLane={createInLane}
          onApplyComment={applyShareNote}
          onOpenAuthor={openAuthor}
        >
          {#snippet leadExtra()}
            <button type="button" class="discussion-remove" onclick={() => void removeShare()}>
              <Icon name="trash" size={14} />
              <span>Remove from your linkblog</span>
            </button>
          {/snippet}
        </AtmospherePanel>
      </section>
    </article>
  </div>
</div>

{#if highlightsHook.popoverState}
  <HighlightPopover
    mode={highlightsHook.popoverState.mode}
    anchorRect={highlightsHook.popoverState.anchorRect}
    onHighlight={highlightsHook.createHighlightFromPopover}
    onHighlightToMargin={highlightsHook.createHighlightFromPopoverToMargin}
    onRemove={highlightsHook.removeHighlightFromPopover}
    onSaveToMargin={highlightsHook.savePopoverHighlightToMargin}
    onSaveNote={highlightsHook.saveNoteFromPopover}
    existingNote={highlightsHook.popoverHighlightNote}
    marginSaved={highlightsHook.popoverHighlightSavedToMargin}
    onClose={highlightsHook.closePopover}
  />
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

  /* A flat, solid header bar pinned to the top of the overlay. It spans the full
     width and re-centers its controls in an 800px band — identical geometry to
     the feed header (.feed-header-fixed / .feed-header-controls) so the chrome
     doesn't shift when opening the reader. Flat-by-default: one 1px divider, no
     blur, no shadow. */
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
  }

  /* The divider spans only the 800px control band, centered — matching the feed
     header. Scroll-aware: hidden at the top (the bar blends into the page) and
     fades in once content scrolls underneath. */
  .reader-header::after {
    content: '';
    position: absolute;
    inset-inline: 0;
    bottom: 0;
    margin-inline: auto;
    max-width: 800px;
    height: 1px;
    background: var(--color-border);
    opacity: 0;
    transition: opacity 0.2s ease;
  }

  .reader-header.scrolled::after {
    opacity: 1;
  }

  @media (prefers-reduced-motion: reduce) {
    .reader-header::after {
      transition: none;
    }
  }

  .reader-header-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    /* width:100% is load-bearing: as a flex item in the column-flex header, the
       `margin: 0 auto` centering would otherwise disable stretch and shrink the
       bar to its content width, collapsing space-between (Back + actions bunch
       together). An explicit width gives it the full 800px to spread across. */
    width: 100%;
    max-width: 800px;
    margin: 0 auto;
    padding: 0.625rem 1rem;
  }

  .reader-actions-left,
  .reader-actions-right {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: 0.5rem;
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

  /* Mobile bottom bar */
  .reader-bottom-bar {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem 1rem;
    padding-bottom: calc(0.75rem + env(safe-area-inset-bottom, 0px));
    z-index: 10;
    pointer-events: none;
    transition:
      transform 0.25s ease,
      opacity 0.25s ease;
  }

  .reader-bottom-bar.hidden {
    transform: translateY(100%);
    opacity: 0;
    pointer-events: none;
  }

  .bottom-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.85);
    backdrop-filter: blur(8px);
    border: none;
    padding: 0.7rem;
    border-radius: 999px;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
    color: var(--color-text-secondary);
    pointer-events: auto;
    cursor: pointer;
    transition: color 0.15s;
  }

  .bottom-btn:active,
  .bottom-btn.active {
    color: var(--color-primary, #0066cc);
  }

  .bottom-bar-right {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    background: rgba(255, 255, 255, 0.85);
    backdrop-filter: blur(8px);
    border-radius: 999px;
    padding: 0.25rem 0.5rem;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
    pointer-events: auto;
  }

  .bottom-bar-right .bottom-btn {
    background: none;
    backdrop-filter: none;
    box-shadow: none;
    padding: 0.6rem;
  }

  .bottom-separator {
    width: 1px;
    height: 1.25rem;
    background: var(--color-border, #e0e0e0);
    opacity: 0.5;
  }

  /* Desktop/mobile visibility */
  .mobile-only {
    display: none;
  }

  .desktop-only {
    display: flex;
  }

  @media (max-width: 1000px) {
    .mobile-only {
      display: flex;
    }

    .desktop-only {
      display: none !important;
    }
  }

  /* Inline style row: a flat extension of the header bar, right-aligned beneath
     the controls within the same 800px band. No floating pill — it sits in
     normal flow and pushes the article down (closes on click-outside). */
  .reader-style-row {
    display: flex;
    justify-content: flex-end;
    max-width: 800px;
    margin: 0 auto;
    width: 100%;
    padding: 0 1rem 0.625rem;
  }

  .style-toolbar {
    display: flex;
    align-items: center;
    gap: 0.125rem;
  }

  .toolbar-group {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .group-label {
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wide);
    padding-left: 0.375rem;
    white-space: nowrap;
  }

  .toolbar-divider {
    width: 1px;
    height: 1rem;
    background: var(--color-border, #e0e0e0);
    margin: 0 0.25rem;
    opacity: 0.5;
  }

  .segment-group {
    display: flex;
    gap: 1px;
  }

  .segment-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    padding: 0.35rem 0.5rem;
    cursor: pointer;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    border-radius: 6px;
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }

  .segment-btn.active {
    background: var(--color-bg-secondary, #f5f5f5);
    color: var(--color-text);
  }

  .segment-btn:hover:not(.active) {
    color: var(--color-text);
  }

  .font-preview {
    font-size: var(--text-md);
    line-height: var(--leading-none);
    /* Normalize visual size across families by x-height — see
       AppearanceToolbar; keeps the four preview buttons equal height. */
    font-size-adjust: 0.52;
  }

  .size-controls {
    display: flex;
    align-items: center;
    gap: 0.125rem;
  }

  .size-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    padding: 0.3rem;
    border-radius: 6px;
    cursor: pointer;
    color: var(--color-text-secondary);
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }

  .size-btn:hover:not(:disabled) {
    color: var(--color-text);
    background: var(--color-bg-secondary, #f5f5f5);
  }

  .size-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .size-label {
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    color: var(--color-text);
    min-width: 1.25rem;
    text-align: center;
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

  .reader-body :global(img) {
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

  @media (prefers-color-scheme: dark) {
    .toolbar-divider {
      background: rgba(255, 255, 255, 0.2);
    }

    .segment-btn.active {
      background: rgba(255, 255, 255, 0.15);
    }

    .size-btn:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.1);
    }
  }

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

  .style-sheet-content .toolbar-wrapper :global(.segment-btn) {
    padding: 0.6rem 0.75rem;
  }

  .style-sheet-content .toolbar-wrapper :global(.font-preview) {
    font-size: var(--text-xl);
  }

  .style-sheet-content .toolbar-wrapper :global(.size-btn) {
    padding: 0.6rem;
  }

  .style-sheet-content .toolbar-wrapper :global(.size-btn .icon) {
    width: 18px;
    height: 18px;
  }

  .style-sheet-content .toolbar-wrapper :global(.size-label) {
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

    /* The share note box sits at the very end of the scroll content, where the
       fixed bottom nav (and the on-screen keyboard) would otherwise cover it.
       While it's focused, add a tall overscroll cushion beneath it so it can be
       scrolled clear of both. */
    .reader-discussion:has(:global(textarea:focus)) {
      padding-bottom: calc(50vh + env(safe-area-inset-bottom, 0px));
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
    .bottom-btn {
      background: rgba(40, 40, 40, 0.95);
    }

    .bottom-bar-right {
      background: rgba(40, 40, 40, 0.95);
    }

    .bottom-bar-right .bottom-btn {
      background: none;
    }

    .sheet-action-btn:active {
      background: rgba(255, 255, 255, 0.1);
    }
  }

  /* End-of-article Discussion section — in the reading flow, not chrome. */
  .reader-discussion {
    margin-top: 2.5rem;
  }

  /* A quiet full-width rule marking the end of the article. */
  .reader-discussion-divider {
    height: 1px;
    background: var(--color-border, #e8e8e8);
    margin-bottom: 1.25rem;
  }

  /* The primary Share affordance: a calm outline button that gives way to the
     note box once shared (the box then owns editing). One Blue on hover. */
  .reader-share-cta {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.875rem;
    background: none;
    border: 1px solid var(--color-border, #e0e0e0);
    border-radius: 8px;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    color: var(--color-text);
    cursor: pointer;
    transition:
      color 0.15s ease,
      border-color 0.15s ease,
      background-color 0.15s ease;
  }

  .reader-share-cta :global(.icon) {
    color: var(--color-text-secondary);
    transition: color 0.15s ease;
  }

  .reader-share-cta:hover {
    border-color: var(--color-primary, #0066cc);
    color: var(--color-primary, #0066cc);
  }

  .reader-share-cta:hover :global(.icon) {
    color: var(--color-primary, #0066cc);
  }

  /* Remove control: quiet by default, danger on hover — removal deletes a PDS
     record, so it reads as deliberate without shouting. */
  .discussion-remove {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    margin-top: 0.75rem;
    padding: 0.375rem 0.625rem;
    background: none;
    border: 1px solid var(--color-border, #e0e0e0);
    border-radius: 6px;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-text-secondary);
    cursor: pointer;
    transition:
      color 0.15s ease,
      border-color 0.15s ease,
      background-color 0.15s ease;
  }

  .discussion-remove:hover {
    color: var(--color-error, #f44336);
    border-color: var(--color-error, #f44336);
  }
</style>
