<script lang="ts">
  import type {
    Article,
    SocialShare,
    SocialDocument,
    BlueskyProfile,
    LeafletContent,
    PcktBlogContent,
    OffprintContent,
    GreengaleContent,
  } from '$lib/types';
  import { formatRelativeDate } from '$lib/utils/date';
  import { getFaviconUrl } from '$lib/utils/favicon';
  import { sanitizeHtml } from '$lib/utils/sanitize';
  import { isLeafletContent, renderLeafletContent } from '$lib/utils/leaflet-renderer';
  import { isPcktBlogContent, renderPcktBlogContent } from '$lib/utils/pckt-blog-renderer';
  import { isOffprintContent, renderOffprintContent } from '$lib/utils/offprint-renderer';
  import { isGreengaleContent, renderGreengaleContent } from '$lib/utils/greengale-renderer';
  import { getExternalArticleLink, getLinkPostNote } from '$lib/utils/linkPost';
  import { linkPostContentStore } from '$lib/stores/linkPostContent.svelte';
  import { linkblogStore } from '$lib/stores/linkblog.svelte';
  import { socialContextStore } from '$lib/stores/socialContext.svelte';
  import { bskyEmbed } from '$lib/actions/bsky-embed';
  import { profileService } from '$lib/services/profiles';
  import { sharesStore } from '$lib/stores/shares.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import Icon from './Icon.svelte';
  import TagMenu from '$lib/components/feed/TagMenu.svelte';
  import ShareCommentBox from '$lib/components/feed/ShareCommentBox.svelte';
  import LinkContextMenu from '$lib/components/feed/LinkContextMenu.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { feedViewStore } from '$lib/stores/feedView.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { useParagraphTracking } from '$lib/hooks/useParagraphTracking.svelte';
  import { useLinkInterception } from '$lib/hooks/useLinkInterception.svelte';
  import { useHighlights } from '$lib/hooks/useHighlights.svelte';
  import HighlightPopover from '$lib/components/feed/HighlightPopover.svelte';
  import type { ItemTags, ItemLabelType } from '$lib/types';
  import { tick } from 'svelte';
  import logo from '$lib/assets/logo.svg';

  let {
    article,
    share,
    document,
    localArticle,
    siteUrl,
    feedTitle,
    feedId,
    isRead = false,
    isSaved = false,
    isShared = false,
    shareNote,
    reshareCount = 0,
    isFetching = false,
    selected = false,
    expanded = false,
    highlighted = false,
    onToggleSave,
    onToggleRead,
    onShare,
    onUnshare,
    onReshare,
    onSelect,
    onExpand,
    onFetchContent,
    onOpenFullscreen,
    onSaveToSemble,
    onSaveToMargin,
  }: {
    article?: Article;
    share?: SocialShare;
    document?: SocialDocument;
    localArticle?: Article;
    siteUrl?: string;
    feedTitle?: string;
    feedId?: number;
    isRead?: boolean;
    isSaved?: boolean;
    isShared?: boolean;
    shareNote?: string;
    reshareCount?: number;
    isFetching?: boolean;
    selected?: boolean;
    expanded?: boolean;
    highlighted?: boolean;
    onToggleSave?: () => void;
    onToggleRead?: () => void;
    onShare?: (note?: string) => void;
    onUnshare?: () => void;
    onReshare?: () => void;
    onSelect?: () => void;
    onExpand?: () => void;
    onFetchContent?: () => void;
    onOpenFullscreen?: () => void;
    onSaveToSemble?: () => void;
    onSaveToMargin?: () => void;
  } = $props();

  // Determine if we're in share mode (showing someone else's share)
  let isShareMode = $derived(Boolean(share && !article && !document));
  // Determine if we're in document mode (showing someone's published document)
  let isDocumentMode = $derived(Boolean(document && !article && !share));
  // The external article a document points at, if it's a "link post" (Phase 2).
  let linkPostUrl = $derived(document ? getExternalArticleLink(document) : undefined);
  // Link-post mode: a document whose primary content is an EXTERNAL article. The
  // card inverts — the external article is the thing you read; the linkblog entry
  // is the byline.
  let isLinkPostMode = $derived(isDocumentMode && Boolean(linkPostUrl));

  // Can the user follow this source? (not already subscribed)
  let canFollowSource = $derived.by(() => {
    if (!auth.user) return false;
    // For shares/documents from another person, check if we follow that person's shares
    if (isShareMode && share?.authorDid && share.authorDid !== auth.user.did) {
      return !subscriptionsStore.subscriptions.some(
        (s) => s.sourceType === 'atproto.shares' && s.subjectDid === share!.authorDid
      );
    }
    if (isDocumentMode && document?.authorDid && document.authorDid !== auth.user.did) {
      return !subscriptionsStore.subscriptions.some(
        (s) => s.sourceType === 'atproto.documents' && s.subjectDid === document!.authorDid
      );
    }
    return false;
  });

  function handleFollowSource() {
    overflowMenuOpen = false;
    if ((isShareMode && share?.authorDid) || (isDocumentMode && document?.authorDid)) {
      const did = share?.authorDid || document?.authorDid || '';
      sidebarStore.openAddFeedModalForDid(did);
    }
  }

  // Normalize data for article, share, and document modes. For a link post the
  // external article is what we open/link to — not the linkblog permalink.
  let itemUrl = $derived(
    article?.url || share?.itemUrl || linkPostUrl || document?.canonicalUrl || document?.path || ''
  );
  let itemTitle = $derived(article?.title || share?.itemTitle || document?.title || itemUrl);
  let itemPublishedAt = $derived(
    article?.publishedAt ||
      share?.itemPublishedAt ||
      share?.createdAt ||
      document?.publishedAt ||
      ''
  );
  let itemGuid = $derived(article?.guid || share?.itemGuid || document?.recordUri || itemUrl);
  let displaySiteUrl = $derived(siteUrl || share?.feedUrl || document?.siteUri || itemUrl);

  // Derive a publication name for shares/documents when feedTitle isn't provided
  let displayFeedTitle = $derived.by(() => {
    if (feedTitle) return feedTitle;
    // For shares, extract hostname from feedUrl or itemUrl
    if (isShareMode) {
      const url = share?.feedUrl || share?.itemUrl;
      if (url) {
        try {
          return new URL(url).hostname.replace(/^www\./, '');
        } catch {
          return undefined;
        }
      }
    }
    // For documents, extract hostname from the external article (link posts) or
    // the canonicalUrl (fall back to siteUri).
    if (isDocumentMode) {
      const url = linkPostUrl || document?.canonicalUrl || document?.siteUri;
      if (url) {
        try {
          return new URL(url).hostname.replace(/^www\./, '');
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  });

  // Escape a plaintext note before embedding it in the rendered HTML lead. (The
  // whole displayContent is later run through sanitizeHtml, but the note is raw
  // user text, so escape it so `<`/`&` show literally.)
  function escapeNoteHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Content handling - article has priority, then share content, then localArticle, then document
  let displayContent = $derived.by(() => {
    // Link post: once the external article has been fetched, render the user's
    // note as a lead, then the full article. Until then, fall through to the
    // leaflet preview (note + website card) below.
    if (isLinkPostMode && linkPostUrl && document) {
      const fetched = linkPostContentStore.get(linkPostUrl);
      if (fetched?.content) {
        const note = getLinkPostNote(document);
        const lead = note
          ? `<blockquote class="link-post-note" style="margin: 0 0 1.25em; padding-left: 0.875em; border-left: 3px solid var(--color-primary, #0066cc); color: var(--color-text-secondary, #666); font-style: italic">${escapeNoteHtml(note)}</blockquote>`
          : '';
        return lead + fetched.content;
      }
    }

    // For articles and shares, use existing logic
    if (article?.content) return article.content;
    if (article?.summary) return article.summary;
    if (share?.content) return share.content;
    if (localArticle?.content) return localArticle.content;
    if (localArticle?.summary) return localArticle.summary;
    if (share?.itemDescription) return share.itemDescription;

    // For documents with structured Leaflet content, render it
    if (document?.content && isLeafletContent(document.content)) {
      return renderLeafletContent(document.content as LeafletContent, document.authorDid);
    }

    // For documents with structured pckt.blog content, render it
    if (document?.content && isPcktBlogContent(document.content)) {
      return renderPcktBlogContent(document.content as PcktBlogContent, document.authorDid);
    }

    // For documents with structured Offprint content, render it
    if (document?.content && isOffprintContent(document.content)) {
      return renderOffprintContent(document.content as OffprintContent, document.authorDid);
    }

    // For documents with structured Greengale content, render it
    if (document?.content && isGreengaleContent(document.content)) {
      return renderGreengaleContent(document.content as GreengaleContent, document.authorDid);
    }

    // Fall back to flat text content or description
    if (document?.textContent) return document.textContent;
    if (document?.description) return document.description;

    return '';
  });

  // Profile fetching for share mode and document mode
  let authorProfile = $state<BlueskyProfile | null>(null);
  $effect(() => {
    const authorDid = share?.authorDid || document?.authorDid;
    if (authorDid) {
      profileService.getProfile(authorDid).then((p) => {
        authorProfile = p;
      });
    }
  });
  let authorHandle = $derived(authorProfile?.handle || share?.authorDid || document?.authorDid);

  // Reshare state for share mode
  let isResharing = $state(false);
  let hasReshared = $derived.by(() => {
    if (!isShareMode) return false;
    const guid = itemGuid;
    return sharesStore.isShared(guid);
  });

  // Share state for document mode
  let isSharingDocument = $state(false);
  let hasSharedDocument = $derived.by(() => {
    if (!isDocumentMode || !document) return false;
    return sharesStore.isShared(document.recordUri);
  });

  // Get reshare count from share if in share mode
  let displayReshareCount = $derived(share?.reshareCount || reshareCount);

  // Reshare someone else's share (share mode) — creates your own share record.
  async function doReshare() {
    if (isResharing || hasReshared || !share || !auth.user) return;
    isResharing = true;
    try {
      await sharesStore.reshare(
        share.recordUri,
        share.authorDid,
        share.itemUrl,
        share.itemGuid,
        share.itemTitle,
        undefined,
        share.itemDescription,
        share.content,
        share.itemImage,
        share.itemPublishedAt,
        share.feedUrl
      );
    } finally {
      isResharing = false;
    }
  }

  // Share a (non-link-post) document — reuses the reshare record, with the
  // document recordUri as reshareOf.
  async function doShareDocument() {
    if (isSharingDocument || hasSharedDocument || !document || !auth.user) return;
    isSharingDocument = true;
    try {
      await sharesStore.reshare(
        document.recordUri, // reshareOfUri
        document.authorDid, // reshareOfAuthorDid
        document.canonicalUrl || document.path || '', // articleUrl
        document.recordUri, // articleGuid (use recordUri for dedup)
        document.title, // articleTitle
        undefined, // articleAuthor (resolve from DID elsewhere)
        document.description, // articleDescription
        displayContent, // articleContent (rendered HTML)
        document.coverImageCid
          ? `https://cdn.bsky.app/img/feed_fullsize/plain/${document.authorDid}/${document.coverImageCid}@jpeg`
          : undefined, // articleImage
        document.publishedAt, // articlePublishedAt
        document.siteUri // feedUrl
      );
    } finally {
      isSharingDocument = false;
    }
  }

  function handleHeaderClick() {
    const wasSelected = selected;
    onSelect?.();
    // Note: onRead is NOT called here - selectArticle in +page.svelte handles marking as read
    // For shares and link posts, fetch the full external article when first selecting
    if ((isShareMode || isLinkPostMode) && !wasSelected && onFetchContent) {
      onFetchContent();
    }
    // Lazily pull Constellation social context for a link post (adornment only).
    if (isLinkPostMode && document && !wasSelected) {
      socialContextStore.fetch({
        docUri: document.recordUri,
        articleUrl: linkPostUrl,
        excludeDid: document.authorDid,
      });
    }
  }

  function handleExpandClick(e: MouseEvent) {
    e.stopPropagation();
    onExpand?.();
  }

  function handleContentClick(e: MouseEvent) {
    // Link clicks are handled by useLinkInterception when expanded
    if ((e.target as HTMLElement).closest('a')) return;
    if ((e.target as HTMLElement).closest('video, audio, iframe')) return;
    e.stopPropagation();

    if (expanded) {
      // Already expanded, don't close on tap (use button instead)
      return;
    }

    if (selected && !expanded && isTruncated) {
      // Content is truncated, expand it (this also selects)
      onExpand?.();
    } else {
      // Not truncated, just select
      onSelect?.();
    }
  }

  function handleSaveClick(e: MouseEvent) {
    e.stopPropagation();
    onToggleSave?.();
  }

  // Sharing is a one-tap action: the share fires immediately (note-less), and an
  // inline comment box lives in the card for as long as the item is shared, so
  // commentary can be added or edited any time. Toggling the Share button off
  // unshares (and removes the box). The unified logic lives below, after the
  // per-mode primitives it depends on.

  // ── Link-post boost / quote (Phase 3) ──────────────────────────────────────
  let isBoosting = $state(false);
  let isBoosted = $derived(
    isLinkPostMode && document ? linkblogStore.isBoosted(document.recordUri) : false
  );
  // A quote is just an entry in your own linkblog for this article.
  let isQuoted = $derived(
    isLinkPostMode && linkPostUrl ? linkblogStore.isShared(linkPostUrl) : false
  );
  let socialContext = $derived(
    isLinkPostMode && document ? socialContextStore.get(document.recordUri) : undefined
  );
  // Other linkers, minus this post's own author (already shown in the byline).
  let alsoLinkedBy = $derived(
    (socialContext?.alsoLinkedBy ?? []).filter((e) => e.did !== document?.authorDid)
  );

  async function handleBoost() {
    if (!document || isBoosting || isBoosted) return;
    isBoosting = true;
    try {
      await linkblogStore.boost(document.recordUri);
    } finally {
      isBoosting = false;
    }
  }

  async function handleQuote(note: string) {
    if (!document || !linkPostUrl) return;
    const article: Article = {
      subscriptionId: 0,
      guid: linkPostUrl,
      url: linkPostUrl,
      title: itemTitle,
      author: undefined,
      summary: document.description,
      imageUrl: document.coverImageCid
        ? `https://cdn.bsky.app/img/feed_fullsize/plain/${document.authorDid}/${document.coverImageCid}@jpeg`
        : undefined,
      publishedAt: document.publishedAt,
      fetchedAt: Date.now(),
    };
    await linkblogStore.shareLink(article, note, document.recordUri);
  }

  // ── Unified share + comment + remove (all surfaces) ─────────────────────────
  // Every share button now shares instantly and opens the comment box. Already
  // shared? The button reopens the box to edit the note. Each mode maps onto its
  // own record: plain articles + quotes are linkblog documents; reshares and
  // shared documents are app.skyreader.social.share records; a bare link-post
  // share is a boost that a comment upgrades into a quote.

  let shareBusy = $derived(isResharing || isBoosting || isSharingDocument);

  let currentlyShared = $derived.by(() => {
    if (isShareMode) return hasReshared;
    if (isLinkPostMode) return isQuoted || isBoosted;
    if (isDocumentMode) return hasSharedDocument;
    return isShared;
  });

  let currentNote = $derived.by(() => {
    if (isShareMode) return sharesStore.getShareNote(itemGuid);
    if (isLinkPostMode) return isQuoted && linkPostUrl ? linkblogStore.getNote(linkPostUrl) : '';
    if (isDocumentMode && document) return sharesStore.getShareNote(document.recordUri);
    return shareNote;
  });

  let shareLabel = $derived.by(() => {
    if (shareBusy) return '…';
    if (!currentlyShared) return 'Share';
    if (isShareMode) return 'Reshared';
    if (isLinkPostMode) return isQuoted ? 'Quoted' : 'Boosted';
    return 'Shared';
  });

  // Social-graph shares (reshare/link-post/document) require sign-in; a plain
  // article share is gated by whether the page wired up onShare.
  let showShareAction = $derived(
    isShareMode || isLinkPostMode || isDocumentMode ? Boolean(auth.user) : true
  );

  let defaultShareCount = $derived(
    !isShareMode && !isLinkPostMode && !isDocumentMode && currentlyShared && displayReshareCount > 0
      ? displayReshareCount
      : 0
  );

  // Fire the note-less share for the current mode.
  async function shareNow() {
    if (isShareMode) return doReshare();
    if (isLinkPostMode) return handleBoost();
    if (isDocumentMode) return doShareDocument();
    onShare?.(undefined);
  }

  // Share button is a toggle: share when new (the comment box then appears),
  // unshare when already shared (the box goes away with it).
  function handleShareClick(e: MouseEvent) {
    e.stopPropagation();
    if (shareBusy) return;
    if (currentlyShared) removeShare();
    else shareNow();
  }

  // Attach/update the note for the current mode. On a bare link-post boost, a
  // non-empty comment upgrades it into a quote (crediting the original post).
  // The box stays visible after saving — it's persistent while shared.
  async function applyComment(note: string) {
    if (isShareMode) {
      sharesStore.setNote(itemGuid, note);
    } else if (isLinkPostMode) {
      if (isQuoted && linkPostUrl) {
        linkblogStore.setNote(linkPostUrl, note);
      } else if (note) {
        // Boost → quote: drop the bare recommend, write a linkblog quote instead.
        if (isBoosted && document) await linkblogStore.unboost(document.recordUri);
        await handleQuote(note);
      }
    } else if (isDocumentMode && document) {
      sharesStore.setNote(document.recordUri, note);
    } else {
      linkblogStore.setNote(itemUrl, note);
    }
  }

  // Remove the share entirely (toggling the Share button off).
  async function removeShare() {
    if (isShareMode) {
      await sharesStore.unshare(itemGuid);
    } else if (isLinkPostMode) {
      if (isQuoted && linkPostUrl) await linkblogStore.unshare(linkPostUrl);
      else if (isBoosted && document) await linkblogStore.unboost(document.recordUri);
    } else if (isDocumentMode && document) {
      await sharesStore.unshare(document.recordUri);
    } else {
      onUnshare?.();
    }
  }

  function handleToggleRead(e: MouseEvent) {
    e.stopPropagation();
    onToggleRead?.();
  }

  function handleOpenUrl(e: MouseEvent) {
    e.stopPropagation();
    window.open(itemUrl, '_blank', 'noopener');
  }

  let isOpen = $derived(selected || expanded);
  let hasContent = $derived(Boolean(displayContent));
  let sanitizedContent = $derived(sanitizeHtml(displayContent, itemUrl));

  // Estimate read time from content (~200 words/min)
  let readTimeMinutes = $derived.by(() => {
    const content = displayContent;
    if (!content) return 0;
    const text = content.replace(/<[^>]*>/g, '');
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(wordCount / 200));
  });

  // Compute favicon URL - for shares of documents, feedUrl may be an AT Protocol URI
  // which getFaviconUrl can't handle, so fall back to itemUrl
  let faviconUrl = $derived.by(() => {
    // Link posts show the external article's favicon, not the publication icon.
    if (linkPostUrl) return getFaviconUrl(linkPostUrl);
    if (document?.siteIcon) return document.siteIcon;
    if (document?.canonicalUrl) return getFaviconUrl(document.canonicalUrl);
    // For shares, check if feedUrl is an AT Protocol URI
    if (share?.feedUrl?.startsWith('at://')) {
      // Use itemUrl for favicon instead
      return getFaviconUrl(share.itemUrl);
    }
    if (displaySiteUrl) return getFaviconUrl(displaySiteUrl);
    return '';
  });

  let bodyEl = $state<HTMLElement | undefined>(undefined);
  let isTruncated = $state(false);

  $effect(() => {
    if (selected && !expanded && bodyEl) {
      // Check if content overflows the line clamp
      isTruncated = bodyEl.scrollHeight > bodyEl.clientHeight;
    }
  });

  // Tag menu state
  let tagMenuOpenLocal = $state(false);
  let tagBtnRef = $state<HTMLButtonElement | null>(null);

  // Overflow menu state
  let overflowMenuOpen = $state(false);

  function handleOverflowClick(e: MouseEvent) {
    e.stopPropagation();
    overflowMenuOpen = !overflowMenuOpen;
  }

  function handleOverflowOpenUrl(e: MouseEvent) {
    e.stopPropagation();
    overflowMenuOpen = false;
    window.open(itemUrl, '_blank', 'noopener');
  }

  let overflowTriggerRef = $state<HTMLButtonElement | null>(null);

  // Sticky detection: track whether the action bar is floating (stuck) vs at its natural position
  let actionBarSentinelRef = $state<HTMLDivElement | null>(null);
  let isActionBarFloating = $state(false);

  $effect(() => {
    if (!expanded || !actionBarSentinelRef) {
      isActionBarFloating = false;
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        // When the sentinel is visible, the action bar is at its natural position (not floating)
        isActionBarFloating = !entry.isIntersecting;
      },
      { threshold: 0 }
    );
    observer.observe(actionBarSentinelRef);
    return () => observer.disconnect();
  });

  function handleOverflowTag(e: MouseEvent) {
    e.stopPropagation();
    overflowMenuOpen = false;
    // Use overflow trigger as anchor since inline tag button may be hidden
    tagBtnRef = overflowTriggerRef;
    tagMenuOpenLocal = !tagMenuOpenLocal;
    if (feedViewStore.tagMenuItemKey === itemGuid) {
      feedViewStore.closeTagMenu();
    }
  }

  // Tag menu can be opened via button click or keyboard shortcut (via feedViewStore)
  let tagMenuOpen = $derived(tagMenuOpenLocal || feedViewStore.tagMenuItemKey === itemGuid);

  let itemTagType = $derived.by((): ItemTags['itemType'] => {
    if (isShareMode) return 'share';
    if (isDocumentMode) return 'document';
    return 'article';
  });

  let itemTagCount = $derived(itemLabelsStore.getTagsForItem(itemGuid).length);

  // Paragraph tracking for read progress
  const paragraphTracking = useParagraphTracking({
    contentEl: () => bodyEl,
    scrollRoot: () => null, // ArticleCard scrolls on window (null = viewport)
    itemKey: () => itemGuid,
    itemType: () => itemTagType as ItemLabelType,
    enabled: () => expanded && hasContent,
  });

  // Link interception for showing context menu on link clicks
  const linkInterception = useLinkInterception({
    contentEl: () => bodyEl,
    enabled: () => true,
  });

  // Highlights hook
  const highlights = useHighlights({
    contentEl: () => bodyEl,
    itemKey: () => itemGuid,
    itemType: () => itemTagType as ItemLabelType,
    enabled: () => expanded && hasContent,
  });

  // Attach link interception when content is visible
  $effect(() => {
    if (isOpen && bodyEl && hasContent) {
      tick().then(() => {
        linkInterception.attach();
      });
    }
    return () => {
      linkInterception.detach();
    };
  });

  // Attach highlights when article is expanded (must read `expanded` synchronously
  // so Svelte's $effect tracks it — reads inside tick().then() are not tracked)
  $effect(() => {
    if (expanded && bodyEl && hasContent) {
      tick().then(() => {
        highlights.attach();
      });
    }
    return () => {
      highlights.detach();
    };
  });

  // Set up observer when article is expanded
  $effect(() => {
    if (expanded && bodyEl && hasContent) {
      // Wait for content to render
      tick().then(() => {
        paragraphTracking.setupObserver();
        // Restore reading position after a brief delay for layout
        setTimeout(() => paragraphTracking.restorePosition(), 100);
      });
    }
    return () => {
      paragraphTracking.cleanup();
    };
  });

  // Handle paragraph navigation keys when expanded
  function handleParagraphKeydown(e: KeyboardEvent) {
    if (!expanded || paragraphTracking.totalParagraphs <= 1) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      paragraphTracking.nextParagraph();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      paragraphTracking.prevParagraph();
    } else if (e.key === 'h') {
      e.preventDefault();
      highlights.toggleParagraphHighlight(paragraphTracking.currentParagraphIndex);
    }
  }

  function handleTagClick(e: MouseEvent) {
    e.stopPropagation();
    tagMenuOpenLocal = !tagMenuOpenLocal;
    // Clear store-level tag menu if we're toggling
    if (feedViewStore.tagMenuItemKey === itemGuid) {
      feedViewStore.closeTagMenu();
    }
  }

  function handleSaveToSemble(e: MouseEvent) {
    e.stopPropagation();
    onSaveToSemble?.();
  }

  function handleSaveToMargin(e: MouseEvent) {
    e.stopPropagation();
    onSaveToMargin?.();
  }

  function handleOverflowSemble(e: MouseEvent) {
    e.stopPropagation();
    overflowMenuOpen = false;
    onSaveToSemble?.();
  }

  function handleOverflowMargin(e: MouseEvent) {
    e.stopPropagation();
    overflowMenuOpen = false;
    onSaveToMargin?.();
  }
</script>

<svelte:window onkeydown={handleParagraphKeydown} />

<article
  class="article-item"
  class:read={isRead}
  class:selected
  class:expanded
  class:open={isOpen}
  class:highlighted
>
  <div class="article-sticky-header">
    {#if isShareMode && share}
      <div class="share-attribution">
        <img src={logo} alt="" class="attribution-icon" />
        shared by
        <button
          class="share-author-link"
          onclick={(e) => {
            e.stopPropagation();
            sidebarStore.openAddFeedModalForDid(share.authorDid);
          }}>@{authorHandle}</button
        >
        {#if displayReshareCount > 0}
          <span class="attribution-reshare-count" title="{displayReshareCount} reshares"
            >({displayReshareCount})</span
          >
        {/if}
      </div>
    {:else if isLinkPostMode && document}
      <div class="share-attribution">
        <img src={logo} alt="" class="attribution-icon" />
        linked by
        <button
          class="share-author-link"
          onclick={(e) => {
            e.stopPropagation();
            sidebarStore.openAddFeedModalForDid(document.authorDid);
          }}>@{authorHandle}</button
        >
      </div>
    {/if}
    <div class="article-header-row">
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <span
        class="read-toggle"
        class:unread={!isRead}
        title={isRead ? 'Mark unread' : 'Mark read'}
        onclick={handleToggleRead}
        role="button"
        tabindex="-1"
      >
        <span class="read-dot"></span>
      </span>
      <button class="article-header" onclick={handleHeaderClick}>
        {#if faviconUrl}
          <img src={faviconUrl} alt="" class="favicon" />
        {/if}
        <span class="article-title">
          {#if isOpen}
            <a
              href={itemUrl}
              target="_blank"
              rel="noopener"
              class="article-title-link"
              onclick={(e) => e.stopPropagation()}>{itemTitle}</a
            >
          {:else}
            {itemTitle}
          {/if}
        </span>
        {#if displayFeedTitle}
          {#if feedId}
            <a href="/?feed={feedId}" class="feed-title-link" onclick={(e) => e.stopPropagation()}
              >{displayFeedTitle}</a
            >
          {:else}
            <span class="feed-title-label">{displayFeedTitle}</span>
          {/if}
        {/if}
        {#if readTimeMinutes > 0}
          <span class="article-read-time"
            ><Icon name="clock" size={12} /> {readTimeMinutes} min</span
          >
        {/if}
        <span class="article-date">{formatRelativeDate(itemPublishedAt)}</span>
      </button>
    </div>
  </div>

  {#if isOpen}
    <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
    <div class="article-content" onclick={handleContentClick}>
      {#if isFetching}
        <p class="article-loading">Loading article content...</p>
      {:else if hasContent}
        <div class="article-body-wrapper" class:has-fade={selected && !expanded && isTruncated}>
          <div
            bind:this={bodyEl}
            class="article-body"
            class:truncated={selected && !expanded}
            use:bskyEmbed
          >
            {@html sanitizedContent}
          </div>
        </div>
      {/if}
    </div>

    <!-- Link-post social context (Constellation): recommends, quotes, and who
         else across the Atmosphere linked this article. Adornment only — absent
         until it lazily loads, and silently absent if Constellation is down. -->
    {#if isLinkPostMode && socialContext && (socialContext.recommendCount > 0 || socialContext.quoteCount > 0 || alsoLinkedBy.length > 0)}
      <div class="link-post-context">
        {#if socialContext.recommendCount > 0 || socialContext.quoteCount > 0}
          <span class="context-stat">
            {#if socialContext.recommendCount > 0}{socialContext.recommendCount}
              {socialContext.recommendCount === 1
                ? 'recommend'
                : 'recommends'}{/if}{#if socialContext.recommendCount > 0 && socialContext.quoteCount > 0}
              ·
            {/if}{#if socialContext.quoteCount > 0}{socialContext.quoteCount}
              {socialContext.quoteCount === 1 ? 'quote' : 'quotes'}{/if}
          </span>
        {/if}
        {#if alsoLinkedBy.length > 0}
          <div class="context-also-linked">
            <span class="context-also-label">also linked by</span>
            {#each alsoLinkedBy as entry (entry.recordUri)}
              <span class="context-also-entry">
                <button
                  class="context-handle"
                  onclick={(e) => {
                    e.stopPropagation();
                    sidebarStore.openAddFeedModalForDid(entry.did);
                  }}>@{entry.handle ?? entry.did.slice(0, 16)}</button
                >{#if entry.note}<span class="context-note">“{entry.note}”</span>{/if}
              </span>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <!-- Mobile: meta line below content -->
    <div class="article-meta-mobile">
      {#if faviconUrl}
        <img src={faviconUrl} alt="" class="favicon" />
      {/if}
      {#if feedTitle}
        <a href="/?feed={feedId}" class="feed-title-link" onclick={(e) => e.stopPropagation()}
          >{feedTitle}</a
        >
      {/if}
      {#if readTimeMinutes > 0}
        <span class="article-read-time"><Icon name="clock" size={12} /> {readTimeMinutes} min</span>
      {/if}
      <span class="article-date">{formatRelativeDate(itemPublishedAt)}</span>
    </div>

    <!-- Inline share-comment composer: present for as long as the item is shared,
         sitting between the text and the controls. Add or edit the note any time. -->
    {#if currentlyShared}
      <ShareCommentBox initialNote={currentNote ?? ''} onsubmit={applyComment} />
    {/if}

    <div
      class="article-actions-container"
      class:scroll-hidden={expanded && isActionBarFloating && !feedViewStore.mobileControlsVisible}
      class:floating={isActionBarFloating}
    >
      <div class="article-actions">
        <!-- Save button -->
        <button class="action-btn" class:saved={isSaved} onclick={handleSaveClick}>
          <span class="action-icon"><Icon name="bookmark" size={16} /></span><span
            class="action-label">Save</span
          >
        </button>
        <!-- Share is a toggle: one tap shares (the comment box appears below);
             tapping again unshares. -->
        {#if showShareAction}
          <button
            class="action-btn"
            class:shared={currentlyShared}
            onclick={handleShareClick}
            disabled={shareBusy}
            aria-pressed={currentlyShared}
          >
            <span class="action-icon"><Icon name="share" size={16} /></span><span
              class="action-label"
              >{shareLabel}{#if defaultShareCount > 0}<span class="reshare-count"
                  >({defaultShareCount})</span
                >{/if}</span
            >
          </button>
        {/if}
        {#if onOpenFullscreen && hasContent}
          <button
            class="action-btn"
            onclick={(e) => {
              e.stopPropagation();
              onOpenFullscreen();
            }}
          >
            <span class="action-icon"><Icon name="maximize" size={16} /></span><span
              class="action-label">Full</span
            >
          </button>
        {/if}
        <!-- Inline open & tag — visible when there's space, hidden when narrow -->
        <button class="action-btn collapsible" onclick={handleOpenUrl}>
          <span class="action-icon"><Icon name="external-link" size={16} /></span><span
            class="action-label">Open</span
          >
        </button>
        <button
          class="action-btn collapsible"
          class:tagged={itemTagCount > 0}
          onclick={handleTagClick}
          bind:this={tagBtnRef}
        >
          <span class="action-icon"><Icon name="tag" size={16} /></span><span class="action-label"
            >Tag{#if itemTagCount > 0}<span class="tag-count">({itemTagCount})</span>{/if}</span
          >
        </button>
        {#if onSaveToSemble}
          <button class="action-btn collapsible-always" onclick={handleSaveToSemble}>
            <span class="action-icon"><Icon name="semble" size={16} /></span><span
              class="action-label">Semble</span
            >
          </button>
        {/if}
        {#if onSaveToMargin}
          <button class="action-btn collapsible-always" onclick={handleSaveToMargin}>
            <span class="action-icon"><Icon name="margin" size={16} /></span><span
              class="action-label">Margin</span
            >
          </button>
        {/if}
        <!-- Overflow menu: shown when inline buttons are collapsed -->
        <div
          class="overflow-menu-wrapper"
          class:has-integrations={onSaveToSemble || onSaveToMargin}
        >
          <button
            class="action-btn overflow-trigger"
            class:tagged={itemTagCount > 0}
            onclick={handleOverflowClick}
            bind:this={overflowTriggerRef}
          >
            <span class="action-icon"><Icon name="more-horizontal" size={16} /></span>
          </button>
          {#if overflowMenuOpen}
            <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
            <div class="overflow-backdrop" onclick={() => (overflowMenuOpen = false)}></div>
            <div class="overflow-menu">
              <button class="overflow-menu-item narrow-only" onclick={handleOverflowOpenUrl}>
                <Icon name="external-link" size={16} />
                <span>Open in browser</span>
              </button>
              <button
                class="overflow-menu-item narrow-only"
                class:tagged={itemTagCount > 0}
                onclick={handleOverflowTag}
              >
                <Icon name="tag" size={16} />
                <span
                  >Tag{#if itemTagCount > 0}
                    ({itemTagCount}){/if}</span
                >
              </button>
              {#if onSaveToSemble}
                <button class="overflow-menu-item" onclick={handleOverflowSemble}>
                  <Icon name="semble" size={16} />
                  <span>Save to Semble</span>
                </button>
              {/if}
              {#if onSaveToMargin}
                <button class="overflow-menu-item" onclick={handleOverflowMargin}>
                  <Icon name="margin" size={16} />
                  <span>Save to Margin</span>
                </button>
              {/if}
              {#if canFollowSource}
                <button class="overflow-menu-item" onclick={handleFollowSource}>
                  <Icon name="plus" size={16} />
                  <span>Follow source</span>
                </button>
              {/if}
            </div>
          {/if}
        </div>
        {#if expanded}
          <button class="action-btn show-less-btn" onclick={handleExpandClick}
            ><span class="action-icon"><Icon name="chevron-up" size={16} /></span><span
              class="action-label">Less</span
            ></button
          >
        {:else}
          <button
            class="action-btn show-more-btn"
            class:disabled={!isTruncated}
            onclick={isTruncated ? handleExpandClick : undefined}
            ><span class="action-icon"><Icon name="chevron-down" size={16} /></span><span
              class="action-label">More</span
            ></button
          >
        {/if}
      </div>
    </div>
    {#if expanded}<div class="action-bar-sentinel" bind:this={actionBarSentinelRef}></div>{/if}

    {#if tagMenuOpen}
      <TagMenu
        itemKey={itemGuid}
        itemType={itemTagType}
        anchorEl={tagBtnRef}
        onClose={() => {
          tagMenuOpenLocal = false;
          feedViewStore.closeTagMenu();
        }}
      />
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

    {#if highlights.popoverState}
      <HighlightPopover
        mode={highlights.popoverState.mode}
        anchorRect={highlights.popoverState.anchorRect}
        onHighlight={highlights.createHighlightFromPopover}
        onRemove={highlights.removeHighlightFromPopover}
        onClose={highlights.closePopover}
      />
    {/if}

    {#if itemTagCount > 0}
      <div class="tag-chips">
        {#each itemLabelsStore.getTagsForItem(itemGuid) as tag}
          <span class="tag-chip">{tag}</span>
        {/each}
      </div>
    {/if}
  {/if}
</article>

<style>
  .article-item {
    padding: 0 1rem;
  }

  .article-item:not(.selected):not(.expanded):hover {
    background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.03));
  }

  .article-item.read:not(.selected):not(.expanded) {
    opacity: 0.6;
  }

  .article-item.read:not(.selected):not(.expanded):hover {
    opacity: 0.8;
  }

  .article-item.highlighted {
    background-color: rgba(96, 165, 250, 0.05);
    border-radius: 8px;
  }

  .article-item:hover {
    background-color: rgba(128, 128, 128, 0.05);
    border-radius: 8px;
    --fade-bg: #f9f9f9;
  }

  .article-item.highlighted:hover {
    background-color: rgba(96, 165, 250, 0.08);
    --fade-bg: #f2f8ff;
  }

  .article-item.highlighted {
    --fade-bg: #f7fbff;
  }

  .article-sticky-header {
    position: relative;
  }

  .share-attribution {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.75rem;
    color: var(--color-text-secondary);
    padding: 0.25rem 0 0;
  }

  .attribution-icon {
    width: 12px;
    height: 12px;
    flex-shrink: 0;
  }

  .share-author-link {
    color: var(--color-text-secondary);
    text-decoration: none;
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-size: inherit;
    cursor: pointer;
  }

  .share-author-link:hover {
    color: var(--color-primary);
    text-decoration: underline;
  }

  .attribution-reshare-count {
    font-size: 0.7rem;
    color: var(--color-text-secondary);
    margin-left: 0.25rem;
  }

  /* Link-post social context line (Constellation). Quiet, text-first. */
  .link-post-context {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin: 0 0 0.75rem;
    padding-top: 0.625rem;
    border-top: 1px solid var(--color-border, #e8e8e8);
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
  }

  .context-stat {
    color: var(--color-text-secondary);
  }

  .context-also-linked {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.375rem;
    line-height: 1.4;
  }

  .context-also-label {
    color: var(--color-text-secondary);
  }

  .context-also-entry {
    display: inline-flex;
    align-items: baseline;
    gap: 0.3125rem;
    min-width: 0;
  }

  .context-handle {
    color: var(--color-text-secondary);
    text-decoration: none;
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    cursor: pointer;
  }

  .context-handle:hover {
    color: var(--color-primary);
    text-decoration: underline;
  }

  .context-note {
    color: var(--color-text);
    font-style: italic;
  }

  .article-header-row {
    display: flex;
    align-items: flex-start;
    gap: 2px;
  }

  .article-header {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    flex: 1;
    min-width: 0;
    padding: 0.5rem 0;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    font: inherit;
  }

  .favicon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    margin-top: 3px;
  }

  .article-title {
    flex: 1;
    font-family: var(--article-font);
    font-size: var(--article-font-size);
    font-weight: 400;
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .article-item.read .article-title {
    color: var(--color-text-secondary);
  }

  .read-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    padding: 2px 10px 2px 4px;
    cursor: pointer;
    flex-shrink: 0;
    line-height: 0;
    margin-top: calc(0.5rem + 3px);
  }

  .read-dot {
    display: block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: transparent;
    border: 1.5px solid var(--color-text-secondary);
    transition:
      background 0.15s ease,
      border-color 0.15s ease;
  }

  .read-toggle:hover .read-dot {
    border-color: var(--color-primary, #0066cc);
    opacity: 0.7;
  }

  .read-toggle.unread .read-dot {
    background: #5b9bd5;
    border-color: #5b9bd5;
  }

  .read-toggle.unread:hover .read-dot {
    opacity: 0.7;
  }

  .article-title-link {
    color: var(--color-primary, #0066cc);
    text-decoration: none;
  }

  .article-title-link:hover {
    text-decoration: underline;
  }

  .article-item.selected .article-title,
  .article-item.expanded .article-title {
    white-space: normal;
    text-overflow: unset;
  }

  .article-date {
    flex-shrink: 0;
    font-size: 0.875rem;
    color: var(--color-text-secondary);
  }

  .article-read-time {
    flex-shrink: 0;
    font-size: 0.8rem;
    color: var(--color-text-secondary);
  }

  .article-read-time :global(.icon) {
    vertical-align: -2px;
    margin-right: 0.15rem;
  }

  .feed-title-link,
  .feed-title-label {
    flex-shrink: 0;
    max-width: 12rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.8rem;
    color: var(--color-text-secondary);
    text-decoration: none;
  }

  .feed-title-link:hover {
    color: var(--color-primary);
    text-decoration: underline;
  }

  .article-content {
    padding: 0;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }

  .article-body-wrapper {
    position: relative;
  }

  .article-body-wrapper.has-fade::after {
    content: '';
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 4em;
    background: linear-gradient(to bottom, transparent, var(--fade-bg, var(--color-bg, #ffffff)));
    pointer-events: none;
  }

  @media (prefers-color-scheme: dark) {
    .article-body-wrapper.has-fade::after {
      background: linear-gradient(to bottom, transparent, var(--fade-bg, var(--color-bg, #1a1a1a)));
    }
  }

  .article-body {
    position: relative;
    font-family: var(--article-font);
    font-size: var(--article-font-size);
    line-height: 1.7;
    color: var(--color-text);
    overflow-wrap: break-word;
  }

  .article-body.truncated {
    display: -webkit-box;
    -webkit-line-clamp: 8;
    line-clamp: 8;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .article-body :global(video) {
    max-width: 100%;
    height: auto;
    border-radius: 6px;
    margin: 0.75rem 0;
    cursor: auto;
  }

  .article-body :global(iframe) {
    display: block;
    width: 100%;
    max-width: 100%;
    aspect-ratio: 16 / 9;
    height: auto;
    border: 0;
    border-radius: 6px;
    margin: 0.75rem 0;
    cursor: auto;
  }

  .article-body :global(img) {
    max-width: 100%;
    height: auto;
    border-radius: 4px;
    margin: 0.75rem 0;
  }

  .article-body :global(a) {
    color: var(--color-primary, #0066cc);
  }

  .article-body :global(pre) {
    background: var(--color-bg-secondary, #f3f4f6);
    padding: 0.75rem;
    border-radius: 4px;
    overflow-x: auto;
    font-size: 0.8rem;
  }

  .article-body :global(blockquote) {
    border-left: 3px solid var(--color-border);
    margin: 0.75rem 0;
    padding-left: 1rem;
    color: var(--color-text-secondary);
  }

  .article-body :global(p) {
    margin: 0.75rem 0;
  }

  .article-body :global(p:first-child) {
    margin-top: 0;
  }

  .article-body :global(p:last-child) {
    margin-bottom: 0;
  }

  .article-body :global(ul),
  .article-body :global(ol) {
    margin: 0.75rem 0;
    padding-left: 1.5rem;
    list-style-position: outside;
  }

  .article-body :global(li ul),
  .article-body :global(li ol) {
    padding-left: 1.5rem;
  }

  .article-body :global(li) {
    margin: 0.25rem 0;
  }

  .article-body :global(mark.highlight) {
    background-color: color-mix(in srgb, #f5c518 25%, transparent);
    border-radius: 1px;
    cursor: pointer;
    transition: background-color 0.2s ease;
  }

  .article-body :global(mark.highlight:hover) {
    background-color: color-mix(in srgb, #f5c518 40%, transparent);
  }

  .article-loading {
    font-size: 0.875rem;
    color: var(--color-text-secondary);
    margin-top: 0.5rem;
    font-style: italic;
  }

  .article-actions-container {
    display: flex;
    container-type: inline-size;
    padding: 0.25rem 0 0.5rem;
  }

  /* Inline style: flat row integrated into card bottom */
  .article-actions {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    gap: 0.75rem;
    padding: 0.375rem 0;
  }

  /* Mute controls for non-highlighted articles in expanded view (desktop only) */
  @media (min-width: 1000px) {
    .article-item.open:not(.expanded) .article-actions {
      opacity: 0.3;
    }

    .article-item.open:not(.expanded).highlighted .article-actions,
    .article-item.open:not(.expanded):hover .article-actions {
      opacity: 1;
    }
  }

  /* Expanded: sticky at bottom */
  .article-item.expanded .article-actions-container {
    position: sticky;
    bottom: 0;
    padding: 0.5rem 0;
  }

  /* Floating state: centered pill */
  .article-item.expanded .article-actions-container.floating {
    justify-content: center;
    padding: 1rem 0;
  }

  /* Sentinel element for sticky detection */
  .action-bar-sentinel {
    height: 1px;
    margin-top: -1px;
  }

  /* On mobile, float above the MobileBottomBar and hide on scroll */
  @media (max-width: 1000px) {
    .article-item.expanded .article-actions-container.floating {
      bottom: calc(3.5rem + env(safe-area-inset-bottom, 0px));
      transition:
        transform 0.3s ease,
        opacity 0.3s ease;
    }

    .article-item.expanded .article-actions-container.scroll-hidden {
      transform: translateY(100%);
      opacity: 0;
      pointer-events: none;
    }
  }

  /* Floating pill styles only when action bar is stuck */
  .article-item.expanded .article-actions-container.floating .article-actions {
    justify-content: space-between;
    width: auto;
    gap: 0.875rem;
    padding: 0.5rem 1rem;
    background: rgba(255, 255, 255, 0.85);
    backdrop-filter: blur(8px);
    border-radius: 9999px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  }

  @media (prefers-color-scheme: dark) {
    .article-item.expanded .article-actions-container.floating .article-actions {
      background: rgba(40, 40, 40, 0.95);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
    }
  }

  /* Non-floating expanded state: full-width normal bar */
  .article-item.expanded .article-actions-container:not(.floating) .article-actions {
    justify-content: space-between;
    width: 100%;
    gap: 0.75rem;
  }

  .action-btn {
    display: flex;
    align-items: center;
    white-space: nowrap;
    background: none;
    border: none;
    font-size: 0.875rem;
    color: var(--color-text-secondary);
    padding: 0.25rem 0;
    cursor: pointer;
    text-decoration: none;
  }

  .action-btn:hover {
    color: var(--color-primary, #0066cc);
  }

  .action-btn.saved {
    color: #ffc107;
  }

  .action-btn.saved:hover {
    color: #ffc107;
  }

  .action-btn.shared,
  .action-btn.active {
    color: var(--color-primary, #0066cc);
  }

  .action-btn.reshared {
    color: var(--color-success, #22c55e);
  }

  .action-btn:disabled {
    cursor: default;
    opacity: 0.7;
  }

  .reshare-count {
    font-size: 0.75rem;
    margin-left: 0.25rem;
  }

  .action-btn.show-more-btn,
  .action-btn.show-less-btn {
    color: var(--color-primary, #0066cc);
  }

  .action-btn.tagged {
    color: var(--color-primary, #0066cc);
  }

  .tag-count {
    font-size: 0.75rem;
    margin-left: 0.125rem;
  }

  .tag-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    padding: 0 0 0.5rem;
  }

  .tag-chip {
    display: inline-flex;
    align-items: center;
    padding: 0.125rem 0.5rem;
    font-size: 0.6875rem;
    font-weight: 500;
    background: rgba(37, 99, 235, 0.08);
    color: var(--color-primary, #2563eb);
    border-radius: 999px;
  }

  .action-btn.disabled {
    color: var(--color-text-secondary);
    opacity: 0.4;
    cursor: default;
  }

  /* Overflow menu */
  .overflow-menu-wrapper {
    position: relative;
  }

  .overflow-backdrop {
    position: fixed;
    inset: 0;
    z-index: 99;
  }

  .overflow-menu {
    position: absolute;
    bottom: calc(100% + 0.5rem);
    right: 0;
    z-index: 100;
    min-width: 10rem;
    background: var(--color-bg, #fff);
    border: 1px solid var(--color-border, #e5e7eb);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
    padding: 0.25rem;
    display: flex;
    flex-direction: column;
  }

  .overflow-menu-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    background: none;
    border: none;
    font: inherit;
    font-size: 0.875rem;
    color: var(--color-text);
    cursor: pointer;
    border-radius: 6px;
    white-space: nowrap;
    text-align: left;
  }

  .overflow-menu-item:hover {
    background: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
  }

  .overflow-menu-item.tagged {
    color: var(--color-primary, #0066cc);
  }

  @media (prefers-color-scheme: dark) {
    .overflow-menu {
      background: var(--color-bg, #1a1a1a);
      border-color: var(--color-border, #404040);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    }

    .overflow-menu-item:hover {
      background: var(--color-bg-hover, rgba(255, 255, 255, 0.08));
    }
  }

  @media (prefers-color-scheme: dark) {
    .article-item:not(.selected):not(.expanded):hover {
      background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
    }

    .article-item:hover {
      --fade-bg: #1f1f1f;
    }

    .article-item.highlighted {
      --fade-bg: #1e2125;
    }

    .article-item.highlighted:hover {
      --fade-bg: #20252c;
    }
  }

  .action-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .action-btn.saved .action-icon :global(.icon) {
    fill: currentColor;
  }

  .action-label {
    margin-left: 0.25rem;
    font-size: 0.875rem;
  }

  /* Always-collapsed items (integrations) — hidden inline, shown in overflow */
  .action-btn.collapsible-always {
    display: none;
  }

  /* Default: hide overflow wrapper unless integrations present */
  .overflow-menu-wrapper {
    display: none;
  }

  .overflow-menu-wrapper.has-integrations {
    display: block;
    position: relative;
  }

  /* Hide Open/Tag overflow items when their inline buttons are visible */
  .overflow-menu-item.narrow-only {
    display: none;
  }

  /* Narrow: collapse Open & Tag into overflow too */
  @container (max-width: 520px) {
    .action-btn.collapsible {
      display: none;
    }
    .overflow-menu-wrapper {
      display: block;
      position: relative;
    }
    .overflow-menu-item.narrow-only {
      display: flex;
    }
  }

  /* Very narrow: hide labels too */
  @container (max-width: 300px) {
    .action-label {
      display: none;
    }
  }

  /* Mobile meta bar — hidden by default, shown on mobile when article is open */
  .article-meta-mobile {
    display: none;
  }

  /* Mobile: two-line header — [title] on top, [icon] [feed] [date] below */
  @media (max-width: 600px) {
    .read-toggle {
      margin-top: calc(0.5rem + 5px);
    }

    .article-header {
      flex-wrap: wrap;
      gap: 0.25rem 0.5rem;
    }

    .article-title {
      order: 0;
      flex-basis: 100%;
    }

    .favicon {
      order: 1;
      margin-right: 0;
      align-self: center;
    }

    .feed-title-link,
    .feed-title-label {
      order: 2;
      flex: 0 1 auto;
      min-width: 0;
      font-size: 0.75rem;
      max-width: none;
    }

    .article-read-time {
      order: 3;
      display: inline;
      font-size: 0.75rem;
    }

    .article-read-time::before,
    .article-date::before {
      content: '·';
      margin-right: 0.35rem;
      color: var(--color-text-secondary);
    }

    .article-date {
      order: 4;
      font-size: 0.75rem;
    }

    /* When article is open, hide header meta and show mobile meta bar below content */
    .article-item.open .article-header .favicon,
    .article-item.open .article-header .feed-title-link,
    .article-item.open .article-header .article-date,
    .article-item.open .article-header .article-read-time {
      display: none;
    }

    .article-item.open .article-meta-mobile {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.25rem 0;
      font-size: 0.75rem;
      color: var(--color-text-secondary);
    }

    .article-meta-mobile .favicon {
      order: unset;
      width: 16px;
      height: 16px;
      flex-shrink: 0;
    }

    .article-meta-mobile .feed-title-link {
      order: unset;
      flex: 0 1 auto;
      min-width: 0;
      font-size: 0.75rem;
      max-width: none;
      color: var(--color-text-secondary);
      text-decoration: none;
    }

    .article-meta-mobile .article-date {
      order: unset;
      font-size: 0.75rem;
    }

    .article-meta-mobile .article-read-time {
      order: unset;
      display: inline;
      font-size: 0.75rem;
    }
  }

  /* Mobile: bigger touch targets for expanded pill */
  @media (max-width: 480px) {
    .article-item.expanded .article-actions {
      width: 100%;
      gap: 1rem;
      padding: 0.5rem 1rem;
    }

    .article-item.expanded .action-btn {
      font-size: 1.125rem;
    }

    .article-item.expanded .action-icon :global(.icon) {
      width: 20px;
      height: 20px;
    }

    .article-item.expanded .action-label {
      font-size: 0.9375rem;
    }
  }
</style>
