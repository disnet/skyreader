<!--
  DIRECTION CONTRACT — Your Linkblog

  THESIS: This page is not a feed of things to read, it is a page of things you
  wrote. Each entry is the post itself, laid out the way the composer that wrote
  it is laid out. It refuses the river's collapsed row, its bottom action bar,
  its read/unread dot, and the "Shared by" attribution on your own publication.

  OWN-WORLD: Skyreader's flat system, unchanged. Published entries are separated
  by rhythm alone, never rules or boxes, and fill the page's 800px band. The
  headline and the closing meta row are chrome, sized exactly like a row in the
  river so the two pages read as one app; only your prose carries the reader's
  own article face, because your commentary is the one thing here that is
  actually prose. Quotes keep the gold quotation rule. A draft IS boxed — it is
  pinned above the stream, where a post-shaped thing that isn't posted would
  otherwise pass for published; a flat tint and a hairline, no shadow.

  STORY: You see what you published, recognize your own voice, and can fix a
  sentence or kill a post without leaving the page.

  FIRST VIEWPORT: Masthead with the public address, then any unposted drafts
  pinned on their own tinted panels, then published entries newest first; each
  reads top-down as a post — headline, your prose, then a quiet
  source-time-and-actions row closing it.

  FORM: Editing hands off to the real composer drawer rather than reproducing it
  inline. The drawer is non-modal and survives navigation, so an edit stays open
  while you go back and reread the article it is about. A local extension of an
  established surface, so the visual world is inherited rather than rolled.
-->
<script lang="ts">
  // One entry on your own linkblog: a published `site.standard.document` link
  // post, or a local ShareDraft that has not been posted yet. Both render in the
  // same shape — the headline, your commentary, your quotes, the source row —
  // and both hand editing to the shared ShareComposer drawer, which is mounted
  // once in AppShell. That drawer outlives this page, so you can open the article
  // and reread it with your draft still sitting there.
  import { marked } from 'marked';
  import Icon from '$lib/components/Icon.svelte';
  import PopoverMenu from '$lib/components/PopoverMenu.svelte';
  import { api } from '$lib/services/api';
  import { auth } from '$lib/stores/auth.svelte';
  import { myLinkblogStore } from '$lib/stores/myLinkblog.svelte';
  import { shareComposerStore } from '$lib/stores/shareComposer.svelte';
  import { shareDraftsStore } from '$lib/stores/shareDrafts.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { getFaviconUrl } from '$lib/utils/favicon';
  import {
    getExternalArticleLink,
    getLinkPostNote,
    getLinkPostNoteMentions,
    isSkyreaderShare,
    linkifyNoteMentions,
  } from '$lib/utils/linkPost';
  import { blocksToNote } from '$lib/utils/shareNote';
  import { sanitizeHtml } from '$lib/utils/sanitize';
  import { formatRelativeDate } from '$lib/utils/date';
  import type { Article, ShareDraft, SocialDocument } from '$lib/types';

  interface Props {
    /** A published link post. Mutually exclusive with `draft`. */
    doc?: SocialDocument;
    /** An unposted local draft. Mutually exclusive with `doc`. */
    draft?: ShareDraft;
    /** Open the linked article in the in-app reader (published entries only). */
    onOpenReader?: () => void;
  }

  let { doc, draft, onOpenReader }: Props = $props();

  let isDraft = $derived(Boolean(draft));

  // ── What the entry points at ────────────────────────────────────────────────
  let articleUrl = $derived(
    draft ? draft.articleUrl : doc ? (getExternalArticleLink(doc) ?? doc.canonicalUrl ?? '') : ''
  );
  let articleTitle = $derived(
    draft ? (draft.articleTitle ?? draft.articleUrl) : (doc?.title ?? '')
  );
  let faviconUrl = $derived(articleUrl ? getFaviconUrl(articleUrl) : '');
  let domain = $derived.by(() => {
    if (!articleUrl) return '';
    try {
      return new URL(articleUrl).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  });

  // ── The note ────────────────────────────────────────────────────────────────
  // A draft's note is serialized from its blocks so a draft and a post read
  // identically before one of them is public.
  let note = $derived(draft ? blocksToNote(draft.blocks) : doc ? (getLinkPostNote(doc) ?? '') : '');
  let mentions = $derived(doc ? getLinkPostNoteMentions(doc) : []);
  // Notes are authored in a tiny Markdown subset: '> ' quotes, everything else
  // prose. Splice profile links over @mention facets, parse, then sanitize.
  let noteHtml = $derived(
    note.trim()
      ? sanitizeHtml(
          marked.parse(linkifyNoteMentions(note, mentions), {
            gfm: true,
            breaks: true,
            async: false,
          }) as string
        )
      : ''
  );

  // ── Timeline ────────────────────────────────────────────────────────────────
  let stamp = $derived(
    draft ? new Date(draft.updatedAt).toISOString() : (doc?.publishedAt ?? doc?.createdAt ?? '')
  );
  // A dateline, not a feed timestamp: recent entries read relatively, older ones
  // take their calendar date, which is what a ledger of your own posts wants.
  let dateLabel = $derived.by(() => {
    const d = new Date(stamp);
    if (isNaN(d.getTime())) return '';
    const ageDays = (Date.now() - d.getTime()) / 86400000;
    if (ageDays < 7) return formatRelativeDate(stamp);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      ...(sameYear ? {} : { year: 'numeric' }),
    });
  });

  // ── What you're allowed to do to it ─────────────────────────────────────────
  // A connected publication can hold posts its own app wrote. Those are listed,
  // but Skyreader has no business rewriting or deleting them.
  let ownRkey = $derived(doc ? (doc.recordUri.split('/').pop() ?? '') : '');
  let canEdit = $derived(
    isDraft || Boolean(doc && auth.user && doc.authorDid === auth.user.did && isSkyreaderShare(doc))
  );
  // The entry's own address on your public page. Absent while the page is turned
  // off — there'd be nothing at the other end of the link.
  let permalink = $derived.by(() => {
    if (isDraft || !ownRkey) return null;
    if (myLinkblogStore.publication?.pageHidden === true) return null;
    const base = myLinkblogStore.publicUrl();
    return base ? `${base.replace(/\/$/, '')}/${ownRkey}` : null;
  });

  // Whether the drawer is currently holding this entry, so the row can say so.
  let inComposer = $derived(Boolean(articleUrl) && shareComposerStore.isOpenFor(articleUrl));

  // ── Editing: hand off to the drawer ─────────────────────────────────────────
  function entryArticle(): Article {
    return {
      subscriptionId: 0,
      guid: doc?.recordUri ?? articleUrl,
      url: articleUrl,
      title: articleTitle,
      summary: doc?.description,
      imageUrl: doc?.coverImageCid
        ? `https://cdn.bsky.app/img/feed_fullsize/plain/${doc.authorDid}/${doc.coverImageCid}@jpeg`
        : undefined,
      publishedAt: doc?.publishedAt ?? new Date().toISOString(),
      fetchedAt: Date.now(),
    };
  }

  function startEditing() {
    if (!canEdit) return;
    // A draft reopens as the draft it is (create mode, autosaved, Post to
    // publish). A posted entry opens in edit mode against the live record.
    if (draft) {
      shareComposerStore.openDraft(draft);
      return;
    }
    shareComposerStore.open({
      article: entryArticle(),
      itemKey: doc?.recordUri,
      mode: 'edit',
      initialNote: note,
      submit: submitNote,
    });
  }

  // The linkblog's own write path: edit by rkey, because the entry may live in a
  // connected publication the URL-keyed share store can't reach.
  async function submitNote(next: string) {
    // Throw rather than return: the composer reads a resolved submit as "your
    // edit is saved" and closes on it, so returning quietly here would drop the
    // user's words and tell them it worked.
    if (!ownRkey || !doc) throw new Error('This post has no record to edit.');
    const trimmed = next.trim();
    await api.updateLinkblogShareNote(ownRkey, trimmed);
    // Reflect it in the listed document so this page updates ahead of the next
    // pull; `note` re-derives from it.
    myLinkblogStore.setNote(doc.recordUri, trimmed);
  }

  // ── Menu actions ────────────────────────────────────────────────────────────
  let menuOpen = $state(false);
  let confirmingDelete = $state(false);
  let deleteTimer: ReturnType<typeof setTimeout> | undefined;

  async function copyPermalink() {
    if (!permalink) return;
    try {
      await navigator.clipboard.writeText(permalink);
      toastStore.update(toastStore.add('Link copied'), 'success');
    } catch {
      // Clipboard is unavailable in an insecure context; say so rather than
      // failing silently, since nothing visible changed.
      toastStore.update(toastStore.add('Could not copy link'), 'error');
    }
  }

  function openInBrowser() {
    if (articleUrl) window.open(articleUrl, '_blank', 'noopener');
  }

  function handleDeleteRequest() {
    if (!confirmingDelete) {
      confirmingDelete = true;
      deleteTimer = setTimeout(() => (confirmingDelete = false), 4000);
      return;
    }
    clearTimeout(deleteTimer);
    confirmingDelete = false;
    menuOpen = false;
    void performDelete();
  }

  async function performDelete() {
    // Deleting what the drawer is holding would leave it editing a record that
    // no longer exists.
    if (articleUrl && shareComposerStore.isOpenFor(articleUrl)) shareComposerStore.close();
    if (draft) {
      await shareDraftsStore.remove(draft.articleUrl);
      return;
    }
    if (!doc || !ownRkey) return;
    const recordUri = doc.recordUri;
    try {
      await api.deleteLinkblogShare(ownRkey);
      myLinkblogStore.removeByRecordUri(recordUri);
    } catch (e) {
      console.error('Failed to delete linkblog post:', e);
      toastStore.update(toastStore.add('Could not delete the post'), 'error');
    }
  }

  let menuItems = $derived.by(() => {
    const items: Array<{
      label: string;
      icon?: string;
      variant?: 'default' | 'danger';
      keepOpen?: boolean;
      onclick: () => void;
    }> = [];
    if (onOpenReader && !isDraft) {
      items.push({ label: 'Read in Skyreader', icon: 'maximize', onclick: () => onOpenReader() });
    }
    items.push({ label: 'Open in browser', icon: 'external-link', onclick: openInBrowser });
    if (permalink) {
      items.push({ label: 'Copy post link', icon: 'link', onclick: () => void copyPermalink() });
    }
    if (canEdit) {
      items.push({
        label: confirmingDelete
          ? isDraft
            ? 'Discard draft?'
            : 'Delete post?'
          : isDraft
            ? 'Discard draft'
            : 'Delete post',
        icon: 'trash',
        variant: 'danger',
        keepOpen: !confirmingDelete,
        onclick: handleDeleteRequest,
      });
    }
    return items;
  });

  // Reset the delete confirm when the menu closes, so reopening it doesn't
  // present an armed destructive item.
  $effect(() => {
    if (!menuOpen && confirmingDelete) {
      clearTimeout(deleteTimer);
      confirmingDelete = false;
    }
  });
</script>

<article class="entry" class:draft={isDraft} class:editing={inComposer} class:menu-open={menuOpen}>
  <div class="entry-column">
    <!-- The headline leads, the way a post's headline does — but as the same row
         title the river uses, not a display size of its own. Your prose below it
         is the reading content; the headline names what the post is about. -->
    <header class="entry-head">
      {#if isDraft}
        <!-- Desktop only. At phone width the same chip renders in the meta row
             below instead, where there's room for it. -->
        <span class="entry-chip entry-chip-head">Draft</span>
      {/if}
      <a
        class="entry-title"
        href={articleUrl}
        target="_blank"
        rel="noopener"
        title={articleUrl}
        onclick={(e) => {
          // The title opens the article in Skyreader's reader; a modified or
          // middle click is the browser's to handle, so it still opens a tab.
          if (!onOpenReader || isDraft) return;
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
          onOpenReader();
        }}>{articleTitle}</a
      >
    </header>

    {#if noteHtml}
      <!-- eslint-disable-next-line svelte/no-at-html-tags -->
      <div class="entry-note">{@html noteHtml}</div>
    {:else}
      <p class="entry-bare">
        {isDraft ? 'No commentary yet.' : 'Shared without a comment.'}
      </p>
    {/if}

    <!-- The row that closes the entry: where the post points and when it went up
         on the left, what you can do to it on the right. The article's title is
         the headline above, so this row carries the domain alone rather than
         repeating it truncated. The time lives here with the rest of the meta,
         out of the gap between the headline and your words. -->
    <footer class="entry-foot">
      <div class="entry-meta">
        {#if isDraft}
          <!-- Phone only; the desktop chip leads the headline. -->
          <span class="entry-chip entry-chip-meta">Draft</span>
        {/if}
        <a
          class="entry-source"
          href={articleUrl}
          target="_blank"
          rel="noopener"
          title={articleUrl}
          aria-label={domain ? `Open ${articleTitle} at ${domain}` : `Open ${articleTitle}`}
        >
          {#if faviconUrl}<img src={faviconUrl} alt="" class="entry-source-favicon" />{/if}
          <span class="entry-source-domain">{domain || 'Open link'}</span>
        </a>
        {#if dateLabel}
          <span class="entry-date">{isDraft ? `edited ${dateLabel}` : dateLabel}</span>
        {/if}
      </div>
      <div class="entry-actions">
        {#if canEdit}
          <button
            type="button"
            class="entry-edit"
            class:active={inComposer}
            title={inComposer ? 'Open in the composer below' : 'Edit this post'}
            onclick={startEditing}
          >
            <Icon name="edit" size={15} />
            <span class="entry-edit-label">{inComposer ? 'Editing' : 'Edit'}</span>
          </button>
        {/if}
        <PopoverMenu items={menuItems} bind:open={menuOpen} />
      </div>
    </footer>
  </div>
</article>

<style>
  /* Published entries are separated by rhythm alone — no rules, no boxes. A
     linkblog is a page of posts, not a grid of cards, and the next headline is
     emphatic enough to end the one above it without a line's help. */
  .entry {
    padding: 2rem 0;
  }

  /* Drafts are the exception, and they earn it: pinned above the stream, they'd
     otherwise read as posts you already published. A tinted panel says "not out
     yet" at a glance and groups the pinned run into one block. Flat — a tint and
     a hairline, no shadow: nothing here floats. */
  .entry.draft {
    padding: 1.5rem 1.25rem;
    margin: 0.5rem 0;
    background: var(--color-bg-secondary);
    border: 1px solid var(--color-border);
    border-radius: 10px;
  }

  /* Consecutive drafts stack as one block rather than a ladder of gaps. */
  .entry.draft + :global(.entry.draft) {
    margin-top: -0.25rem;
  }

  /* The entry fills the page's 800px band, like every other surface in the app.
     Chrome face by default — the headline and the meta row are UI, sized like
     the river's rows so the two pages read as one app; the note re-declares the
     reader's article face, because your commentary is the one thing here that is
     actually prose. */
  .entry-column {
    display: flex;
    flex-direction: column;
    min-width: 0;
    font-family: var(--font-sans-serif);
  }

  /* The chip sits on the headline's line, not above it. */
  .entry-head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    min-width: 0;
  }

  /* ── The headline ─────────────────────────────────────────────────────────
     The same title as a row in the river: system sans at --text-base, regular
     weight. It is a fixed UI size rather than tracking the reader's article
     size, so it stays in step with the meta row it shares the entry with — and
     so moving between the linkblog and the feed doesn't re-scale the titles. */
  .entry-title {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    min-width: 0;
    font-family: var(--font-sans-serif);
    font-size: var(--text-base);
    font-weight: var(--weight-regular);
    line-height: var(--leading-snug);
    color: var(--color-text);
    text-decoration: none;
    text-wrap: pretty;
    overflow-wrap: break-word;
    transition: color 0.15s;
  }

  .entry-title:hover {
    color: var(--color-primary);
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .entry-title:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
    border-radius: 2px;
  }

  /* On the tinted draft panel a filled chip would compete with the title, so it
     reads as a quiet label in the app's own blue — the surface already says
     "draft", this just names it. It leads the headline on desktop and the meta
     row on a phone; rendered in both places, one hidden per breakpoint, because
     the two live under different parents and can't be reordered by CSS. */
  .entry-chip {
    flex-shrink: 0;
    align-self: center;
    padding: 2px 7px;
    border-radius: 999px;
    background: var(--color-sidebar-active);
    color: var(--color-primary);
    font-size: var(--text-2xs);
    font-weight: var(--weight-medium);
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
  }

  .entry-chip-meta {
    display: none;
  }

  /* ── The closing row ──────────────────────────────────────────────────────
     Where the post points and when it went up, and what you can do to it. */
  .entry-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    min-width: 0;
    margin-top: 1rem;
    font-family: var(--font-sans-serif);
    font-size: var(--text-sm);
  }

  /* Domain and time, one group: the facts about the post, in the river's own
     meta size. The domain gives up width before the time does — a truncated
     host still identifies the source, a truncated date says nothing. */
  .entry-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    color: var(--color-text-secondary);
  }

  .entry-date {
    flex-shrink: 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    font-variant-numeric: tabular-nums;
  }

  /* A dot between the source and the time, the way the river separates its own
     meta. Drawn by the row, so it never appears with nothing after it. */
  .entry-date::before {
    content: '·';
    margin-right: 0.5rem;
  }

  .entry-source {
    display: inline-flex;
    align-items: center;
    gap: 0.4375rem;
    min-width: 0;
    padding: 0.375rem 0.5rem;
    margin-left: -0.5rem;
    border-radius: 6px;
    color: var(--color-text-secondary);
    text-decoration: none;
    transition:
      background-color 0.15s,
      color 0.15s;
  }

  .entry-source:hover {
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }

  .entry-source:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  .entry-source-favicon {
    flex-shrink: 0;
    width: 14px;
    height: 14px;
    border-radius: 3px;
  }

  .entry-source-domain {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .entry-actions {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.25rem;
  }

  /* On a mouse, the controls are quiet until you reach for the post they act on:
     the page at rest is your writing, not a column of buttons beside it. They
     stay put for touch, for keyboard focus, and whenever an entry is actually
     open in the composer or holding its menu — a control you are using never
     fades out from under you. Opacity only, so tab order is unchanged.

     Bounded below 641px as well as by pointer: a hybrid device can report a fine
     pointer while being used by thumb, and at phone width there is no hover to
     reveal anything with. */
  @media (hover: hover) and (pointer: fine) and (min-width: 641px) {
    .entry-actions {
      opacity: 0;
      transition: opacity 0.15s;
    }

    .entry:hover .entry-actions,
    .entry:focus-within .entry-actions,
    .entry.editing .entry-actions,
    .entry.menu-open .entry-actions {
      opacity: 1;
    }
  }

  .entry-edit {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.5rem;
    background: none;
    border: none;
    border-radius: 6px;
    color: var(--color-text-secondary);
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    cursor: pointer;
    transition:
      background-color 0.15s,
      color 0.15s;
  }

  .entry-edit:hover {
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }

  .entry-edit:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  /* Tells you which entry the drawer at the bottom of the screen is holding. */
  .entry-edit.active,
  .entry-edit.active:hover {
    background: var(--color-sidebar-active);
    color: var(--color-primary);
  }

  /* ── Your words ───────────────────────────────────────────────────────────
     The one thing on this page that is genuinely yours reads in the article
     face at reading size — the same typography the reader gives an article,
     because on your own linkblog your commentary IS the article. */
  /* No width cap: the note has to be the exact width the textarea that replaces
     it will be, or the text reflows the moment you click Edit. The page's 800px
     band is the measure, as it is for article prose everywhere else. */
  .entry-note {
    margin-top: 0.875rem;
    font-family: var(--article-font);
    font-size: var(--article-font-size);
    line-height: 1.7;
    color: var(--color-text);
    overflow-wrap: break-word;
  }

  .entry-note :global(> :first-child) {
    margin-top: 0;
  }

  .entry-note :global(> :last-child) {
    margin-bottom: 0;
  }

  .entry-note :global(p) {
    margin: 0 0 0.75rem;
  }

  .entry-note :global(a) {
    color: var(--color-primary);
  }

  .entry-note :global(ul),
  .entry-note :global(ol) {
    margin: 0 0 0.75rem;
    padding-left: 1.5rem;
  }

  .entry-note :global(li) {
    margin: 0.125rem 0;
  }

  /* The gold quotation rule, matching the composer's quote block exactly: a
     quote looks the same when you wrote it and after you posted it. */
  .entry-note :global(blockquote) {
    margin: 0 0 0.75rem;
    padding: 0.125rem 0 0.125rem 0.875rem;
    border-left: 3px solid color-mix(in srgb, #f5c518 70%, transparent);
    color: var(--color-text-secondary);
  }

  .entry-note :global(blockquote > :last-child) {
    margin-bottom: 0;
  }

  .entry-note :global(code) {
    font-family: var(--font-mono, monospace);
    font-size: 0.9em;
    padding: 0.1em 0.3em;
    background: var(--color-bg-secondary);
    border-radius: 4px;
  }

  .entry-note :global(pre) {
    margin: 0 0 0.75rem;
    padding: 0.75rem;
    overflow-x: auto;
    background: var(--color-bg-secondary);
    border-radius: 6px;
  }

  .entry-note :global(pre code) {
    background: none;
    padding: 0;
  }

  .entry-bare {
    margin: 0.875rem 0 0;
    font-size: var(--text-md);
    font-style: italic;
    color: var(--color-text-secondary);
  }

  @media (max-width: 640px) {
    /* Phone width: the entry keeps its shape. The one move is the Draft chip,
       which drops to the meta row so the headline gets the full width of a
       narrow column. What else changes is the touch target: the actions grow to
       the 44px floor, and the Edit label stays visible because the row has room
       for it. */
    .entry {
      padding: 1.5rem 0;
    }

    .entry.draft {
      padding: 1.25rem 1rem;
    }

    .entry-foot {
      min-height: 44px;
    }

    .entry-source,
    .entry-edit {
      min-height: 40px;
      padding-inline: 0.625rem;
    }

    .entry-source {
      margin-left: -0.625rem;
    }

    /* The chip moves down to the meta row, where the headline has the full width
       to itself and the status still reads at a glance. */
    .entry-chip-head {
      display: none;
    }

    .entry-chip-meta {
      display: inline-flex;
      align-items: center;
    }

    /* The source's negative margin exists to sit its text on the column's left
       edge. With the chip ahead of it, the chip owns that edge instead — leaving
       the pull in would crowd the two together. */
    .entry-chip-meta + .entry-source {
      margin-left: 0;
    }

    .entry-actions :global(.menu-trigger) {
      width: 40px;
      height: 40px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .entry-edit,
    .entry-title,
    .entry-source,
    .entry-actions {
      transition: none;
    }
  }
</style>
