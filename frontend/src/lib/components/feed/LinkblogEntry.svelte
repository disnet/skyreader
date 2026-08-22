<!--
  DIRECTION CONTRACT — Your Linkblog

  THESIS: This page is not a feed of things to read, it is a page of things you
  wrote. Each entry is the post itself, laid out the way the composer that wrote
  it is laid out. It refuses the river's collapsed row, its bottom action bar,
  its read/unread dot, and the "Shared by" attribution on your own publication.

  OWN-WORLD: Skyreader's flat system, unchanged. Entries are separated by rhythm
  alone, never rules or boxes, and fill the page's 800px band. The header row is
  chrome in system sans; the words you wrote carry the reader's own article face.
  Quotes keep the gold quotation rule. Drafts sit on the Sunken layer; published
  entries sit on the true-white publication surface.

  STORY: You see what you published, recognize your own voice, and can fix a
  sentence or kill a post without leaving the page.

  FIRST VIEWPORT: Masthead with the public address, then entries newest first;
  each is a composer box — linked title left with date and controls right, your
  prose beneath, the link card closing it.

  FORM: Editing hands off to the real composer drawer rather than reproducing it
  inline. The drawer is non-modal and survives navigation, so an edit stays open
  while you go back and reread the article it is about. A local extension of an
  established surface, so the visual world is inherited rather than rolled.
-->
<script lang="ts">
  // One entry on your own linkblog: a published `site.standard.document` link
  // post, or a local ShareDraft that has not been posted yet. Both render in the
  // same shape — the linked title, your commentary, your quotes, the link card —
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

<article class="entry" class:draft={isDraft} class:editing={inComposer}>
  <div class="entry-column">
    <!-- The composer's own header: what the post is on the left, the controls
         that act on it on the right. -->
    <header class="entry-head">
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
      <div class="entry-controls">
        {#if isDraft}
          <span class="entry-chip">Draft</span>
        {/if}
        <span class="entry-date">{isDraft ? `edited ${dateLabel}` : dateLabel}</span>
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
    </header>

    {#if noteHtml}
      <!-- eslint-disable-next-line svelte/no-at-html-tags -->
      <div class="entry-note">{@html noteHtml}</div>
    {:else}
      <p class="entry-bare">
        {isDraft ? 'No commentary yet.' : 'Shared without a comment.'}
      </p>
    {/if}

    <!-- The card is the address: it goes to the article at its source, in a new
         tab. The title above reads it here instead. -->
    <a class="entry-link" href={articleUrl} target="_blank" rel="noopener" title={articleUrl}>
      {#if faviconUrl}<img src={faviconUrl} alt="" class="entry-link-favicon" />{/if}
      <span class="entry-link-title">{articleTitle}</span>
      {#if domain}<span class="entry-link-domain">{domain}</span>{/if}
    </a>
  </div>
</article>

<style>
  /* Entries are separated by rhythm alone — no rules, no boxes. A linkblog is a
     page of posts, not a grid of cards, and each entry already closes on its
     link card, which ends it without a line's help. */
  .entry {
    padding: 1.75rem 0;
  }

  /* A draft is not on the page yet, so it does not sit on the publication's
     white surface — it rests on the Sunken layer, inset from the column. */
  .entry.draft {
    margin: 0.5rem 0;
    padding: 1.25rem;
    background: var(--color-bg-secondary);
    border-radius: 8px;
  }

  /* The entry fills the page's 800px band, like every other surface in the app.
     It carries the article face so the headline and note can size themselves in
     `em` against the reader's chosen size; chrome re-declares the UI face. */
  .entry-column {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
    font-family: var(--article-font);
    font-size: var(--article-font-size);
  }

  .entry-head {
    font-family: var(--font-sans-serif);
    font-size: var(--text-sm);
  }

  /* The composer's header row: subject left, controls right. */
  .entry-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
    min-height: 32px;
  }

  /* Wraps rather than truncates: a domain clipped to "exa…" tells you nothing,
     so on a narrow entry the source drops to its own line instead. */
  .entry-chip {
    flex-shrink: 0;
    padding: 2px 7px;
    margin: 0.25rem 0.125rem 0.25rem 0;
    border-radius: 999px;
    background: var(--color-bg);
    color: var(--color-text-secondary);
    font-size: var(--text-2xs);
    font-weight: var(--weight-medium);
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
  }

  .entry-date {
    flex-shrink: 0;
    padding: 0.3125rem 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .entry-controls {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.375rem;
  }

  .entry-edit {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.3125rem 0.5rem;
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
    background: var(--color-bg);
    color: var(--color-text);
  }

  .entry.draft .entry-edit:hover {
    background: var(--color-bg);
  }

  .entry:not(.draft) .entry-edit:hover {
    background: var(--color-bg-secondary);
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
    margin: 0;
    font-size: var(--text-md);
    font-style: italic;
    color: var(--color-text-secondary);
  }

  /* ── The subject ──────────────────────────────────────────────────────────
     The linked title, in the header row where the composer names the article it
     is drafting against. UI sans at the Title step, because this row is chrome;
     the article face belongs to the words you wrote, below. Wraps to two lines
     rather than clipping — a linkblog entry is known by its title, and half of
     one is not a title. */
  .entry-title {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    min-width: 0;
    padding: 0.3125rem 0;
    font-family: var(--font-sans-serif);
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    line-height: var(--leading-snug);
    color: var(--color-text);
    text-decoration: none;
    overflow-wrap: break-word;
    transition: color 0.15s;
  }

  .entry-title:hover {
    color: var(--color-primary);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .entry-title:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
    border-radius: 2px;
  }

  /* ── The link card ────────────────────────────────────────────────────────
     The composer's own trailing card, so the entry reads as the finished post
     the composer promised: your words, then the article. */
  .entry-link {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.125rem;
    padding: 0.4375rem 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    font-family: var(--font-sans-serif);
    font-size: var(--text-sm);
    text-decoration: none;
    transition: background-color 0.15s;
  }

  .entry-link:hover {
    background: var(--color-bg-secondary);
  }

  .entry.draft .entry-link {
    background: var(--color-bg);
  }

  .entry.draft .entry-link:hover {
    border-color: var(--color-text-secondary);
  }

  .entry-link:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  .entry-link-favicon {
    flex-shrink: 0;
    width: 14px;
    height: 14px;
    border-radius: 3px;
  }

  .entry-link-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text);
    font-weight: var(--weight-medium);
  }

  .entry-link-domain {
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  @media (max-width: 640px) {
    /* The header can't hold a title and four controls at phone width — the title
       gets crushed to a couple of characters. Give it the whole first line and
       let the stamp and actions read as one meta line beneath it. */
    .entry-head {
      flex-wrap: wrap;
      gap: 0.125rem 0.5rem;
    }

    .entry-title {
      flex: 1 1 100%;
      padding-bottom: 0;
    }

    .entry-controls {
      flex: 1 1 100%;
    }

    .entry-edit-label {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .entry-edit,
    .entry-title,
    .entry-link {
      transition: none;
    }
  }
</style>
