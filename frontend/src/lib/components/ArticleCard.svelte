<script lang="ts">
  // Container for the article card. Owns ALL store/service/hook wiring and the
  // interaction logic; resolves a flat view-model + callbacks and hands them to
  // the PURE presentational <ArticleCardView/>. The card's markup + styles live
  // in ArticleCardView.svelte so the visual layer is iterable from mock data
  // (see /dev/cards). Keep this component's public props stable — FeedListView
  // and SavedReader depend on them.
  import type {
    Article,
    SocialDocument,
    BlueskyProfile,
    LeafletContent,
    PcktBlogContent,
    OffprintContent,
    GreengaleContent,
    MarkpubContent,
  } from '$lib/types';
  import { formatRelativeDate } from '$lib/utils/date';
  import { getFaviconUrl } from '$lib/utils/favicon';
  import { sanitizeHtml } from '$lib/utils/sanitize';
  import { marked } from 'marked';
  import { isLeafletContent, renderLeafletContent } from '$lib/utils/leaflet-renderer';
  import { isPcktBlogContent, renderPcktBlogContent } from '$lib/utils/pckt-blog-renderer';
  import { isOffprintContent, renderOffprintContent } from '$lib/utils/offprint-renderer';
  import { isGreengaleContent, renderGreengaleContent } from '$lib/utils/greengale-renderer';
  import { isMarkpubContent, renderMarkpubContent } from '$lib/utils/markpub-renderer';
  import {
    getExternalArticleLink,
    getLinkPostNote,
    getLinkPostNoteMentions,
    linkifyNoteMentions,
    formatQuoteSeed,
    noteHasBlockquote,
  } from '$lib/utils/linkPost';
  import { api } from '$lib/services/api';
  import { db } from '$lib/services/db';
  import { socialStore } from '$lib/stores/social.svelte';
  import { linkblogStore } from '$lib/stores/linkblog.svelte';
  import { myLinkblogStore } from '$lib/stores/myLinkblog.svelte';
  import { socialContextStore } from '$lib/stores/socialContext.svelte';
  import { articleMentionsStore } from '$lib/stores/articleMentions.svelte';
  import { mentionLaneItemsStore } from '$lib/stores/mentionLaneItems.svelte';
  import { profileService } from '$lib/services/profiles';
  import { auth } from '$lib/stores/auth.svelte';
  import type { IconName } from './Icon.svelte';
  import ArticleCardView from './ArticleCardView.svelte';
  import type { LaneId, LaneRowVM } from './articleCardView.types';
  import TagMenu from '$lib/components/feed/TagMenu.svelte';
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

  // Is this one of the CURRENT user's own linkblog posts (e.g. on the "Your
  // Linkblog" page)? If so, the Share button is a toggle that starts on, and the
  // note is editable in place — both acting directly on this document by rkey,
  // rather than via the URL-keyed reshare path.
  const LINKBLOG_PUB_SUFFIX = 'site.standard.publication/skyreader-links';
  let isOwnLinkblogPost = $derived(
    isDocumentMode &&
      !!document &&
      !!auth.user &&
      document.authorDid === auth.user.did &&
      (document.siteUri?.endsWith(LINKBLOG_PUB_SUFFIX) ?? false)
  );
  // The rkey of this document's PDS record (last path segment of its AT URI).
  let ownRkey = $derived(isOwnLinkblogPost ? (document?.recordUri.split('/').pop() ?? '') : '');

  // Local note override for the user's own post, so an in-place edit reflects
  // immediately without refetching the document.
  let ownNoteEdited = $state(false);
  let ownNoteOverride = $state<string | undefined>(undefined);
  let ownNote = $derived(
    ownNoteEdited ? ownNoteOverride : document ? getLinkPostNote(document) : undefined
  );

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

  // The link post's note, regardless of authorship — used both to render the
  // body (for others' posts) and to decide whether the quote already lives in
  // the note (see linkPostExcerpt).
  let rawLinkPostNote = $derived(
    isLinkPostMode && document ? getLinkPostNote(document) : undefined
  );
  // The user's commentary on a link post, in the author's own voice. For the
  // user's own post the note is shown (and edited) in the note box above the
  // action bar, so don't also render it as prose in the body.
  let linkPostNote = $derived(!isOwnLinkblogPost ? rawLinkPostNote : undefined);
  // @mention facets on the note, used to linkify handles to Bluesky profiles.
  let linkPostMentions = $derived(document ? getLinkPostNoteMentions(document) : []);
  // Notes are authored as Markdown — splice profile links over any @mention facets,
  // then parse to HTML (GFM, soft line breaks preserved) and sanitize before the view
  // renders it. Inline links open in a new tab via the same afterSanitize hook used
  // for article bodies.
  let linkPostNoteHtml = $derived(
    linkPostNote
      ? sanitizeHtml(
          marked.parse(linkifyNoteMentions(linkPostNote, linkPostMentions), {
            gfm: true,
            breaks: true,
            async: false,
          }) as string
        )
      : undefined
  );
  // The article excerpt, shown as a standalone quote — but only when the note
  // doesn't already carry the quote as Markdown. New shares seed the quote into
  // the editable note (rendered via linkPostNoteHtml), so showing the excerpt
  // here too would duplicate it; legacy notes (commentary only) keep it.
  let linkPostExcerpt = $derived(
    isLinkPostMode && !noteHasBlockquote(rawLinkPostNote) ? document?.description : undefined
  );
  let linkPostThumb = $derived(
    isLinkPostMode && document?.coverImageCid
      ? `https://cdn.bsky.app/img/feed_thumbnail/plain/${document.authorDid}/${document.coverImageCid}@jpeg`
      : undefined
  );

  // The full article body, lazy-loaded from IndexedDB when the card opens. The
  // in-memory article carries only metadata (the body is stripped to keep the
  // heap small), so we fetch it on demand rather than holding every body live.
  let lazyContent = $state<string | null>(null);

  // A document's flat text, lazy-loaded on open. Only used for documents whose
  // content format isn't recognized by the structured renderers below (the
  // common case renders structured `content` and never touches this).
  let lazyDocText = $state<string | null>(null);

  // Content handling - article has priority, then share content, then localArticle, then document
  let displayContent = $derived.by(() => {
    // Link posts don't inline the full article (that bounces through the
    // fullscreen reader on demand). The expanded body is rendered as explicit
    // note + link-card markup below, so there's no HTML content here.
    if (isLinkPostMode) return '';

    // For articles, use existing logic. The in-memory article is "light" (its
    // body was stripped to keep the heap small), so `article.content` is
    // normally absent; lazyContent holds the full body once it's read back from
    // IndexedDB on expand. Summary is the fallback/preview shown meanwhile.
    if (article?.content) return article.content;
    if (lazyContent) return lazyContent;
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

    // For documents with markpub (at.markpub.markdown) content, render it
    if (document?.content && isMarkpubContent(document.content)) {
      return renderMarkpubContent(document.content as MarkpubContent);
    }

    // Fall back to flat text content or description. textContent is stripped from
    // in-memory documents (see toLightDocument); lazyDocText holds it once read
    // back from IndexedDB on open.
    if (document?.textContent) return document.textContent;
    if (lazyDocText) return lazyDocText;
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

  // The content tap decision (expand vs select) — the view does the DOM guards
  // (don't act on link/media clicks) and forwards a single semantic tap here.
  function handleContentTap() {
    if (expanded) return;
    if (selected && !expanded && isTruncated) {
      // Content is truncated, expand it (this also selects)
      onExpand?.();
    } else {
      onSelect?.();
    }
  }

  // ── Resharing a document (Phase 7) ──────────────────────────────────────────
  // Every reshare is one shape: a site.standard.document in your own linkblog,
  // keyed by the article URL and toggled by the Share button (note optional).
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

  // ── The Atmosphere row (Phase 5) ────────────────────────────────────────────
  // For a regular article (only when open), one quiet row of source lanes — how
  // this URL is referenced across the Atmosphere. Each lane does double duty: it
  // shows the count of others AND is the affordance to add your own.
  const LANE_META: Record<
    LaneId,
    { icon: IconName; label: string; verb: string; noun: string; createLabel: string }
  > = {
    linkblog: {
      icon: 'standard-site',
      label: 'Blogs',
      verb: 'noted',
      noun: 'note',
      createLabel: 'Write a note',
    },
    bluesky: {
      icon: 'bluesky',
      label: 'Bluesky',
      verb: 'posted',
      noun: 'post',
      createLabel: 'Post on Bluesky',
    },
    margin: {
      icon: 'margin',
      label: 'margin.at',
      verb: 'saved',
      noun: 'save',
      createLabel: 'Save to Margin',
    },
    semble: {
      icon: 'semble',
      label: 'Semble',
      verb: 'saved',
      noun: 'save',
      createLabel: 'Save to Semble',
    },
  };
  const LANE_ORDER: LaneId[] = ['linkblog', 'bluesky', 'margin', 'semble'];

  // Whether the user can contribute to a lane from this card.
  function laneCanCreate(id: LaneId): boolean {
    switch (id) {
      case 'linkblog':
        // Sharing is the lane's own [+]: offered until you've shared, after which
        // the persistent note box (panel lead) owns editing/removal instead.
        return showShareAction && !currentlyShared;
      case 'semble':
        return Boolean(onSaveToSemble);
      case 'margin':
        return Boolean(onSaveToMargin);
      case 'bluesky':
        return true; // compose intent — always available
    }
  }

  // Mentions are keyed off the unified itemUrl, so the Atmosphere row works in
  // every mode: an article's URL, a link-post's external article, or a
  // document's canonical URL.
  $effect(() => {
    if (itemUrl) articleMentionsStore.fetch(itemUrl);
  });
  let articleMentions = $derived(itemUrl ? articleMentionsStore.get(itemUrl) : undefined);
  let mentionLanes = $derived(articleMentions?.lanes ?? []);
  let mentionLaneMap = $derived(new Map(mentionLanes.map((l) => [l.lane as LaneId, l])));

  // The lanes to render, in priority order. The Atmosphere button is a
  // first-class affordance on every open card, so Bluesky — whose compose intent
  // is always available — always appears, guaranteeing at least one lane. The
  // other lanes show only when they have a count or a working create affordance,
  // so we never render a dead "add yours" row the user can't act on.
  let laneRowBase = $derived.by(() => {
    const rows: Array<{ id: LaneId; count: number; capped: boolean; canCreate: boolean }> = [];
    for (const id of LANE_ORDER) {
      const data = mentionLaneMap.get(id);
      const count = data?.count ?? 0;
      const canCreate = laneCanCreate(id);
      // Keep the Linkblogs lane visible the moment you share, even before the
      // mention is indexed (count still 0), so you see yourself in the discussion.
      const keepMine = id === 'linkblog' && currentlyShared;
      if (id !== 'bluesky' && count === 0 && !canCreate && !keepMine) continue;
      rows.push({ id, count, capped: data?.capped ?? false, canCreate });
    }
    return rows;
  });

  // Fold LANE_META + tooltip + "mine" tint into each row so the view renders
  // straight from data (no LANE_META lookups in the presentational layer).
  let laneRowVM = $derived<LaneRowVM[]>(
    laneRowBase.map((r) => ({
      ...r,
      icon: LANE_META[r.id].icon,
      label: LANE_META[r.id].label,
      verb: LANE_META[r.id].verb,
      title:
        r.count > 0
          ? `${r.count}${r.capped ? '+' : ''} ${LANE_META[r.id].verb} this · ${LANE_META[r.id].label}`
          : `${LANE_META[r.id].label} — add yours`,
      isMine: r.id === 'linkblog' && currentlyShared,
      createLabel: LANE_META[r.id].createLabel,
      // Once shared, the linkblog lane drops its [+] (canCreate=false) and the
      // panel-lead note box owns editing — so the create button is never "edit".
      createIsEdit: false,
    }))
  );

  // Which lane is expanded to show its people (one at a time, accordion).
  let expandedLane = $state<LaneId | null>(null);
  let expandedLaneItems = $derived(
    expandedLane && itemUrl ? mentionLaneItemsStore.get(itemUrl, expandedLane) : undefined
  );

  function toggleLane(id: LaneId) {
    if (expandedLane === id) {
      expandedLane = null;
      return;
    }
    expandedLane = id;
    // Only resolve people for lanes that actually have references — a zero-count
    // lane (just a create affordance) has nobody to fetch.
    const hasPeople = (mentionLaneMap.get(id)?.count ?? 0) > 0;
    if (hasPeople && itemUrl) mentionLaneItemsStore.load(itemUrl, id);
  }

  // Contribute to a lane: note → the share flow (composer below), Margin/Semble
  // → their save handlers, Bluesky → a compose intent in a new tab.
  function createInLane(id: LaneId) {
    switch (id) {
      case 'linkblog':
        if (!currentlyShared) shareNow();
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

  // For articles, Semble/Margin live in the Atmosphere row; the action-bar and
  // overflow copies are kept for documents (which have no Atmosphere row).
  let showActionBarIntegrations = $derived(isDocumentMode);

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
  let currentlyShared = $derived.by(() => {
    if (isOwnLinkblogPost) return true; // your own post is, by definition, shared
    if (isDocumentMode) return isQuoted;
    return isShared;
  });

  let currentNote = $derived.by(() => {
    if (isOwnLinkblogPost) return ownNote;
    if (isDocumentMode) return isQuoted && quoteKey ? linkblogStore.getNote(quoteKey) : '';
    return shareNote;
  });

  // Whether sharing is offered (the Blogs lane's [+]): document sharing requires
  // sign-in; a plain article share is gated by whether the page wired up onShare.
  let showShareAction = $derived(isDocumentMode ? Boolean(auth.user) : Boolean(onShare));

  // The article's own excerpt, formatted as an editable Markdown quote to seed a
  // new share with — the user trims, rewrites, or deletes it from the note box.
  let shareQuoteSource = $derived(
    isDocumentMode ? document?.description : (article?.summary ?? localArticle?.summary)
  );
  let seededQuote = $derived(formatQuoteSeed(shareQuoteSource));

  // Fire the share for the current mode (the Blogs lane [+]), seeding the note
  // with the article's quote so it lands in the persistent note box ready to
  // edit or remove. Submitting from the feed is one tap; refinement happens there.
  async function shareNow() {
    if (isDocumentMode) {
      isQuoting = true;
      try {
        await handleQuote(seededQuote ?? '');
      } finally {
        isQuoting = false;
      }
      return;
    }
    onShare?.(seededQuote);
  }

  // Attach/update the note. The box stays visible after saving — it's persistent
  // while shared.
  async function applyComment(note: string) {
    if (isOwnLinkblogPost) {
      if (!ownRkey) return;
      const trimmed = note.trim();
      // Reflect locally, then persist (empty string clears the note).
      ownNoteOverride = trimmed || undefined;
      ownNoteEdited = true;
      // Also update the listed document so the edit survives a remount and the
      // overlay/My-Linkblog page reflect it ahead of the next pull.
      if (document) myLinkblogStore.setNote(document.recordUri, trimmed);
      try {
        await api.updateLinkblogShareNote(ownRkey, trimmed);
      } catch (e) {
        console.error('Failed to update linkblog note:', e);
      }
      return;
    }
    if (isDocumentMode) {
      if (isQuoted && quoteKey) linkblogStore.setNote(quoteKey, note);
      else await handleQuote(note);
    } else {
      linkblogStore.setNote(itemUrl, note);
    }
  }

  // Remove the share entirely (the Remove control in the persistent note box, or
  // the action-bar Share toggle after its inline confirm).
  async function removeShare() {
    if (isOwnLinkblogPost) {
      if (!ownRkey || !document) return;
      const recordUri = document.recordUri;
      try {
        await api.deleteLinkblogShare(ownRkey);
        myLinkblogStore.removeByRecordUri(recordUri);
      } catch (e) {
        console.error('Failed to delete linkblog post:', e);
      }
      onUnshare?.();
      return;
    }
    if (isDocumentMode) {
      if (quoteKey) await linkblogStore.unshare(quoteKey);
    } else {
      onUnshare?.();
    }
  }

  function handleOpenUrl() {
    window.open(itemUrl, '_blank', 'noopener');
  }

  let isOpen = $derived(selected || expanded);

  // Pull the full body into memory the first time the card opens. The list hands
  // us a light article (no `content`), so read it back from IndexedDB — by id,
  // or by guid for rows merged this session that don't have an id yet. The body
  // never lives in the shared in-memory array; it's held only here, per open card.
  $effect(() => {
    if (!isOpen || !article || article.content || lazyContent != null) return;
    const { id, guid, subscriptionId } = article;
    let cancelled = false;
    (async () => {
      try {
        let row = id != null ? await db.articles.get(id) : undefined;
        if (!row && guid) {
          row = await db.articles
            .where('guid')
            .equals(guid)
            .filter((a) => a.subscriptionId === subscriptionId)
            .first();
        }
        if (!cancelled) lazyContent = row?.content ?? '';
      } catch {
        if (!cancelled) lazyContent = '';
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  // Same lazy-load for a document's flat text (stripped from memory). Only
  // fetched when the document carries no in-memory textContent — i.e. a
  // stripped social-feed doc — and read back by recordUri.
  $effect(() => {
    if (!isOpen || !document || document.textContent || lazyDocText != null) return;
    const recordUri = document.recordUri;
    let cancelled = false;
    socialStore.getTextContent(recordUri).then((t) => {
      if (!cancelled) lazyDocText = t;
    });
    return () => {
      cancelled = true;
    };
  });

  let hasContent = $derived(Boolean(displayContent));
  let sanitizedContent = $derived(sanitizeHtml(displayContent, itemUrl));

  // Pre-resolved date string for the view (so the view imports no utils).
  let relativeDate = $derived(formatRelativeDate(itemPublishedAt));

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
    // Read the rendered content so this re-measures whenever the body's HTML
    // changes, not only on open. The body is "light" until its full text is
    // hydrated in after first paint (see displayContent); in Expand view every
    // card is `selected` from the start, so without this dependency the effect
    // would measure the short pre-hydration body once, latch isTruncated=false,
    // and leave the "More" button wrongly disabled. List view dodged this only
    // because a card isn't `selected` until clicked — i.e. after hydration.
    sanitizedContent;
    if (selected && !expanded && bodyEl) {
      // Check if content overflows the line clamp
      isTruncated = bodyEl.scrollHeight > bodyEl.clientHeight;
    }
  });

  // Tag menu state
  let tagMenuOpenLocal = $state(false);
  let tagBtnRef = $state<HTMLButtonElement | undefined>(undefined);

  // Overflow menu state
  let overflowMenuOpen = $state(false);

  function handleOverflowClick() {
    overflowMenuOpen = !overflowMenuOpen;
  }

  function handleOverflowOpenUrl() {
    overflowMenuOpen = false;
    window.open(itemUrl, '_blank', 'noopener');
  }

  let overflowTriggerRef = $state<HTMLButtonElement | undefined>(undefined);

  // When the inline tag button is collapsed, the TagMenu anchors to the overflow
  // trigger instead. The view owns both refs (bind:this); the container only
  // chooses which one to anchor to — never reassigns a bound ref.
  let useOverflowAnchor = $state(false);
  let tagAnchor = $derived(useOverflowAnchor ? overflowTriggerRef : tagBtnRef);

  function handleOverflowTag() {
    overflowMenuOpen = false;
    // Anchor the TagMenu to the overflow trigger since the inline tag button is hidden
    useOverflowAnchor = true;
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
  let itemTags = $derived(itemLabelsStore.getTagsForItem(itemGuid));

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

  // Set up observer when article is expanded. We track reading progress but do
  // NOT auto-scroll to it: expanding a card inline should leave the viewport put
  // (re-expanding an article with saved progress otherwise jumps the text down a
  // little). Reading-position restore lives in the fullscreen reader instead.
  $effect(() => {
    if (expanded && bodyEl && hasContent) {
      // Wait for content to render
      tick().then(() => {
        paragraphTracking.setupObserver();
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

  function handleTagClick() {
    // Inline tag button is the anchor
    useOverflowAnchor = false;
    tagMenuOpenLocal = !tagMenuOpenLocal;
    // Clear store-level tag menu if we're toggling
    if (feedViewStore.tagMenuItemKey === itemGuid) {
      feedViewStore.closeTagMenu();
    }
  }

  function handleOverflowSemble() {
    overflowMenuOpen = false;
    onSaveToSemble?.();
  }

  function handleOverflowMargin() {
    overflowMenuOpen = false;
    onSaveToMargin?.();
  }
</script>

<svelte:window onkeydown={handleParagraphKeydown} />

<ArticleCardView
  {itemUrl}
  {itemTitle}
  {relativeDate}
  {faviconUrl}
  {displayFeedTitle}
  {feedTitle}
  {feedId}
  {readTimeMinutes}
  {sanitizedContent}
  {hasContent}
  {isDocumentMode}
  {isLinkPostMode}
  {linkPostNote}
  {linkPostNoteHtml}
  {linkPostExcerpt}
  {linkPostThumb}
  {authorHandle}
  {authorDisplayName}
  {authorAvatar}
  authorDid={document?.authorDid}
  socialContext={socialContext ? { quoteCount: socialContext.quoteCount } : undefined}
  {alsoLinkedBy}
  laneRow={laneRowVM}
  {expandedLane}
  {expandedLaneItems}
  {itemTagCount}
  {itemTags}
  {isRead}
  {isSaved}
  {selected}
  {expanded}
  {isOpen}
  {highlighted}
  {isTruncated}
  {currentlyShared}
  {currentNote}
  {showActionBarIntegrations}
  {overflowMenuOpen}
  {canFollowSource}
  hasSaveToSemble={Boolean(onSaveToSemble)}
  hasSaveToMargin={Boolean(onSaveToMargin)}
  hasOpenFullscreen={Boolean(onOpenFullscreen)}
  bind:bodyEl
  bind:tagBtnRef
  bind:overflowTriggerRef
  onHeaderClick={handleHeaderClick}
  onContentTap={handleContentTap}
  onToggleRead={() => onToggleRead?.()}
  onToggleSave={() => onToggleSave?.()}
  onRemoveShare={() => removeShare()}
  onOpenUrl={handleOpenUrl}
  onOpenFullscreen={() => onOpenFullscreen?.()}
  onOpenLinkMenu={(rect) =>
    linkInterception.openMenu({ url: itemUrl, linkText: itemTitle, anchorRect: rect })}
  onExpandToggle={() => onExpand?.()}
  onTagClick={handleTagClick}
  onOverflowClick={handleOverflowClick}
  onOverflowOpenUrl={handleOverflowOpenUrl}
  onOverflowTag={handleOverflowTag}
  onOverflowSemble={handleOverflowSemble}
  onOverflowMargin={handleOverflowMargin}
  onSaveToSemble={() => onSaveToSemble?.()}
  onSaveToMargin={() => onSaveToMargin?.()}
  onFollowSource={handleFollowSource}
  onToggleLane={toggleLane}
  onCreateInLane={createInLane}
  onApplyComment={applyComment}
  onOpenAuthor={(did) => sidebarStore.openAddFeedModalForDid(did)}
  onMentionClick={(did) => sidebarStore.openAddFeedModalForDid(did)}
  onCloseOverflow={() => (overflowMenuOpen = false)}
/>

<!-- Overlays stay in the container: they're driven by store/hook state and self-
     position with position:fixed, so they have no dependency on the card markup. -->
{#if isOpen}
  {#if tagMenuOpen}
    <TagMenu
      itemKey={itemGuid}
      itemType={itemTagType}
      anchorEl={tagAnchor ?? null}
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
{/if}
