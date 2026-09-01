// The share composer session: one global, non-modal drawer for drafting a
// linkblog share (or editing a posted one). Opened from any surface — feed
// card, reader chrome, saved list, drafts list — and mounted once in AppShell,
// so a draft survives closing the reader or navigating while it's open.
//
// Create mode edits a local ShareDraft (auto-saved to IndexedDB, public only on
// Post). Edit mode edits the note of an already-posted share; those edits go to
// the live record on Update and are not drafted.

import { linkblogStore } from '$lib/stores/linkblog.svelte';
import { preferences } from '$lib/stores/preferences.svelte';
import { shareDraftsStore } from '$lib/stores/shareDrafts.svelte';
import { blocksToNote, noteToBlocks, draftHasContent, draftWordCount } from '$lib/utils/shareNote';
import type { Article, ShareDraft, ShareDraftBlock } from '$lib/types';

export interface ComposerOpenOptions {
  article: Article;
  /** at:// URI of the source document for a quote-reshare. */
  repostUri?: string;
  /** Key highlights are stored under (guid / recordUri) for the quote picker. */
  itemKey?: string;
  /** 'edit' reopens a posted share's note; 'create' drafts a new share. */
  mode?: 'create' | 'edit';
  /** Edit mode: the posted note to load into the composer. */
  initialNote?: string;
  /**
   * Custom submit for surfaces whose write path isn't the default
   * linkblogStore one (e.g. editing your own post on /linkblog by rkey).
   * Receives the serialized note ('' clears).
   */
  submit?: (note: string) => Promise<void> | void;
  /**
   * Edit mode: unshare this article. The composer owns removal now that the
   * note no longer sits under the article — the Share control opens the
   * composer, and taking the share down happens here. Defaults to
   * `linkblogStore.unshare(article.url)`.
   */
  remove?: () => Promise<void> | void;
}

interface ComposerSession {
  article: Article;
  repostUri?: string;
  itemKey?: string;
  mode: 'create' | 'edit';
  submit?: (note: string) => Promise<void> | void;
  remove?: () => Promise<void> | void;
}

function createShareComposerStore() {
  let session = $state<ComposerSession | null>(null);
  let blocks = $state<ShareDraftBlock[]>([]);
  let minimized = $state(false);
  let posting = $state(false);
  // "Posted from skyreader.app" on this post. Seeded from the sticky per-account
  // preference each time the drawer opens, so the choice carries between drafts
  // without following the article. Create mode only — v1 offers no way to add or
  // remove the line on an edit (delete and reshare covers it), and the backend
  // preserves whatever the record already has.
  let attribution = $state(false);
  let draftCreatedAt = 0;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  const note = $derived(blocksToNote(blocks));
  const quoteCount = $derived(blocks.filter((b) => b.kind === 'quote' && b.text.trim()).length);
  const wordCount = $derived(draftWordCount(blocks));
  const hasContent = $derived(draftHasContent(blocks));

  function currentDraft(): ShareDraft | null {
    if (!session || session.mode !== 'create') return null;
    const a = session.article;
    return {
      articleUrl: a.url,
      articleTitle: a.title,
      articleAuthor: a.author,
      articleSummary: a.summary,
      articleImage: a.imageUrl,
      articlePublishedAt: a.publishedAt,
      repostUri: session.repostUri,
      itemKey: session.itemKey,
      blocks,
      createdAt: draftCreatedAt,
      updatedAt: Date.now(),
    };
  }

  // Persist the create-mode draft, debounced off keystrokes. An emptied-out
  // draft deletes its row instead, so clearing the composer clears the marker.
  function persistDraft() {
    const draft = currentDraft();
    if (!draft) return;
    if (draftHasContent(draft.blocks)) void shareDraftsStore.save(draft);
    else void shareDraftsStore.remove(draft.articleUrl);
  }

  function touch() {
    if (!session || session.mode !== 'create') return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistDraft, 600);
  }

  function flush() {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    persistDraft();
  }

  function open(options: ComposerOpenOptions) {
    // Drafts hydrate with the app, but guard the race (and hosts that never
    // hydrate): make sure the store is loaded before resuming from it.
    void shareDraftsStore.load().then(() => openLoaded(options));
  }

  function openLoaded(options: ComposerOpenOptions) {
    const mode = options.mode ?? 'create';
    // Reopening the article already in the drawer just brings it forward.
    if (session && session.article.url === options.article.url && session.mode === mode) {
      minimized = false;
      return;
    }
    // Switching articles: keep whatever the previous draft held.
    if (session) flush();

    session = {
      article: options.article,
      repostUri: options.repostUri,
      itemKey: options.itemKey,
      mode,
      submit: options.submit,
      remove: options.remove,
    };
    minimized = false;
    posting = false;
    attribution = mode === 'create' && preferences.linkblogAttributionOn;

    if (mode === 'edit') {
      blocks = noteToBlocks(options.initialNote);
      draftCreatedAt = 0;
    } else {
      const existing = shareDraftsStore.get(options.article.url);
      draftCreatedAt = existing?.createdAt ?? Date.now();
      blocks = existing?.blocks.length
        ? existing.blocks.map((b) => ({ ...b }))
        : [{ kind: 'text', text: '' }];
      if (blocks[blocks.length - 1].kind !== 'text') blocks.push({ kind: 'text', text: '' });
    }
  }

  /** Resume a saved draft from the drafts list (no live Article in hand). */
  function openDraft(draft: ShareDraft) {
    open({
      article: {
        subscriptionId: 0,
        guid: draft.articleUrl,
        url: draft.articleUrl,
        title: draft.articleTitle ?? draft.articleUrl,
        author: draft.articleAuthor,
        summary: draft.articleSummary,
        imageUrl: draft.articleImage,
        publishedAt: draft.articlePublishedAt ?? new Date(draft.createdAt).toISOString(),
        fetchedAt: Date.now(),
      },
      repostUri: draft.repostUri,
      itemKey: draft.itemKey,
      mode: 'create',
    });
  }

  /** Whether the composer is open (expanded or minimized) for this article. */
  function isOpenFor(articleUrl: string): boolean {
    return Boolean(session && session.article.url === articleUrl);
  }

  /** Append a quoted passage to the draft (from the quote picker or a text
   *  selection in the article). Keeps a trailing text block to type into. */
  function appendQuote(text: string) {
    const quote = text.trim();
    if (!quote || !session) return;
    const last = blocks[blocks.length - 1];
    if (last && last.kind === 'text' && !last.text.trim()) {
      blocks.splice(blocks.length - 1, 0, { kind: 'quote', text: quote });
    } else {
      blocks.push({ kind: 'quote', text: quote });
      blocks.push({ kind: 'text', text: '' });
    }
    touch();
  }

  function removeBlock(index: number) {
    if (index < 0 || index >= blocks.length) return;
    blocks.splice(index, 1);
    if (blocks.length === 0 || blocks[blocks.length - 1].kind !== 'text') {
      blocks.push({ kind: 'text', text: '' });
    }
    touch();
  }

  /** Close the drawer. Create-mode content auto-saves as a draft. */
  function close() {
    if (session?.mode === 'create') flush();
    clearTimeout(saveTimer);
    session = null;
    blocks = [];
    minimized = false;
  }

  /** Throw away the draft and close. */
  async function discard() {
    clearTimeout(saveTimer);
    const url = session?.article.url;
    session = null;
    blocks = [];
    minimized = false;
    if (url) await shareDraftsStore.remove(url);
  }

  /**
   * Post (create) or update (edit) the share. The caller handles the
   * first-share public acknowledgment before calling this. Returns true only
   * when the words made it out; false leaves the drawer open with the draft
   * intact, so nothing the user wrote is lost to a failed write.
   */
  async function post(): Promise<boolean> {
    if (!session || posting) return false;
    posting = true;
    const noteText = note;
    const { article, repostUri, mode, submit } = session;
    try {
      if (submit) {
        await submit(noteText);
      } else if (mode === 'edit') {
        await linkblogStore.setNote(article.url, noteText);
      } else {
        // shareLink swallows write failures (it rolls its optimistic state back)
        // and no-ops on an article already shared — from another device, say,
        // reconciled in while this draft sat open. Both used to read as success
        // through `isShared`, which deleted the draft without the note ever
        // being written. So act on what it reports: a failure keeps the draft, a
        // duplicate attaches these words to the entry that already exists.
        const result = await linkblogStore.shareLink(
          article,
          noteText || undefined,
          repostUri,
          attribution
        );
        if (result === 'failed') return false;
        if (result === 'duplicate') await linkblogStore.setNote(article.url, noteText);
      }
      clearTimeout(saveTimer);
      if (mode === 'create') await shareDraftsStore.remove(article.url);
      session = null;
      blocks = [];
      minimized = false;
      return true;
    } catch (e) {
      console.error('Failed to post share:', e);
      return false;
    } finally {
      posting = false;
    }
  }

  /**
   * Edit mode: take the share down and close. Uses the host's own removal path
   * when it gave one (e.g. deleting your own /linkblog post by rkey), else the
   * URL-keyed unshare. Returns false if the write failed, leaving the drawer
   * open with the note intact.
   */
  async function removeShare(): Promise<boolean> {
    if (!session || session.mode !== 'edit' || posting) return false;
    posting = true;
    const { article, remove } = session;
    try {
      if (remove) await remove();
      else await linkblogStore.unshare(article.url);
      session = null;
      blocks = [];
      minimized = false;
      return true;
    } catch (e) {
      console.error('Failed to remove share:', e);
      return false;
    } finally {
      posting = false;
    }
  }

  return {
    open,
    openDraft,
    close,
    discard,
    post,
    removeShare,
    appendQuote,
    removeBlock,
    touch,
    isOpenFor,
    setMinimized(value: boolean) {
      minimized = value;
    },
    /** Tick or untick "Posted from Skyreader"; the choice sticks per account. */
    setAttribution(value: boolean) {
      attribution = value;
      preferences.setLinkblogAttributionOn(value);
    },
    get attribution() {
      return attribution;
    },
    get session() {
      return session;
    },
    get blocks() {
      return blocks;
    },
    get minimized() {
      return minimized;
    },
    get posting() {
      return posting;
    },
    get note() {
      return note;
    },
    get quoteCount() {
      return quoteCount;
    },
    get wordCount() {
      return wordCount;
    },
    get hasContent() {
      return hasContent;
    },
  };
}

export const shareComposerStore = createShareComposerStore();
