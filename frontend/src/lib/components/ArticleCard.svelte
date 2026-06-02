<script lang="ts">
  import type {
    Article,
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
  import { linkblogStore } from '$lib/stores/linkblog.svelte';
  import { socialContextStore } from '$lib/stores/socialContext.svelte';
  import { articleMentionsStore } from '$lib/stores/articleMentions.svelte';
  import { bskyEmbed } from '$lib/actions/bsky-embed';
  import { profileService } from '$lib/services/profiles';
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

  let {
    article,
    document,
    localArticle,
    siteUrl,
    feedTitle,
    feedId,
    isRead = false,
    isSaved = false,
    isShared = false,
    shareNote,
    selected = false,
    expanded = false,
    highlighted = false,
    onToggleSave,
    onToggleRead,
    onShare,
    onUnshare,
    onSelect,
    onExpand,
    onOpenFullscreen,
    onSaveToSemble,
    onSaveToMargin,
  }: {
    article?: Article;
    document?: SocialDocument;
    localArticle?: Article;
    siteUrl?: string;
    feedTitle?: string;
    feedId?: number;
    isRead?: boolean;
    isSaved?: boolean;
    isShared?: boolean;
    shareNote?: string;
    selected?: boolean;
    expanded?: boolean;
    highlighted?: boolean;
    onToggleSave?: () => void;
    onToggleRead?: () => void;
    onShare?: (note?: string) => void;
    onUnshare?: () => void;
    onSelect?: () => void;
    onExpand?: () => void;
    onOpenFullscreen?: () => void;
    onSaveToSemble?: () => void;
    onSaveToMargin?: () => void;
  } = $props();

  // Determine if we're in document mode (showing someone's published document)
  let isDocumentMode = $derived(Boolean(document && !article));
  // The external article a document points at, if it's a "link post" (Phase 2).
  let linkPostUrl = $derived(document ? getExternalArticleLink(document) : undefined);
  // Link-post mode: a document whose primary content is an EXTERNAL article. The
  // card inverts — the external article is the thing you read; the linkblog entry
  // is the byline.
  let isLinkPostMode = $derived(isDocumentMode && Boolean(linkPostUrl));

  // Can the user follow this source? (not already subscribed)
  let canFollowSource = $derived.by(() => {
    if (!auth.user) return false;
    // For a document from another person, check if we follow that person's documents
    if (isDocumentMode && document?.authorDid && document.authorDid !== auth.user.did) {
      return !subscriptionsStore.subscriptions.some(
        (s) => s.sourceType === 'atproto.documents' && s.subjectDid === document!.authorDid
      );
    }
    return false;
  });

  function handleFollowSource() {
    overflowMenuOpen = false;
    if (isDocumentMode && document?.authorDid) {
      sidebarStore.openAddFeedModalForDid(document.authorDid);
    }
  }

  // Normalize data for article and document modes. For a link post the
  // external article is what we open/link to — not the linkblog permalink.
  let itemUrl = $derived(
    article?.url || linkPostUrl || document?.canonicalUrl || document?.path || ''
  );
  let itemTitle = $derived(article?.title || document?.title || itemUrl);
  let itemPublishedAt = $derived(article?.publishedAt || document?.publishedAt || '');
  let itemGuid = $derived(article?.guid || document?.recordUri || itemUrl);
  let displaySiteUrl = $derived(siteUrl || document?.siteUri || itemUrl);

  // Derive a publication name for documents when feedTitle isn't provided
  let displayFeedTitle = $derived.by(() => {
    if (feedTitle) return feedTitle;
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

  // The user's commentary on a link post, rendered as plain prose (not a
  // blockquote) — it's the author's own voice, and a quote box double-quotes
  // once notes get rich formatting.
  let linkPostNote = $derived(isLinkPostMode && document ? getLinkPostNote(document) : undefined);
  // The article excerpt + thumbnail for the link-card preview.
  let linkPostExcerpt = $derived(isLinkPostMode ? document?.description : undefined);
  let linkPostThumb = $derived(
    isLinkPostMode && document?.coverImageCid
      ? `https://cdn.bsky.app/img/feed_thumbnail/plain/${document.authorDid}/${document.coverImageCid}@jpeg`
      : undefined
  );

  // Content handling - article has priority, then share content, then localArticle, then document
  let displayContent = $derived.by(() => {
    // Link posts don't inline the full article (that bounces through the
    // fullscreen reader on demand). The expanded body is rendered as explicit
    // note + link-card markup below, so there's no HTML content here.
    if (isLinkPostMode) return '';

    // For articles, use existing logic
    if (article?.content) return article.content;
    if (article?.summary) return article.summary;
    if (localArticle?.content) return localArticle.content;
    if (localArticle?.summary) return localArticle.summary;

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

  // Profile fetching for document mode
  let authorProfile = $state<BlueskyProfile | null>(null);
  $effect(() => {
    const authorDid = document?.authorDid;
    if (authorDid) {
      profileService.getProfile(authorDid).then((p) => {
        authorProfile = p;
      });
    }
  });
  let authorHandle = $derived(authorProfile?.handle || document?.authorDid);
  let authorDisplayName = $derived(
    authorProfile?.displayName || authorProfile?.handle || document?.authorDid
  );
  let authorAvatar = $derived(authorProfile?.avatar);

  function handleHeaderClick() {
    const wasSelected = selected;
    onSelect?.();
    // Note: onRead is NOT called here - selectArticle in +page.svelte handles marking as read
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

  // ── Resharing a document (Phase 7) ──────────────────────────────────────────
  // Every reshare is one shape: a site.standard.document in your own linkblog,
  // keyed by the article URL and toggled by the Share button (note optional).
  // Resharing a link post records the original doc's AT URI as a `rel: repost`
  // ref (repostUri) so the via-attribution chain survives. (The old bare
  // `recommend` boost write path was removed entirely in Phase 7.)
  let isQuoting = $state(false);
  // The URL under which this document's linkblog entry is keyed: the external
  // article for a link post, else the document's own canonical URL.
  let quoteKey = $derived(
    isDocumentMode ? linkPostUrl || document?.canonicalUrl || document?.path || '' : ''
  );
  // Whether this document already has an entry in your own linkblog.
  let isQuoted = $derived(isDocumentMode && quoteKey ? linkblogStore.isShared(quoteKey) : false);
  let socialContext = $derived(
    isLinkPostMode && document ? socialContextStore.get(document.recordUri) : undefined
  );
  // Other linkers, minus this post's own author (already shown in the byline).
  let alsoLinkedBy = $derived(
    (socialContext?.alsoLinkedBy ?? []).filter((e) => e.did !== document?.authorDid)
  );

  // ── Network-wide mentions (Phase 5) ─────────────────────────────────────────
  // For a regular article, how is it being referenced across the Atmosphere —
  // linkblog notes / Bluesky posts / margin.at highlights / Semble saves. Lazy +
  // batched (the store dedups across all cards); adornment only, hidden when
  // there's no signal. Not for documents/link posts (those use Phase 3 context).
  $effect(() => {
    if (!isDocumentMode && article?.url) articleMentionsStore.fetch(article.url);
  });
  let articleMentions = $derived(
    !isDocumentMode && article?.url ? articleMentionsStore.get(article.url) : undefined
  );
  let mentionLanes = $derived(articleMentions?.lanes ?? []);
  let leadLane = $derived(mentionLanes[0]);
  // Distinct people beyond the lead lane (union math: lead ⊆ total).
  let mentionMore = $derived(
    articleMentions && leadLane ? Math.max(0, articleMentions.total - leadLane.count) : 0
  );
  let showMentionBreakdown = $state(false);

  // Lane → Icon.svelte glyph (typed; the proxy also sends an icon hint).
  const LANE_ICON = {
    linkblog: 'standard-site',
    bluesky: 'bluesky',
    margin: 'margin',
    semble: 'semble',
  } as const;

  function mentionNoun(noun: string, count: number): string {
    return count === 1 ? noun : `${noun}s`;
  }

  // Write a linkblog entry for the current document (repostUri = the doc's AT URI,
  // so a reshared link post credits the original).
  async function handleQuote(note: string) {
    if (!document || !quoteKey) return;
    const quoteArticle: Article = {
      subscriptionId: 0,
      guid: quoteKey,
      url: quoteKey,
      title: itemTitle,
      author: undefined,
      summary: document.description,
      imageUrl: document.coverImageCid
        ? `https://cdn.bsky.app/img/feed_fullsize/plain/${document.authorDid}/${document.coverImageCid}@jpeg`
        : undefined,
      publishedAt: document.publishedAt,
      fetchedAt: Date.now(),
    };
    await linkblogStore.shareLink(quoteArticle, note, document.recordUri);
  }

  // ── Unified share + comment + remove (all surfaces) ─────────────────────────
  // Every share button shares instantly and opens the comment box. Already
  // shared? The button reopens the box to edit the note. Documents (incl. link
  // posts) become linkblog entries keyed by the article URL; plain articles go
  // through the page's onShare.

  let shareBusy = $derived(isQuoting);

  let currentlyShared = $derived.by(() => {
    if (isDocumentMode) return isQuoted;
    return isShared;
  });

  let currentNote = $derived.by(() => {
    if (isDocumentMode) return isQuoted && quoteKey ? linkblogStore.getNote(quoteKey) : '';
    return shareNote;
  });

  let shareLabel = $derived(shareBusy ? '…' : currentlyShared ? 'Shared' : 'Share');

  // Document sharing requires sign-in; a plain article share is gated by whether
  // the page wired up onShare.
  let showShareAction = $derived(isDocumentMode ? Boolean(auth.user) : true);

  // Fire the note-less share for the current mode.
  async function shareNow() {
    if (isDocumentMode) {
      isQuoting = true;
      try {
        await handleQuote('');
      } finally {
        isQuoting = false;
      }
      return;
    }
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

  // Attach/update the note. The box stays visible after saving — it's persistent
  // while shared.
  async function applyComment(note: string) {
    if (isDocumentMode) {
      if (isQuoted && quoteKey) linkblogStore.setNote(quoteKey, note);
      else await handleQuote(note);
    } else {
      linkblogStore.setNote(itemUrl, note);
    }
  }

  // Remove the share entirely (toggling the Share button off).
  async function removeShare() {
    if (isDocumentMode) {
      if (quoteKey) await linkblogStore.unshare(quoteKey);
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

  // Compute favicon URL. For documents whose siteUri is an AT Protocol URI
  // (which getFaviconUrl can't handle), fall back to the canonical/site URL.
  let faviconUrl = $derived.by(() => {
    // Link posts show the external article's favicon, not the publication icon.
    if (linkPostUrl) return getFaviconUrl(linkPostUrl);
    if (document?.siteIcon) return document.siteIcon;
    if (document?.canonicalUrl) return getFaviconUrl(document.canonicalUrl);
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
        <span class="title-line">
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
        </span>
        {#if isLinkPostMode && document}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <span
            class="via-pill"
            title="@{authorHandle}"
            onclick={(e) => {
              e.stopPropagation();
              sidebarStore.openAddFeedModalForDid(document.authorDid);
            }}
            role="button"
            tabindex="-1"
          >
            <span class="via-label">Shared by</span>
            {#if authorAvatar}
              <img src={authorAvatar} alt="" class="via-avatar" />
            {/if}
            <span class="via-name">{authorDisplayName}</span>
          </span>
        {/if}
        {#if displayFeedTitle && !isLinkPostMode}
          {#if feedId}
            <a
              href="/?feed={feedId}"
              class="feed-title-link"
              title={isDocumentMode ? 'standard.site' : 'RSS'}
              onclick={(e) => e.stopPropagation()}
              ><Icon
                name={isDocumentMode ? 'standard-site' : 'rss'}
                size={12}
              />{displayFeedTitle}</a
            >
          {:else}
            <span class="feed-title-label" title={isDocumentMode ? 'standard.site' : 'RSS'}
              ><Icon
                name={isDocumentMode ? 'standard-site' : 'rss'}
                size={12}
              />{displayFeedTitle}</span
            >
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

  <!-- Network-wide mentions (Phase 5): a quiet lead-lane line — the most
       meaningful kind of reference with its honest noun — rolling the rest into
       "+N more". Adornment only; absent until it lazily loads and silently
       absent below the signal threshold or when the lookup is unavailable. -->
  {#if leadLane}
    <div class="article-mentions" class:expanded-breakdown={showMentionBreakdown}>
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <span
        class="mentions-lead"
        class:interactive={mentionMore > 0}
        role={mentionMore > 0 ? 'button' : undefined}
        tabindex={mentionMore > 0 ? -1 : undefined}
        title={mentionMore > 0 ? 'See where this is referenced' : undefined}
        onclick={(e) => {
          if (mentionMore === 0) return;
          e.stopPropagation();
          showMentionBreakdown = !showMentionBreakdown;
        }}
      >
        <Icon name={LANE_ICON[leadLane.lane]} size={12} />
        <span class="mentions-text"
          >{leadLane.count}{leadLane.capped ? '+' : ''}
          {mentionNoun(leadLane.noun, leadLane.count)}</span
        >
        {#if mentionMore > 0}
          <span class="mentions-more">· +{mentionMore} more</span>
          <Icon name={showMentionBreakdown ? 'chevron-up' : 'chevron-down'} size={12} />
        {/if}
      </span>

      {#if showMentionBreakdown}
        <div class="mentions-breakdown">
          {#each mentionLanes as lane (lane.lane)}
            <div class="mentions-lane">
              <Icon name={LANE_ICON[lane.lane]} size={13} />
              <span class="mentions-lane-count">{lane.count}{lane.capped ? '+' : ''}</span>
              <span class="mentions-lane-label">{lane.label}</span>
              <span class="mentions-lane-verb">{lane.verb}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if isOpen}
    <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
    <div class="article-content" onclick={handleContentClick}>
      {#if isLinkPostMode}
        <!-- A link post: the author's note as prose, then the external article as
             a card. Tapping the card opens the in-app reader (which fetches the
             full article), so there's no inline loading flash here. -->
        {#if linkPostNote}
          <p class="link-post-note">{linkPostNote}</p>
        {/if}
        <button
          class="link-card"
          onclick={(e) => {
            e.stopPropagation();
            onOpenFullscreen?.();
          }}
        >
          {#if linkPostThumb}
            <img src={linkPostThumb} alt="" class="link-card-thumb" />
          {/if}
          <span class="link-card-body">
            <span class="link-card-site">
              {#if faviconUrl}<img src={faviconUrl} alt="" class="link-card-favicon" />{/if}
              {#if displayFeedTitle}{displayFeedTitle}{/if}
            </span>
            <span class="link-card-title">{itemTitle}</span>
            {#if linkPostExcerpt}
              <span class="link-card-excerpt">{linkPostExcerpt}</span>
            {/if}
          </span>
        </button>
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
        <a
          href="/?feed={feedId}"
          class="feed-title-link"
          title={isDocumentMode ? 'standard.site' : 'RSS'}
          onclick={(e) => e.stopPropagation()}
          ><Icon name={isDocumentMode ? 'standard-site' : 'rss'} size={12} />{feedTitle}</a
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
              class="action-label">{shareLabel}</span
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

  /* "via @handle" byline pill — sits in the title row's metadata cluster so a
     link post reads as an article with a person attached, not a special card. */
  .via-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    flex-shrink: 0;
    max-width: 11rem;
    font-size: 0.8rem;
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .via-pill:hover {
    color: var(--color-primary);
  }

  .via-avatar {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    object-fit: cover;
    flex-shrink: 0;
    background: var(--color-bg-secondary, #f0f0f0);
  }

  .via-label {
    white-space: nowrap;
  }

  .via-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Link-post body: the note as prose, then the article as a tappable card. */
  .link-post-note {
    font-family: var(--article-font);
    font-size: var(--article-font-size);
    line-height: 1.7;
    color: var(--color-text);
    margin: 0 0 1rem;
    overflow-wrap: break-word;
  }

  .link-card {
    display: flex;
    flex-direction: column;
    width: 100%;
    text-align: left;
    background: none;
    border: 1px solid var(--color-border, #e5e5e5);
    border-radius: 8px;
    overflow: hidden;
    cursor: pointer;
    padding: 0;
    font: inherit;
  }

  .link-card:hover {
    border-color: var(--color-primary, #0066cc);
  }

  .link-card-thumb {
    width: 100%;
    max-height: 180px;
    object-fit: cover;
  }

  .link-card-body {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.75rem;
    min-width: 0;
  }

  .link-card-site {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.75rem;
    color: var(--color-text-secondary);
  }

  .link-card-favicon {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
  }

  .link-card-title {
    font-weight: 600;
    color: var(--color-text);
    line-height: 1.35;
  }

  .link-card-excerpt {
    font-size: 0.875rem;
    line-height: 1.5;
    color: var(--color-text-secondary);
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* Link-post social context line (Constellation). Quiet, text-first. */
  /* Network-wide mentions (Phase 5) — a quiet lead line under the header. The
     left indent lines the lane icon up under the source favicon. */
  .article-mentions {
    padding: 0.0625rem 0 0.1875rem 1.625rem;
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
  }

  .mentions-lead {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    color: var(--color-text-secondary);
  }

  .mentions-lead.interactive {
    cursor: pointer;
  }

  .mentions-lead.interactive:hover {
    color: var(--color-primary);
  }

  .mentions-lead :global(.icon) {
    flex-shrink: 0;
    opacity: 0.85;
  }

  .mentions-text {
    white-space: nowrap;
  }

  .mentions-breakdown {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-top: 0.375rem;
  }

  .mentions-lane {
    display: flex;
    align-items: center;
    gap: 0.4375rem;
    line-height: 1.3;
  }

  .mentions-lane :global(.icon) {
    flex-shrink: 0;
    opacity: 0.85;
  }

  .mentions-lane-count {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    color: var(--color-text);
    min-width: 1.25rem;
  }

  .mentions-lane-label {
    color: var(--color-text);
  }

  .mentions-lane-verb {
    color: var(--color-text-secondary);
  }

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

  /* On desktop the wrapper is transparent: favicon + title flow directly into
     the header flex row. On mobile it becomes a full-width row so the favicon
     rides with the title and the meta wraps to a second line (see media query). */
  .title-line {
    display: contents;
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

  .feed-title-link :global(.icon),
  .feed-title-label :global(.icon) {
    margin-right: 0.3rem;
    vertical-align: -0.1em;
    color: var(--color-text-secondary);
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

  .action-btn:disabled {
    cursor: default;
    opacity: 0.7;
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

  /* Mobile: two-line header — [icon] [title] on top, [source] [date] below */
  @media (max-width: 600px) {
    .read-toggle {
      margin-top: calc(0.5rem + 5px);
    }

    .article-header {
      flex-wrap: wrap;
      gap: 0.25rem 0.5rem;
      /* The title takes a full-width first line; the meta items (via-pill,
         feed title, read-time, date) wrap to a second line. Center them on the
         cross axis so the via-pill's avatar shares a centerline with the small
         meta text instead of top-aligning. The title-line keeps its own
         flex-start alignment internally. */
      align-items: center;
    }

    /* Favicon + title become a full-width first line (as on desktop), so the
       source mark + feed title + meta wrap to a second line below. */
    .title-line {
      display: flex;
      align-items: flex-start;
      gap: 0.5rem;
      flex-basis: 100%;
      min-width: 0;
      order: 0;
    }

    .article-title {
      flex: 1 1 0;
      min-width: 0;
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
