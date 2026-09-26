<script lang="ts">
  import { untrack } from 'svelte';
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
    ReaderCollectionItem,
    FollowLink,
    FollowLinkSharer,
  } from '$lib/types';
  import { followLinkSaid, sharedByLabel, sharedByPill } from '$lib/utils/followLinks';
  import { formatRelativeDate } from '$lib/utils/date';
  import { getFaviconUrl } from '$lib/utils/favicon';
  import { sanitizeHtml } from '$lib/utils/sanitize';
  import { decodeEntities } from '$lib/utils/entities';
  import { marked } from 'marked';
  import { getDisplayContent } from '$lib/utils/displayItem';
  import {
    getExternalArticleLink,
    getLinkPostNote,
    getLinkPostNoteMentions,
    isSkyreaderShare,
    linkifyNoteMentions,
    noteHasBlockquote,
  } from '$lib/utils/linkPost';
  import { api } from '$lib/services/api';
  import { linkPostContentStore } from '$lib/stores/linkPostContent.svelte';
  import { db } from '$lib/services/db';
  import { saveCollectionPiece, isCollectionPieceSaved } from '$lib/utils/collectionPiece';
  import { socialStore } from '$lib/stores/social.svelte';
  import { linkblogStore } from '$lib/stores/linkblog.svelte';
  import { myLinkblogStore } from '$lib/stores/myLinkblog.svelte';
  import { shareComposerStore } from '$lib/stores/shareComposer.svelte';
  import { shareDraftsStore } from '$lib/stores/shareDrafts.svelte';
  import { recommendsStore, isRecommendable } from '$lib/stores/recommends.svelte';
  import { socialContextStore } from '$lib/stores/socialContext.svelte';
  import { profileService } from '$lib/services/profiles';
  import { auth } from '$lib/stores/auth.svelte';
  import { blueskyComposerStore } from '$lib/stores/blueskyComposer.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { integrationSaveStore } from '$lib/stores/integrationSave.svelte';
  import { sembleConnectionStore } from '$lib/stores/sembleConnection.svelte';
  import { toggleSavedLink } from '$lib/utils/saveLink';
  import { preferences } from '$lib/stores/preferences.svelte';
  import ArticleCardView from './ArticleCardView.svelte';
  import { useAtmosphere } from '$lib/hooks/useAtmosphere.svelte';
  import type { LaneId } from './articleCardView.types';
  import TagMenu from '$lib/components/feed/TagMenu.svelte';
  import LinkContextMenu from '$lib/components/feed/LinkContextMenu.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { feedViewStore } from '$lib/stores/feedView.svelte';
  import { isInputFocused } from '$lib/stores/keyboard.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { loadStoredBody, prefetchStoredBody } from '$lib/services/itemBody';
  import { useParagraphTracking } from '$lib/hooks/useParagraphTracking.svelte';
  import { useLinkInterception } from '$lib/hooks/useLinkInterception.svelte';
  import { useHighlights } from '$lib/hooks/useHighlights.svelte';
  import HighlightPopover from '$lib/components/feed/HighlightPopover.svelte';
  import HighlightHandles from '$lib/components/feed/HighlightHandles.svelte';
  import NotePeek from '$lib/components/feed/NotePeek.svelte';
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
    followSharers,
    followLink,
    onToggleSave,
    onToggleRead,
    onUnshare,
    onSelect,
    onExpand,
    onOpenFullscreen,
    onOpenCollectionPiece,
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
    /** People you follow who shared this on Bluesky, newest first. */
    followSharers?: FollowLinkSharer[];
    /** The follows link this card renders (`article` is its followLinkArticle):
     *  no feed behind it and no body of its own, so it shows as a link card. */
    followLink?: FollowLink;
    onToggleSave?: () => void;
    onToggleRead?: () => void;
    onUnshare?: () => void;
    onSelect?: () => void;
    onExpand?: () => void;
    onOpenFullscreen?: () => void;
    /** Open a curated edition piece in the in-app reader. Threaded from the list
     *  view, which owns the reader stack. */
    onOpenCollectionPiece?: (item: ReaderCollectionItem) => void | Promise<void>;
  } = $props();

  let isFollowLink = $derived(Boolean(followLink));

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
  // Requires that SKYREADER wrote it, not merely that it sits in the user's
  // linkblog: a connected publication also carries its home app's own posts, and
  // offering Remove on one of those would delete an essay from their PDS.
  let isOwnLinkblogPost = $derived(
    isDocumentMode &&
      !!document &&
      !!auth.user &&
      document.authorDid === auth.user.did &&
      isSkyreaderShare(document)
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
  let itemTitle = $derived(
    decodeEntities(article?.title) || decodeEntities(document?.title) || itemUrl
  );
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
  // The commentary on a link post, in the author's own voice — the post's own
  // body, so it renders the same whoever wrote it. Your own post reads through
  // `ownNote` so an in-place edit shows before the next pull lands.
  let linkPostNote = $derived(isOwnLinkblogPost ? ownNote : rawLinkPostNote);
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
  // An archive-truncated article's opening (`contentLead`), read back alongside
  // lazyContent: what the collapsed card previews in place of the <description>
  // until the full body is loaded.
  let lazyLead = $state<string | null>(null);

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

    // If the reader explicitly fetched the original article, that full extraction
    // wins over the feed body — RSS entries are often just an excerpt. Keyed on
    // the article URL via the shared extract cache (same path link posts use).
    const fetchedOriginal = article ? linkPostContentStore.get(itemUrl) : undefined;
    if (fetchedOriginal?.content) return fetchedOriginal.content;

    // For articles, use existing logic. The in-memory article is "light" (its
    // body was stripped to keep the heap small), so `article.content` is
    // normally absent; lazyContent holds the full body once it's read back from
    // IndexedDB on expand. Summary is the fallback/preview shown meanwhile.
    if (article?.content) return article.content;
    if (lazyContent) return lazyContent;
    if (article?.contentLead) return article.contentLead;
    if (lazyLead) return lazyLead;
    if (article?.summary) return article.summary;
    if (localArticle?.content) return localArticle.content;
    if (localArticle?.summary) return localArticle.summary;

    // Documents go through the shared renderer chain: structured `content` first
    // (Leaflet / pckt / Offprint / Greengale / markpub), then the plaintext
    // `textContent` fallback, then description. This card used to inline its own
    // copy of that chain, which is how it drifted from the reader's. textContent
    // is stripped from in-memory documents (see toLightDocument); lazyDocText
    // holds it once read back from IndexedDB on open.
    if (document) {
      const doc =
        document.textContent || lazyDocText == null
          ? document
          : { ...document, textContent: lazyDocText };
      return getDisplayContent({ type: 'document', item: doc, key: doc.recordUri });
    }

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
      socialContextStore.fetch({ docUri: document.recordUri });
    }
  }

  // The content tap decision (expand vs select) — the view does the DOM guards
  // (don't act on link/media clicks) and forwards a single semantic tap here.
  function handleContentTap() {
    if (expanded) return;
    if (selected && canExpand) {
      // Content is truncated, expand it (this also selects)
      onExpand?.();
    } else if (!selected) {
      onSelect?.();
    }
    // selected && !truncated: the full body is already shown inline. Do nothing —
    // a tap (including the click that ends a drag-select) must not collapse the
    // card, otherwise you can't select text in a short article.
  }

  // ── Resharing a document (Phase 7) ──────────────────────────────────────────
  // Every reshare is one shape: a site.standard.document in your own linkblog,
  // keyed by the article URL and toggled by the Share button (note optional).
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
  // ── The Atmosphere row (Phase 5) ────────────────────────────────────────────
  // For a regular article (only when open), one quiet row of source lanes — how
  // this URL is referenced across the Atmosphere. Each lane does double duty: it
  // shows the count of others AND is the affordance to add your own. The lane data
  // (counts, people, expand state, the row VM) is shared with the reader via
  // useAtmosphere; only what a lane's "create" affordance can do here, and what it
  // does, is mode-specific and stays in this container.

  // Whether the user can contribute to a lane from this card.
  function laneCanCreate(id: LaneId): boolean {
    switch (id) {
      case 'linkblog':
        // The action bar's Share button IS the linkblog affordance here, in both
        // states — so the discussion's compose row never repeats it a few pixels
        // away inside the same footer band.
        return false;
      case 'leaflet':
        return false;
      case 'semble':
      case 'margin':
        // The collection picker is global, so these are offered wherever the
        // card is rendered. Having saved before doesn't retire the control:
        // saving again is how the article joins another collection.
        return Boolean(auth.user);
      case 'bluesky':
        // The intent link needs no Skyreader session, but posting is still
        // adding to the discussion, and everything that adds is account-only.
        // Reading the lane is not: a guest sees who posted, just not the button.
        return Boolean(auth.user);
    }
  }

  // Mentions are keyed off the unified itemUrl, so the Atmosphere row works in
  // every mode: an article's URL, a link-post's external article, or a
  // document's canonical URL.
  const atmosphere = useAtmosphere({
    itemUrl: () => itemUrl,
    itemAtUri: () => (isDocumentMode && !isLinkPostMode ? document?.recordUri : undefined),
    itemTitle: () => itemTitle,
    sourceTitle: () => displayFeedTitle,
    isShared: () => currentlyShared,
    canCreate: laneCanCreate,
  });

  // Contribute to a lane: linkblog → the share composer, Margin/Semble → their
  // save handlers, Bluesky → the in-app post dialog (a compose intent for a guest).
  function createInLane(id: LaneId) {
    switch (id) {
      case 'linkblog':
        if (!currentlyShared) composeShare();
        break;
      case 'leaflet':
        break;
      case 'semble':
        saveToSemble();
        break;
      case 'margin':
        saveToMargin();
        break;
      case 'bluesky':
        // Signed in, post from here; a guest has no account to post from, so
        // Bluesky's own composer takes the link.
        if (auth.user && itemUrl) {
          blueskyComposerStore.open({ source: article ?? { url: itemUrl, title: itemTitle } });
        } else {
          window.open(
            `https://bsky.app/intent/compose?text=${encodeURIComponent(itemUrl)}`,
            '_blank',
            'noopener'
          );
        }
        break;
    }
  }

  // For articles, Semble/Margin live in the Atmosphere row; the action-bar and
  // overflow copies are kept for documents (which have no Atmosphere row).
  let showActionBarIntegrations = $derived(isDocumentMode);

  // The Article a document-mode share points at (repostUri = the doc's AT URI,
  // so a reshared link post credits the original).
  function buildQuoteArticle(): Article | null {
    if (!document || !quoteKey) return null;
    return {
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

  // Whether sharing is offered (the Blogs lane's [+]): you're signed in and
  // haven't turned the linkblog off. Same gate in both modes.
  let showShareAction = $derived(Boolean(auth.user) && !preferences.linkblogDisabled);

  // Recommend: account-only (it writes to the reader's repo) and needs a real
  // link. The URL is the article itself — for a link post, the external article
  // it points at, not the linkblog entry. A standard.site document (not a link
  // post) also carries its record, so the recommend reaches its author.
  let recommendUrl = $derived(itemUrl);
  let canRecommend = $derived(Boolean(auth.user) && isRecommendable(recommendUrl));
  let isRecommended = $derived(recommendsStore.isRecommended(recommendUrl));
  function toggleRecommend() {
    if (!isRecommendable(recommendUrl)) return;
    void recommendsStore.toggle({
      url: recommendUrl,
      title: itemTitle,
      documentUri:
        isDocumentMode &&
        !isLinkPostMode &&
        document?.recordUri.includes('/site.standard.document/')
          ? document.recordUri
          : undefined,
    });
  }

  // The URL the share (and its local draft) is keyed by in the current mode.
  let shareUrl = $derived(isDocumentMode ? quoteKey : itemUrl);
  let hasShareDraft = $derived(shareUrl ? shareDraftsStore.hasDraft(shareUrl) : false);

  // The Article object a share of this card points at.
  function shareArticle(): Article | null {
    if (isDocumentMode) return buildQuoteArticle();
    return article ?? null;
  }

  // Open the composer drawer to draft this share (resumes any saved draft).
  function composeShare() {
    const target = shareArticle();
    if (!target) return;
    shareComposerStore.open({
      article: target,
      repostUri: isDocumentMode ? document?.recordUri : undefined,
      itemKey: itemGuid,
      mode: 'create',
    });
  }

  // Open the composer on the posted note (edit mode). The user's own linkblog
  // post edits by rkey (it may live in a connected publication the URL-keyed
  // store path can't reach); everything else uses the default setNote path.
  function editShare() {
    const target = shareArticle();
    if (!target) return;
    shareComposerStore.open({
      article: target,
      itemKey: itemGuid,
      mode: 'edit',
      initialNote: currentNote ?? '',
      submit: isOwnLinkblogPost ? submitOwnNote : undefined,
      remove: removeShare,
    });
  }

  async function submitOwnNote(note: string) {
    // Throw rather than return: the composer reads a resolved submit as "saved"
    // and closes on it, so a quiet return would drop the edit and say it worked.
    if (!ownRkey) throw new Error('This post has no record to edit.');
    const trimmed = note.trim();
    // Reflect locally, then persist (empty string clears the note).
    ownNoteOverride = trimmed || undefined;
    ownNoteEdited = true;
    // Also update the listed document so the edit survives a remount and the
    // overlay/My-Linkblog page reflect it ahead of the next pull.
    if (document) myLinkblogStore.setNote(document.recordUri, trimmed);
    await api.updateLinkblogShareNote(ownRkey, trimmed);
  }

  // Remove the share entirely — the composer's Remove control in edit mode.
  // Throws rather than swallowing: the composer reads a resolved remove as
  // "gone" and closes on it, so a quiet failure would look like a removal.
  async function removeShare() {
    if (isOwnLinkblogPost) {
      if (!ownRkey || !document) throw new Error('This post has no record to remove.');
      const recordUri = document.recordUri;
      await api.deleteLinkblogShare(ownRkey);
      myLinkblogStore.removeByRecordUri(recordUri);
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
        if (!cancelled) {
          lazyLead = row?.contentLead ?? null;
          lazyContent = row?.content ?? '';
        }
      } catch {
        if (!cancelled) lazyContent = '';
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  // The archive drops oversized bodies from the row at ingest (per-item inline
  // cap), marks the item `contentTruncated`, and keeps the body out-of-row.
  // Without this the reader would silently show the RSS summary — often a
  // one-line subtitle — in place of a full-text post. So when such an article
  // opens: once the IndexedDB read above says there's no local copy, fetch the
  // stored body (it lands in lazyContent and is cached into IndexedDB), and only
  // if the archive has none, extract the original (fetchedOriginal wins in
  // displayContent; the extract cache means it happens once per URL).
  // Gated on `expanded` rather than `isOpen`: a keyboard cursor moving across the
  // list — or Expand view, where every card is `selected` — shouldn't fire a
  // request per card it passes over.
  // `unavailable` (offline, 429, 5xx) is not an answer, so it isn't final: the
  // card stays expandable and asks again on the next expand or when the browser
  // comes back online — for a guest, who can't extract, that's the only way in.
  let storedBodyStatus = $state<'idle' | 'loading' | 'found' | 'missing' | 'unavailable'>('idle');
  let storedBodyRetry = $state(0);
  $effect(() => {
    const onOnline = () => {
      if (untrack(() => storedBodyStatus) === 'unavailable') storedBodyRetry++;
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  });
  $effect(() => {
    void storedBodyRetry;
    if (!expanded || !article?.contentTruncated || !itemUrl) return;
    // Wait for the local read; a body already cached there needs neither fetch.
    if (article.content || lazyContent == null || lazyContent) return;
    const target = article;
    const url = itemUrl;
    // Everything below reads and writes state the effect must not depend on: the
    // status guard, and `fetch`'s reactive entry map — tracking a failed extract's
    // deleted entry would turn an error (or offline mode) into a retry loop.
    untrack(() => {
      if (storedBodyStatus === 'missing') {
        linkPostContentStore.fetch(url);
        return;
      }
      if (storedBodyStatus === 'loading' || storedBodyStatus === 'found') return;
      if (storedBodyStatus === 'unavailable' && hasFetchedOriginal) return;
      storedBodyStatus = 'loading';
      const feedUrl = subscriptionsStore.getById(target.subscriptionId)?.feedUrl;
      const pending = feedUrl
        ? loadStoredBody(target, feedUrl, { guest: !auth.user })
        : Promise.resolve({ status: 'missing' } as const);
      pending.then((result) => {
        if (result.status === 'found') {
          lazyContent = result.content;
          storedBodyStatus = 'found';
          return;
        }
        storedBodyStatus = result.status;
        // Extract meanwhile; after `unavailable` a later expand still asks for
        // the stored copy unless extraction has already supplied the body.
        linkPostContentStore.fetch(url);
      });
    });
  });

  // Prefetch the stored body as an open card nears the screen (Expand view opens
  // every card), so expanding it is instant and needs no network afterwards. It
  // only warms the cache — the effect above picks the body up on expand — so a
  // collapsed card keeps previewing the lead and never sanitizes a 300 KB body
  // for eight visible lines. The exception is a row cached before the archive
  // kept leads: with nothing better than a one-line <description> to show, it
  // previews the body itself. A prefetch never extracts; `missing` is recorded
  // so the expand goes straight to extraction.
  let reachedViewport = $state(false);
  let prefetchStarted = false;
  function handleNearViewport() {
    reachedViewport = true;
    atmosphere.enterViewport();
  }
  $effect(() => {
    if (!isOpen || expanded || !reachedViewport || !article?.contentTruncated) return;
    // Wait for the local read; a body already cached there needs no fetch.
    if (article.content || lazyContent == null || lazyContent) return;
    const target = article;
    const hasLead = Boolean(article.contentLead || lazyLead);
    untrack(() => {
      if (prefetchStarted || storedBodyStatus !== 'idle') return;
      const feedUrl = subscriptionsStore.getById(target.subscriptionId)?.feedUrl;
      if (!feedUrl) return;
      prefetchStarted = true;
      void prefetchStoredBody(target, feedUrl, { guest: !auth.user }).then(async (status) => {
        if (status === 'missing') {
          if (storedBodyStatus === 'idle') storedBodyStatus = 'missing';
        } else if (status === 'found' && !hasLead && !lazyContent) {
          // Cached by now, so this resolves without the network.
          const result = await loadStoredBody(target, feedUrl, { guest: !auth.user });
          if (result.status === 'found' && !lazyContent) lazyContent = result.content;
        } else if (status !== 'found') {
          // Skipped or unanswered: let a later pass (or the expand) ask again.
          prefetchStarted = false;
        }
      });
    });
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

  // Word count of the currently displayed body (tags stripped). Drives both the
  // read-time estimate and the short-article signal below.
  let bodyWordCount = $derived.by(() => {
    const content = displayContent;
    if (!content) return 0;
    const text = content.replace(/<[^>]*>/g, '');
    return text.split(/\s+/).filter(Boolean).length;
  });

  // Estimate read time from content (~200 words/min). A follows link's body is
  // its card blurb until the page is fetched, so it gets no estimate before then;
  // nor does an archive-truncated article showing only its lead or summary,
  // which would count a few KB of a long post as the whole of it.
  let showingPartialBody = $derived(
    Boolean(article?.contentTruncated) &&
      !article?.content &&
      !lazyContent &&
      !linkPostContentStore.get(itemUrl)?.content
  );
  let readTimeMinutes = $derived(
    (isFollowLink && !linkPostContentStore.get(itemUrl)?.content) || showingPartialBody
      ? 0
      : bodyWordCount > 0
        ? Math.max(1, Math.round(bodyWordCount / 200))
        : 0
  );

  // A follows link, until its page is fetched, is what its sharer posted: their
  // words, then the link card. Shown that way so a row with no article text
  // reads as a link someone shared, not a feed item that lost its body.
  let followLinkCardVM = $derived.by(() => {
    // Once the page is fetched it's an article like any other; a fetch that came
    // back empty leaves the card, which still says what the row is.
    if (!followLink || linkPostContentStore.get(itemUrl)?.content) return undefined;
    let domain = followLink.site;
    try {
      domain = new URL(followLink.url).hostname.replace(/^www\./, '');
    } catch {
      // keep the site
    }
    return {
      title: itemTitle,
      description: followLink.description ? decodeEntities(followLink.description) : null,
      thumb: followLink.thumb,
      domain,
      said: followLinkSaid(followLink),
    };
  });

  let followSharersVM = $derived(
    followSharers && followSharers.length > 0
      ? {
          names: sharedByPill(followSharers),
          title: sharedByLabel(followSharers),
          avatars: followSharers
            .map((s) => s.avatar)
            .filter((a): a is string => !!a)
            .slice(0, 3),
        }
      : undefined
  );

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
    // Bail before touching `sanitizedContent` when there's no clamped preview to
    // measure. The order is the point: the body only renders under `{#if isOpen}`
    // (`isOpen = selected || expanded`), so for a *closed* card this effect was
    // the one thing forcing the derived — a full DOMPurify parse for HTML nobody
    // sees. `selected`/`expanded` are read first, so the effect stays subscribed
    // and re-measures the moment the card opens.
    //
    // Scope, so this isn't mistaken for more than it is: the saving is List view
    // only. `expandAllItems` defaults to true and FeedListView passes
    // `selected={preferences.expandAllItems || …}`, so in the default Expand view
    // every card is `selected`, every body renders, and the sanitize is work the
    // render needs anyway — there is nothing to skip there.
    if (!selected || expanded) return;
    // Read the rendered content so this re-measures whenever the body's HTML
    // changes, not only on open. The body is "light" until its full text is
    // hydrated in after first paint (see displayContent); in Expand view every
    // card is `selected` from the start, so without this dependency the effect
    // would measure the short pre-hydration body once, latch isTruncated=false,
    // and leave the "More" button wrongly disabled. List view dodged this only
    // because a card isn't `selected` until clicked — i.e. after hydration.
    sanitizedContent;
    if (bodyEl) {
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

  // "Fetch original article" — pull the full article body via the feed-proxy
  // reader (Defuddle) and render it inline, replacing the RSS excerpt.
  // Articles-only (documents bring their own body); the extract cache
  // dedupes/caches per URL. The affordance takes two forms:
  //   - short excerpt: a prominent inline "Fetch full article" at the body's end
  //     (a natural "continue reading" nudge where the feed clearly held back).
  //   - long body: a quieter entry in the ⋯ overflow menu, so a full-content
  //     feed isn't nagged but the reader can still force a clean re-extraction.
  const SHORT_ARTICLE_WORDS = 200;
  let fetchingOriginal = $derived(Boolean(article) && linkPostContentStore.isFetching(itemUrl));
  let hasFetchedOriginal = $derived(Boolean(article) && Boolean(linkPostContentStore.get(itemUrl)));
  // Account-only, like the store it drives (extraction needs a session). Hidden
  // rather than offered and refused: a guest's feed is full of truncated RSS
  // bodies, so a dead "Fetch full article" would sit under most of them.
  let canFetchOriginal = $derived(
    Boolean(auth.user) && Boolean(article) && Boolean(itemUrl) && !hasFetchedOriginal
  );

  // Whether "More" / a content tap can expand the card. Usually that's the
  // measured clamp overflow, but an archive-truncated article (body dropped from
  // the row at ingest) previews only its feed <description> — for Substack, a
  // one-line subtitle that never overflows — so the clamp alone would leave it
  // stuck on the description with no way in. Expanding is what loads the full
  // body (stored copy, else extraction), so such an article stays expandable
  // until it has one — unless neither source can supply it (no stored copy and
  // no account to extract with). Kept separate from `isTruncated`, which also
  // drives the clamp fade.
  let canExpand = $derived(
    isTruncated ||
      (Boolean(article?.contentTruncated) &&
        !lazyContent &&
        !hasFetchedOriginal &&
        (storedBodyStatus !== 'missing' || canFetchOriginal))
  );
  // Not for a follows link: its link card is the way in (it opens the reader),
  // and expanding the row fetches the page. The ⋯ menu still offers a retry.
  let showFetchOriginal = $derived(
    canFetchOriginal && !isFollowLink && bodyWordCount > 0 && bodyWordCount < SHORT_ARTICLE_WORDS
  );
  // Everything fetchable that isn't the short-excerpt inline case (long bodies,
  // and the rare empty body) surfaces in the overflow menu instead.
  let showFetchOriginalMenu = $derived(canFetchOriginal && !showFetchOriginal);

  function handleFetchOriginal() {
    if (!itemUrl) return;
    linkPostContentStore.fetch(itemUrl);
    // The excerpt is short so it shows fully when selected; the fetched body is
    // longer, so expand to keep it all visible. onExpand toggles — only fire it
    // when not already expanded.
    if (!expanded) onExpand?.();
  }

  // Opening a follows link's card is asking for the article: fetch it without a
  // second tap. Only on an explicit expand (not "Expand all", which would pull
  // every page in the list), and once per card, so a page that won't extract
  // leaves the button to retry rather than looping.
  let autoFetched = false;
  $effect(() => {
    if (!isFollowLink || !expanded || autoFetched || !canFetchOriginal) return;
    autoFetched = true;
    untrack(() => linkPostContentStore.fetch(itemUrl));
  });

  function handleOverflowFetchOriginal() {
    overflowMenuOpen = false;
    handleFetchOriginal();
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

  // Curated edition (Collection): the count of gathered pieces drives the quiet
  // "Edition · N" marker in the title row and keeps the Reader action available.
  let collectionPieceCount = $derived(document?.readerCollection?.items.length ?? 0);
  let collection = $derived(document?.readerCollection);

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
    // While the preview is clamped *and overflowing* (`isTruncated`), a footnote
    // number is visible but its list entry is below the clamp: let the tap expand
    // the card instead of jumping to something the reader can't see. A preview
    // that fits keeps the jump — handleContentTap deliberately does nothing in
    // that state, so suppressing it there would leave a dead tap.
    footnoteJump: () => !(selected && !expanded && isTruncated),
  });

  // Highlights hook
  const highlights = useHighlights({
    contentEl: () => bodyEl,
    itemKey: () => itemGuid,
    itemType: () => itemTagType as ItemLabelType,
    enabled: () => isOpen && hasContent,
    itemUrl: () => itemUrl,
    itemTitle: () => itemTitle,
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

  // Attach highlights whenever the card is open (selected preview or expanded) so
  // text can be selected/highlighted and existing highlights render — not only
  // when expanded. Read `isOpen` synchronously so Svelte's $effect tracks it
  // (reads inside tick().then() are not tracked).
  $effect(() => {
    if (isOpen && bodyEl && hasContent) {
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
    // Re-detect when the body settles: displayContent starts as a short fallback
    // and grows once the full body lazy-loads from IndexedDB, so the observer must
    // re-bind against the final paragraphs (hasContent alone stays true the whole
    // time and wouldn't re-trigger).
    void displayContent;
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
    // Don't hijack keys while typing in an input/textarea/contenteditable
    // (e.g. the share note box) — `h` must type, not toggle a highlight.
    if (isInputFocused()) return;

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

  // While the composer drawer is open for this article, the highlight popover
  // offers "quote in your share draft" — select text (or tap a highlight) and
  // it lands in the draft as a quote block.
  let composerOpenHere = $derived(shareUrl ? shareComposerStore.isOpenFor(shareUrl) : false);

  function quoteSelectionToShare() {
    const state = highlights.popoverState;
    if (!state) return;
    const text =
      state.pendingSelector?.exact ??
      (state.highlightId
        ? itemLabelsStore.getHighlights(itemGuid).find((h) => h.id === state.highlightId)?.selector
            .exact
        : undefined);
    if (text) shareComposerStore.appendQuote(text);
  }

  // What a Semble card / Margin bookmark records about this item. Mirrors
  // extractSembleMetadata's shape for the display-item surfaces.
  let integrationTarget = $derived({
    url: itemUrl,
    title: itemTitle,
    description: article?.summary ?? document?.description,
    author: article?.author,
    publishedAt: itemPublishedAt || undefined,
  });

  function saveToSemble() {
    integrationSaveStore.openPicker('semble', integrationTarget);
  }

  // Drawing an edge from this article. Gated like the Semble save lane (signed
  // in), and handed the card page the panel resolved: Semble keys cards by exact
  // URL string, so that variant is the one an edge has to name to roll up there.
  function createConnection() {
    sembleConnectionStore.openFor({
      url: itemUrl,
      title: itemTitle,
      cardUrl: atmosphere.sembleContext?.cardUrl ?? null,
    });
  }

  function saveToMargin() {
    integrationSaveStore.openPicker('margin', {
      url: integrationTarget.url,
      title: integrationTarget.title,
      description: integrationTarget.description,
    });
  }

  function handleOverflowSemble() {
    overflowMenuOpen = false;
    saveToSemble();
  }

  function handleOverflowMargin() {
    overflowMenuOpen = false;
    saveToMargin();
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
  followSharers={followSharersVM}
  {isFollowLink}
  followLinkCard={followLinkCardVM}
  socialContext={socialContext ? { quoteCount: socialContext.quoteCount } : undefined}
  laneRow={atmosphere.laneRow}
  filters={atmosphere.filters}
  activeFilter={atmosphere.activeFilter}
  stream={atmosphere.stream}
  sembleContext={atmosphere.sembleContext}
  {itemTagCount}
  {itemTags}
  {collectionPieceCount}
  {collection}
  {isRead}
  {isSaved}
  {selected}
  {expanded}
  {isOpen}
  {highlighted}
  {isTruncated}
  {canExpand}
  {currentlyShared}
  canShare={showShareAction}
  {canRecommend}
  {isRecommended}
  {currentNote}
  {hasShareDraft}
  {showActionBarIntegrations}
  {overflowMenuOpen}
  {showFetchOriginal}
  {showFetchOriginalMenu}
  {fetchingOriginal}
  {hasFetchedOriginal}
  {canFollowSource}
  hasSaveToSemble={Boolean(auth.user)}
  hasSaveToMargin={Boolean(auth.user)}
  hasOpenFullscreen={Boolean(onOpenFullscreen)}
  bind:bodyEl
  bind:tagBtnRef
  bind:overflowTriggerRef
  onHeaderClick={handleHeaderClick}
  onContentTap={handleContentTap}
  onToggleRead={() => onToggleRead?.()}
  onToggleSave={() => onToggleSave?.()}
  onToggleRecommend={toggleRecommend}
  onOpenUrl={handleOpenUrl}
  onOpenFullscreen={() => onOpenFullscreen?.()}
  {onOpenCollectionPiece}
  onSaveCollectionPiece={saveCollectionPiece}
  {isCollectionPieceSaved}
  onOpenLinkMenu={(rect) =>
    linkInterception.openMenu({ url: itemUrl, linkText: itemTitle, anchorRect: rect })}
  onExpandToggle={() => onExpand?.()}
  onTagClick={handleTagClick}
  onOverflowClick={handleOverflowClick}
  onOverflowOpenUrl={handleOverflowOpenUrl}
  onFetchOriginal={handleFetchOriginal}
  onOverflowFetchOriginal={handleOverflowFetchOriginal}
  onOverflowTag={handleOverflowTag}
  onOverflowSemble={handleOverflowSemble}
  onOverflowMargin={handleOverflowMargin}
  onSaveToSemble={saveToSemble}
  onSaveToMargin={saveToMargin}
  onFollowSource={handleFollowSource}
  onSelectFilter={atmosphere.setFilter}
  onOpenStream={atmosphere.openStream}
  onNearViewport={handleNearViewport}
  onRetryStream={atmosphere.retry}
  onCreateInLane={createInLane}
  onComposeShare={composeShare}
  onEditShare={editShare}
  onOpenAuthor={(did) => sidebarStore.openAddFeedModalForDid(did)}
  onSaveConnection={auth.user ? toggleSavedLink : undefined}
  onCreateConnection={auth.user && itemUrl ? createConnection : undefined}
  isConnectionSaved={(url) => savesStore.isSaved(url)}
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
      getAnchorRect={highlights.popoverAnchorRect}
      onHighlight={highlights.createHighlightFromPopover}
      onHighlightToMargin={highlights.createHighlightFromPopoverToMargin}
      onRemove={highlights.removeHighlightFromPopover}
      onSaveToMargin={highlights.savePopoverHighlightToMargin}
      onPostToBluesky={highlights.postPopoverHighlightToBluesky}
      onSaveNote={highlights.saveNoteFromPopover}
      onQuoteToShare={composerOpenHere ? quoteSelectionToShare : undefined}
      existingNote={highlights.popoverHighlightNote}
      marginSaved={highlights.popoverHighlightSavedToMargin}
      onClose={highlights.closePopover}
    />
  {/if}

  {#if highlights.selectedHighlightId}
    <HighlightHandles
      highlightId={highlights.selectedHighlightId}
      contentEl={() => bodyEl}
      onAdjust={(range) => highlights.adjustHighlightRange(highlights.selectedHighlightId!, range)}
    />
  {/if}

  {#if highlights.notePeek}
    <NotePeek note={highlights.notePeek.note} anchorRect={highlights.notePeek.anchorRect} />
  {/if}
{/if}
