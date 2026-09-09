<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import StaticPageChrome from '$lib/components/feed/StaticPageChrome.svelte';
  import {
    api,
    ScopeUpgradeError,
    FEEDBACK_IMAGE_MAX,
    FEEDBACK_IMAGE_MAX_BYTES,
    FEEDBACK_IMAGE_TYPES,
    type FeedbackBoard,
    type FeedbackImage,
    type FeedbackPost,
    type FeedbackReply,
  } from '$lib/services/api';
  import { auth } from '$lib/stores/auth.svelte';
  import { formatRelativeDate } from '$lib/utils/date';
  import {
    DEFAULT_FEEDBACK_TYPES,
    feedbackTypes,
    filterByStatusScope,
    hasClosedPosts,
    postRef,
    sortFeedbackPosts,
    statusLabel,
    type StatusScope,
  } from '$lib/utils/feedbackBoard';
  import {
    mergePendingPosts,
    prunePendingPosts,
    readPendingPosts,
    writePendingPosts,
    type PendingFeedbackPost,
  } from '$lib/utils/feedbackPending';

  const fallbackUrl = 'https://userinput.app/s/did:plc:ra4jsemddo2ii4pn5jaf6x4v/3mobgsd6d5n27';
  const TITLE_MAX = 300;
  const BODY_MAX = 10000;

  let loadState = $state<'loading' | 'loaded' | 'failed'>('loading');
  let board = $state<FeedbackBoard | null>(null);
  // Posts this reader wrote that upstream hasn't indexed yet, kept in local
  // storage so a reload still shows what they just filed.
  let pending = $state<PendingFeedbackPost[]>([]);
  /** One post's replies, once a reader has asked for them. */
  interface Thread {
    open: boolean;
    status: 'loading' | 'loaded' | 'failed';
    replies: FeedbackReply[];
  }
  // Keyed by post uri, and kept after a collapse: reopening a thread shouldn't
  // re-fetch what's already on the page.
  let threads = $state<Record<string, Thread>>({});
  // Post bodies the reader has opened, and the ones long enough to be worth
  // opening (see clampProbe). Both keyed by post uri.
  let openBodies = $state<Record<string, boolean>>({});
  let clampedBodies = $state<Record<string, boolean>>({});
  // Open by default: a board keeps everything it has ever finished, and a
  // reader arriving at one wants what is still live, not the archive.
  let statusScope = $state<StatusScope>('open');
  let sort = $state<'top' | 'new'>('top');

  // Whether this session may write an app.userinput.discussion record. Asked up
  // front so nobody writes a post only to be told their session can't send it.
  let postScopes = $state<'unknown' | 'granted' | 'missing'>('unknown');
  // Uploading an attachment needs one scope more than posting does, so a session
  // can be able to post and not to attach. Asked at the same time, for the same
  // reason: don't offer a control that can only fail.
  let imageScopes = $state(false);
  let composerOpen = $state(false);
  let draftTitle = $state('');
  let draftBody = $state('');
  let draftType = $state('');
  let posting = $state(false);
  let postError = $state<string | null>(null);
  let postedNote = $state(false);

  /**
   * An attachment in the composer. `blob` is null while its bytes are still on
   * their way to the reader's repo — the post waits for all of them, so a
   * half-uploaded picture can never be silently dropped from what gets written.
   */
  interface Attachment {
    id: number;
    file: File;
    previewUrl: string;
    alt: string;
    blob: FeedbackImage['image'] | null;
    error: string | null;
  }
  let attachments = $state<Attachment[]>([]);
  let attachmentError = $state<string | null>(null);
  let nextAttachmentId = 0;
  let fileInput = $state<HTMLInputElement | null>(null);
  let uploading = $derived(attachments.some((item) => !item.blob && !item.error));

  // The board's posts, plus this reader's own not-yet-indexed ones. Everything
  // below reads this rather than `board.posts`, so a pending post filters,
  // sorts and counts exactly like the row it will become.
  let allPosts = $derived(mergePendingPosts(board?.posts ?? [], pending, auth.user?.did));
  let pendingUris = $derived(new Set(pending.map((entry) => entry.post.uri)));
  // The vocabulary the rows label themselves with: the board's own types, plus
  // any a post still carries that the board has since dropped.
  let types = $derived(feedbackTypes(board?.types, allPosts));
  let composerTypes = $derived(board?.types?.length ? board.types : DEFAULT_FEEDBACK_TYPES);
  // What a post is filed under unless the reader says otherwise. A question is
  // the least presumptuous of the three: calling your own report a bug, or your
  // own idea a feature request, is a claim about the app that a question isn't.
  // Empty when the board's vocabulary has no such type, which is the one case
  // the composer still has to ask about.
  let defaultType = $derived(
    composerTypes.some((type) => type.value === 'question') ? 'question' : ''
  );
  // Keeps the draft's type inside the vocabulary actually on offer: it seeds the
  // default on load, restores it after a post, and rescues a stale selection if
  // the board changes its types under an open composer.
  $effect(() => {
    if (!composerTypes.some((type) => type.value === draftType)) draftType = defaultType;
  });
  // Which segment the picker's thumb sits over; -1 while nothing is chosen (a
  // board whose vocabulary gave us no default), where it isn't drawn at all.
  let selectedTypeIndex = $derived(composerTypes.findIndex((type) => type.value === draftType));
  let hasClosed = $derived(hasClosedPosts(allPosts));
  // The only filter on the board: what a post is filed under is a pill on its
  // row, not a way to cut the list down.
  let filtered = $derived(filterByStatusScope(allPosts, statusScope));
  // What the reader filed is the one part of the board they're tracking rather
  // than reading, so it sits above it in its own section — always newest first,
  // whatever the board itself is sorted by, because recency is what you want
  // from your own short list.
  //
  // Deliberately off `allPosts` rather than `filtered`: the status scope is a
  // way to browse someone else's board, and your own short list is not that.
  // A notification saying your post is now implemented links here, and under
  // the default open scope it would land on a page that hides the very post it
  // is about — with the row's own status pill saying which state it's in, there
  // is nothing left for the filter to tell you. It also keeps openOwnThreads
  // able to reach a reply on a post the board has since closed.
  let myPosts = $derived(
    auth.user?.did
      ? sortFeedbackPosts(
          allPosts.filter((post) => post.author.did === auth.user?.did),
          'new'
        )
      : []
  );
  let visiblePosts = $derived(
    sortFeedbackPosts(
      auth.user?.did ? filtered.filter((post) => post.author.did !== auth.user?.did) : filtered,
      sort
    )
  );

  function authorLabel(post: FeedbackPost): string {
    return post.author.handle.startsWith('did:') ? post.author.handle : `@${post.author.handle}`;
  }

  /** A `<select>` hands back a string; only these three are a scope. */
  function toScope(value: string): StatusScope {
    return value === 'closed' || value === 'all' ? value : 'open';
  }

  function typeLabel(value: string): string {
    return types.find((type) => type.value === value)?.label ?? value;
  }

  function replyAuthorLabel(reply: FeedbackReply): string {
    if (reply.author.displayName) return reply.author.displayName;
    return reply.author.handle.startsWith('did:') ? reply.author.handle : `@${reply.author.handle}`;
  }

  /**
   * The board's own count until the thread is loaded, and the loaded one after:
   * upstream counts replies this page won't show, since a hidden or banned one
   * is filtered out on the way through.
   */
  function replyLabel(post: FeedbackPost): string {
    const thread = threads[post.uri];
    const count = thread?.status === 'loaded' ? thread.replies.length : post.replyCount;
    return `${count} ${count === 1 ? 'reply' : 'replies'}`;
  }

  /** An `at://` uri is not a valid id; the panel still needs one to be named by. */
  function threadPanelId(post: FeedbackPost): string {
    return `thread-${post.uri.replace(/[^a-zA-Z0-9]+/g, '-')}`;
  }

  /**
   * Whether a post's description is measurably longer than the two lines the
   * row shows, and whether the reader has opened it.
   *
   * Measured rather than guessed from the text's length: whether two lines are
   * enough depends on the column it's set in, and a "Show more" over nothing
   * hidden is worse than no button at all.
   */
  function clampProbe(node: HTMLElement, post: FeedbackPost) {
    const measure = () => {
      // An open body has nothing left to overflow; re-measuring it would decide
      // it fits and take the "Show less" away.
      if (openBodies[post.uri]) return;
      clampedBodies[post.uri] = node.scrollHeight - node.clientHeight > 1;
    };
    measure();
    // Re-measured as the column changes width. Absent in a test DOM, where
    // there is no layout to observe in the first place.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return { destroy: () => observer?.disconnect() };
  }

  async function loadThread(post: FeedbackPost) {
    const ref = postRef(post.uri);
    if (!ref) {
      threads[post.uri] = { open: true, status: 'failed', replies: [] };
      return;
    }
    threads[post.uri] = { open: true, status: 'loading', replies: [] };
    try {
      const { replies } = await api.getFeedbackThread(ref.did, ref.rkey);
      threads[post.uri] = { open: true, status: 'loaded', replies };
    } catch (error) {
      console.error('Failed to load feedback replies:', error);
      threads[post.uri] = { open: true, status: 'failed', replies: [] };
    }
  }

  function toggleReplies(post: FeedbackPost) {
    const thread = threads[post.uri];
    if (!thread) {
      void loadThread(post);
      return;
    }
    threads[post.uri] = { ...thread, open: !thread.open };
  }

  /**
   * A reply to your own post is what you came back to read, so the pinned
   * section opens itself rather than making you press each row. Bounded,
   * because each one is its own request.
   */
  const AUTO_OPEN_LIMIT = 3;
  function openOwnThreads() {
    for (const post of myPosts
      .filter((post) => post.replyCount > 0 && !threads[post.uri])
      .slice(0, AUTO_OPEN_LIMIT)) {
      void loadThread(post);
    }
  }

  async function loadBoard() {
    if (!navigator.onLine) {
      loadState = 'failed';
      return;
    }
    try {
      board = await api.getFeedbackBoard();
      // Anything the board now carries is no longer pending; anything it still
      // doesn't stays, so the reader keeps seeing their own post either way.
      savePending(prunePendingPosts(pending, board.posts));
      loadState = 'loaded';
      openOwnThreads();
    } catch (error) {
      console.error('Failed to load feedback board:', error);
      loadState = 'failed';
    }
  }

  function savePending(entries: PendingFeedbackPost[]) {
    pending = entries;
    writePendingPosts(entries);
  }

  async function loadPostScopes() {
    if (!auth.isAuthenticated || !navigator.onLine) return;
    try {
      const status = await api.getIntegrationStatus();
      postScopes = status.scopeStatus.userinput ? 'granted' : 'missing';
      imageScopes = status.scopeStatus.userinputImages === true;
    } catch (error) {
      console.error('Failed to load feedback posting status:', error);
    }
  }

  async function reauthForScopes() {
    await auth.logout();
    goto(`/auth/login?returnUrl=${encodeURIComponent('/feedback')}`);
  }

  /**
   * Take the picked files and start each one's upload. Bytes go up now rather
   * than at submit: an over-size or unreadable file should say so while there is
   * still a draft to fix, not after the reader has pressed Post.
   */
  async function addFiles(files: File[]) {
    attachmentError = null;
    const room = FEEDBACK_IMAGE_MAX - attachments.length;
    if (room <= 0) {
      attachmentError = `Up to ${FEEDBACK_IMAGE_MAX} images.`;
      return;
    }
    // First problem wins: picking three files and being told only about the
    // last one's is how a reader ends up fixing the same batch three times.
    const refuse = (message: string) => {
      attachmentError ??= message;
    };
    const accepted: Attachment[] = [];
    for (const file of files.slice(0, room)) {
      if (!FEEDBACK_IMAGE_TYPES.includes(file.type)) {
        refuse('Images only: PNG, JPEG, WebP or GIF.');
        continue;
      }
      if (file.size > FEEDBACK_IMAGE_MAX_BYTES) {
        refuse(`${file.name} is over 1 MB.`);
        continue;
      }
      accepted.push({
        id: nextAttachmentId++,
        file,
        previewUrl: URL.createObjectURL(file),
        // The filename, matching what userinput.app's own composer writes, and
        // editable right there because a filename is not a description.
        alt: file.name,
        blob: null,
        error: null,
      });
    }
    if (files.length > room) refuse(`Up to ${FEEDBACK_IMAGE_MAX} images.`);
    if (accepted.length === 0) return;
    attachments = [...attachments, ...accepted];

    for (const attachment of accepted) {
      try {
        const { blob } = await api.uploadFeedbackImage(attachment.file);
        update(attachment.id, (item) => ({ ...item, blob }));
      } catch (error) {
        if (error instanceof ScopeUpgradeError) {
          imageScopes = false;
          remove(attachment.id);
          attachmentError = 'Attaching images needs a new permission. Log in again to grant it.';
          continue;
        }
        console.error('Failed to upload feedback image:', error);
        update(attachment.id, (item) => ({ ...item, error: 'Upload failed' }));
      }
    }
  }

  function update(id: number, change: (item: Attachment) => Attachment) {
    attachments = attachments.map((item) => (item.id === id ? change(item) : item));
  }

  function remove(id: number) {
    const going = attachments.find((item) => item.id === id);
    if (going) URL.revokeObjectURL(going.previewUrl);
    attachments = attachments.filter((item) => item.id !== id);
    attachmentError = null;
  }

  function clearDraft() {
    for (const item of attachments) URL.revokeObjectURL(item.previewUrl);
    attachments = [];
    attachmentError = null;
    draftTitle = '';
    draftBody = '';
    draftType = '';
    if (fileInput) fileInput.value = '';
  }

  async function submitPost(event: SubmitEvent) {
    event.preventDefault();
    const title = draftTitle.trim();
    // A type is required here even though the record allows none: an untyped
    // post is one nobody can filter to, and the board is already full of them.
    if (!title || !draftType || posting || uploading) return;
    posting = true;
    postError = null;
    try {
      // Only the attachments whose bytes actually landed. One that failed is
      // still on screen with its error, so this can't drop a picture quietly.
      const images: FeedbackImage[] = attachments
        .filter((item) => item.blob)
        .map((item) => ({
          ...(item.alt.trim() ? { alt: item.alt.trim() } : {}),
          image: item.blob!,
        }));
      const created = await api.createFeedbackPost({
        title,
        body: draftBody.trim() || undefined,
        tags: [draftType],
        images: images.length > 0 ? images : undefined,
      });
      // Upstream indexes posts by backlink, so the board won't return this one
      // for a moment — through a reload, too, which is why the row is kept in
      // local storage rather than only in memory. The self-upvote is a second,
      // best-effort write, so the row shows one vote only when it landed.
      const selfVote = created.upvoted ? 1 : 0;
      savePending([
        {
          post: {
            uri: created.uri,
            url: created.url,
            author: {
              did: auth.user?.did ?? '',
              handle: auth.user?.handle ?? '',
              displayName: auth.user?.displayName ?? null,
              avatar: auth.user?.avatarUrl ?? null,
            },
            title,
            body: draftBody.trim(),
            tags: [draftType],
            createdAt: created.createdAt,
            votes: { up: selfVote, down: 0, net: selfVote },
            replyCount: 0,
            status: null,
          },
          postedAt: Date.now(),
        },
        ...pending.filter((entry) => entry.post.uri !== created.uri),
      ]);
      clearDraft();
      composerOpen = false;
      postedNote = true;
    } catch (error) {
      if (error instanceof ScopeUpgradeError) {
        postScopes = 'missing';
      } else {
        console.error('Failed to post feedback:', error);
        postError = 'Could not post that. Try again, or post on userinput.app.';
      }
    } finally {
      posting = false;
    }
  }

  onMount(() => {
    // Read before the board so a failed load still shows what this reader filed.
    savePending(prunePendingPosts(readPendingPosts(), []));
    const retry = () => {
      void loadBoard();
      void loadPostScopes();
    };
    window.addEventListener('online', retry);
    void loadBoard();
    void loadPostScopes();
    return () => window.removeEventListener('online', retry);
  });
</script>

<svelte:head><title>Feedback - Skyreader</title></svelte:head>

{#if auth.isInApp}
  <StaticPageChrome title="Feedback" />
{/if}

{#snippet postRow(post: FeedbackPost)}
  {@const thread = threads[post.uri]}
  <!-- The row was one big link out to userinput.app until replies arrived; now
       the title is the link and the reply count is a disclosure, because a row
       with two things to do can't be a single anchor. -->
  <article class="post">
    <div class="post-heading">
      <h3>
        <a href={post.url} target="_blank" rel="noopener noreferrer">{post.title}</a>
      </h3>
      {#each post.tags as tag}<span class="tag">{typeLabel(tag)}</span>{/each}
      {#if post.status}<span class="status">{statusLabel(post.status)}</span>{/if}
    </div>
    {#if post.body}
      <p class="body" class:open={openBodies[post.uri]} use:clampProbe={post}>{post.body}</p>
      {#if clampedBodies[post.uri]}
        <button
          class="more"
          aria-expanded={openBodies[post.uri] === true}
          aria-label={`${openBodies[post.uri] ? 'Show less' : 'Show more'} of ${post.title}`}
          onclick={() => (openBodies[post.uri] = !openBodies[post.uri])}
        >
          {openBodies[post.uri] ? 'Show less' : 'Show more'}
        </button>
      {/if}
    {/if}
    <div class="meta">
      <span class="votes" aria-label={`${post.votes.net} net votes`}>▲ {post.votes.net}</span>
      {#if post.replyCount > 0 || thread}
        <button
          class="reply-toggle"
          aria-expanded={thread?.open === true}
          aria-controls={threadPanelId(post)}
          onclick={() => toggleReplies(post)}
        >
          <span class="caret" class:open={thread?.open} aria-hidden="true">›</span>
          {replyLabel(post)}
        </button>
      {:else}
        <span>{replyLabel(post)}</span>
      {/if}
      <span class="author">
        {#if post.author.avatar}<img src={post.author.avatar} alt="" />{/if}
        {authorLabel(post)}
      </span>
      <time datetime={post.createdAt}>{formatRelativeDate(post.createdAt)}</time>
      <!-- Yours to see, not the board's yet. Saying so is honest about why
           nobody has replied and why it shows no votes but your own. -->
      {#if pendingUris.has(post.uri)}<span class="pending">Not on the board yet</span>{/if}
    </div>
    {#if thread?.open}
      <div class="thread" id={threadPanelId(post)}>
        {#if thread.status === 'loading'}
          <p class="thread-state" aria-live="polite">Loading replies…</p>
        {:else if thread.status === 'failed'}
          <p class="thread-state">
            Couldn't load the replies.
            <button class="link" onclick={() => loadThread(post)}>Try again</button>
          </p>
        {:else if thread.replies.length === 0}
          <p class="thread-state">No replies to show.</p>
        {:else}
          <ol class="replies">
            {#each thread.replies as reply (reply.uri)}
              <!-- One level of indent for a reply to a reply. Upstream nests
                   arbitrarily; a feedback thread that deep belongs on the board
                   itself, not in a column this narrow. -->
              <li class:nested={reply.parentUri !== null}>
                <div class="reply-meta">
                  {#if reply.author.avatar}<img src={reply.author.avatar} alt="" />{/if}
                  <span class="reply-author">{replyAuthorLabel(reply)}</span>
                  {#if reply.author.mod}<span class="mod">Maintainer</span>{/if}
                  <time datetime={reply.createdAt}>{formatRelativeDate(reply.createdAt)}</time>
                </div>
                <p class="reply-body">{reply.body}</p>
              </li>
            {/each}
          </ol>
        {/if}
      </div>
    {/if}
  </article>
{/snippet}

<div class="feedback-page">
  <section class="intro">
    <p>
      Ideas, bugs, and suggestions for Skyreader. Feedback lives on Skyreader's public <a
        href="https://userinput.app/s/did:plc:ra4jsemddo2ii4pn5jaf6x4v/3mobgsd6d5n27"
        >userinput.app board</a
      >.
    </p>
    {#if !auth.isAuthenticated}
      <a
        class="post-link"
        href={board?.spaceUrl ?? fallbackUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        Post on userinput.app <span aria-hidden="true">↗</span>
      </a>
    {:else if postScopes === 'missing'}
      <p class="note">
        Posting from here needs one new permission.
        <button class="link" onclick={reauthForScopes}>Log in again</button> to grant it, or
        <a href={board?.spaceUrl ?? fallbackUrl} target="_blank" rel="noopener noreferrer"
          >post on userinput.app →</a
        >
      </p>
    {:else}
      <!-- One primary action on the surface at a time: once the composer is
           open, its Post button is the primary and this becomes the way out. -->
      <button
        class="post-link"
        class:quiet={composerOpen}
        aria-expanded={composerOpen}
        onclick={() => {
          composerOpen = !composerOpen;
          postedNote = false;
        }}
      >
        {composerOpen ? 'Close' : 'Post feedback'}
      </button>
    {/if}

    {#if composerOpen}
      <form class="composer" onsubmit={submitPost}>
        <div class="field compact">
          <span id="composer-type-label">Type</span>
          <!-- A track rather than a dropdown: three options, one chosen by
               default, and all of them worth seeing without opening anything.
               Real radios underneath, so arrow keys and form semantics come
               free; the thumb slides to whichever is checked. -->
          <div
            class="type-picker"
            role="radiogroup"
            aria-labelledby="composer-type-label"
            style="--options: {composerTypes.length}; --selected: {selectedTypeIndex}"
          >
            {#if selectedTypeIndex >= 0}<span class="thumb" aria-hidden="true"></span>{/if}
            {#each composerTypes as type}
              <label class="segment" class:active={draftType === type.value}>
                <input
                  type="radio"
                  name="feedback-type"
                  value={type.value}
                  bind:group={draftType}
                  required
                />
                <span>{type.label}</span>
              </label>
            {/each}
          </div>
        </div>
        <label class="field">
          <span>Title</span>
          <input
            bind:value={draftTitle}
            maxlength={TITLE_MAX}
            placeholder="One line: what happened, or what you want"
            required
          />
        </label>
        <label class="field">
          <span>Details</span>
          <textarea
            bind:value={draftBody}
            maxlength={BODY_MAX}
            rows="5"
            placeholder="Optional. Steps, context, why it matters."></textarea>
        </label>
        {#if imageScopes}
          <!-- Screenshots are most of what a bug report is, so the attach
               control sits with the fields rather than behind the Post row. -->
          <div class="field">
            <span id="attachments-label">Images</span>
            {#if attachments.length > 0}
              <ul class="attachments" aria-labelledby="attachments-label">
                {#each attachments as attachment (attachment.id)}
                  <li class:failed={attachment.error}>
                    <img src={attachment.previewUrl} alt="" />
                    <div class="attachment-body">
                      <input
                        class="alt"
                        bind:value={attachment.alt}
                        maxlength={2000}
                        placeholder="Describe this image"
                        aria-label={`Description for ${attachment.file.name}`}
                      />
                      <span class="attachment-state">
                        {#if attachment.error}
                          {attachment.error}
                        {:else if !attachment.blob}
                          Uploading…
                        {:else}
                          {Math.round(attachment.file.size / 1024)} KB
                        {/if}
                      </span>
                    </div>
                    <button
                      type="button"
                      class="remove"
                      onclick={() => remove(attachment.id)}
                      aria-label={`Remove ${attachment.file.name}`}>×</button
                    >
                  </li>
                {/each}
              </ul>
            {/if}
            <input
              class="file-input"
              type="file"
              multiple
              accept={FEEDBACK_IMAGE_TYPES.join(',')}
              bind:this={fileInput}
              disabled={attachments.length >= FEEDBACK_IMAGE_MAX}
              onchange={(event) => {
                const picked = [...(event.currentTarget.files ?? [])];
                event.currentTarget.value = '';
                void addFiles(picked);
              }}
            />
            <span class="hint">
              Up to {FEEDBACK_IMAGE_MAX} images, 1 MB each. PNG, JPEG, WebP or GIF.
            </span>
            {#if attachmentError}<span class="error" aria-live="polite">{attachmentError}</span
              >{/if}
          </div>
        {/if}
        {#if postError}<p class="error" aria-live="polite">{postError}</p>{/if}
        <div class="composer-actions">
          <button
            class="post-link"
            type="submit"
            disabled={posting || uploading || !draftTitle.trim() || !draftType}
          >
            {posting ? 'Posting…' : uploading ? 'Uploading…' : 'Post'}
          </button>
          <span class="disclosure">Posted publicly from your account.</span>
        </div>
      </form>
    {/if}

    {#if postedNote}
      <p class="note" aria-live="polite">
        Posted. It can take a minute to show up for everyone on the board.
      </p>
    {/if}

    {#if board && !board.complete}
      <p class="incomplete">
        Showing part of the board. <a
          href={board.spaceUrl}
          target="_blank"
          rel="noopener noreferrer">See all feedback →</a
        >
      </p>
    {/if}
  </section>

  {#if loadState === 'loading'}
    <p class="state" aria-live="polite">Loading feedback…</p>
  {:else if loadState === 'failed'}
    <p class="state">
      Couldn't load the board. <a href={fallbackUrl} target="_blank" rel="noopener noreferrer"
        >Open it on userinput.app →</a
      >
    </p>
  {:else}
    <!-- The same two choices, twice: tracks while there is room to lay them out
         flat, and the compact selects the Home toolbar and the magazine rail
         use once there isn't. Which one shows is a container query on the
         reading column, not on the viewport — the sidebar takes its width out
         of the window, and only the column knows that. Exactly one is ever
         displayed, so only one reaches the a11y tree. -->
    <div class="controls">
      <div class="chip-controls">
        <div class="filter-stack">
          <!-- Two halves of one board rather than a chip per status: what a
               reader wants is what's still live or what's been settled, and the
               row's own pill already says which state a post is in. -->
          {#if hasClosed}
            <div class="filters" role="group" aria-label="Filter by status">
              <span class="filter-label">Status</span>
              <div class="segmented">
                {#each [{ value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }, { value: 'all', label: 'All' }] as const as option}
                  <button
                    class:active={statusScope === option.value}
                    aria-pressed={statusScope === option.value}
                    onclick={() => (statusScope = option.value)}>{option.label}</button
                  >
                {/each}
              </div>
            </div>
          {/if}
        </div>
        <div class="filters sort" role="group" aria-label="Sort feedback">
          <span class="filter-label">Sort</span>
          <!-- Two mutually exclusive orderings, so they read as one track rather
               than as two more chips in a row of filters. -->
          <div class="segmented">
            <button
              class:active={sort === 'top'}
              aria-pressed={sort === 'top'}
              onclick={() => (sort = 'top')}>Top</button
            >
            <button
              class:active={sort === 'new'}
              aria-pressed={sort === 'new'}
              onclick={() => (sort = 'new')}>New</button
            >
          </div>
        </div>
      </div>

      <div class="menu-controls">
        {#if hasClosed}
          <label class="control-group">
            <span>Status</span>
            <select
              value={statusScope}
              onchange={(event) => (statusScope = toScope(event.currentTarget.value))}
            >
              <option value="open">Open</option>
              <option value="closed">Closed</option>
              <option value="all">All</option>
            </select>
          </label>
        {/if}
        <label class="control-group sort">
          <span>Sort</span>
          <select
            value={sort}
            onchange={(event) => (sort = event.currentTarget.value === 'new' ? 'new' : 'top')}
          >
            <option value="top">Top</option>
            <option value="new">New</option>
          </select>
        </label>
      </div>
    </div>

    <!-- The reader's own posts, set apart above the board: on a list this long,
         finding what you filed is otherwise a search. -->
    {#if myPosts.length > 0}
      <section class="mine" aria-labelledby="your-feedback">
        <h2 class="mine-heading" id="your-feedback">Your feedback</h2>
        <div class="posts">
          {#each myPosts as post (post.uri)}
            {@render postRow(post)}
          {/each}
        </div>
      </section>
    {/if}

    {#if visiblePosts.length === 0}
      {#if statusScope === 'open' && hasClosed}
        <!-- Not "nothing here": the board has settled posts, and the filter
             that hid them is the page's own default, not the reader's doing.
             Said even when the reader's own section above is showing something,
             since that section doesn't answer the scope. -->
        <p class="state">
          Nothing open here.
          <button class="link" onclick={() => (statusScope = 'closed')}>See what's closed</button>
        </p>
      {:else if myPosts.length === 0}
        <p class="state">No feedback here yet.</p>
      {/if}
      <!-- Otherwise: nothing but your own, which is already above. -->
    {:else}
      <!-- One list in the order the reader chose. Type is a filter and a pill on
           the row, not a partition: cut into groups, the board's most-wanted
           post sat under whichever heading happened to come first. -->
      <div class="posts">
        {#each visiblePosts as post (post.uri)}
          {@render postRow(post)}
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .feedback-page {
    max-width: 640px;
    margin: 0 auto;
    padding: 3.5rem 1rem 4rem;
    /* The query context for the controls swap: this column is what the chips
       have to fit into, and it is narrower than the window by whatever the
       sidebar is taking. */
    container-type: inline-size;
  }
  .intro {
    margin-bottom: 2rem;
  }
  .intro p {
    max-width: 58ch;
    margin: 0 0 1rem;
    color: var(--color-text-secondary);
    line-height: var(--leading-relaxed);
  }
  .intro .incomplete {
    margin-top: 0.75rem;
    font-size: var(--text-sm);
  }
  .incomplete a {
    color: var(--color-primary);
  }
  .post-link {
    display: inline-flex;
    align-items: center;
    padding: 0.4375rem 0.9375rem;
    border: 1px solid transparent;
    border-radius: 6px;
    background: var(--color-primary);
    color: white;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    line-height: var(--leading-none);
    text-decoration: none;
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }
  .post-link:hover:not(:disabled) {
    background: var(--color-primary-dark);
    color: white;
  }
  .post-link:disabled {
    cursor: default;
    opacity: 0.55;
  }
  /* The open-composer state of the trigger: still the same control, no longer
     the thing to press. */
  .post-link.quiet,
  .post-link.quiet:hover {
    border-color: var(--color-border);
    background: none;
    color: var(--color-text-secondary);
  }
  .post-link.quiet:hover {
    color: var(--color-text);
  }
  .note {
    margin: 0.75rem 0 0;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }
  .note a {
    color: var(--color-primary);
  }
  /* A panel, not a continuation of the intro: writing a post is a different
     mode from reading the board, and the tinted card says so without a shadow. */
  .composer {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    margin-top: 1.25rem;
    padding: 1.1rem;
    border: 1px solid var(--color-border);
    border-radius: 10px;
    background: var(--color-bg-secondary);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  /* The type picker sizes to its options; stretched to 640px it read as the
     page's most important field, which it is not. */
  .field.compact {
    align-items: flex-start;
  }
  /* The field's own label, not every span inside it — the attachments block
     carries a hint and a per-image state line too. */
  .field > span:first-child {
    color: var(--color-text-secondary);
    font-size: var(--text-2xs);
    font-weight: var(--weight-medium);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .field input,
  .field textarea {
    width: 100%;
    padding: 0.5rem 0.65rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-md);
    line-height: var(--leading-normal);
  }
  .field textarea {
    resize: vertical;
  }
  .field input::placeholder,
  .field textarea::placeholder {
    color: var(--color-text-secondary);
    opacity: 0.75;
  }
  .field input:focus-visible,
  .field textarea:focus-visible {
    border-color: var(--color-primary);
    outline: 2px solid var(--color-primary);
    outline-offset: -1px;
  }
  /* The type picker: the sort track's shape, inverted so it stays visible on the
     composer's tinted card, and with a thumb that slides between options. */
  .type-picker {
    position: relative;
    display: grid;
    grid-template-columns: repeat(var(--options), 1fr);
    width: 100%;
    max-width: 24rem;
    padding: 2px;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: var(--color-bg);
  }
  .type-picker .thumb {
    position: absolute;
    top: 2px;
    bottom: 2px;
    left: 2px;
    width: calc((100% - 4px) / var(--options));
    border-radius: 999px;
    background: var(--color-sidebar-active);
    transform: translateX(calc(var(--selected) * 100%));
    transition: transform 0.18s ease;
  }
  @media (prefers-reduced-motion: reduce) {
    .type-picker .thumb {
      transition: none;
    }
  }
  .segment {
    position: relative;
    padding: 0.3rem 0.5rem;
    border-radius: 999px;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    line-height: var(--leading-none);
    text-align: center;
    white-space: nowrap;
    cursor: pointer;
    transition: color 0.15s ease;
  }
  .segment:hover {
    color: var(--color-text);
  }
  .segment.active {
    color: var(--color-primary);
  }
  /* The radio itself is the control — it just isn't what you look at. */
  .segment input {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: 0;
    padding: 0;
    border: 0;
    opacity: 0;
  }
  .segment:has(input:focus-visible) {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }
  .attachments {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin: 0 0 0.15rem;
    padding: 0;
    list-style: none;
  }
  .attachments li {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.35rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-bg);
  }
  .attachments li.failed {
    border-color: var(--color-error);
  }
  .attachments img {
    width: 2.75rem;
    height: 2.75rem;
    flex: none;
    border-radius: 4px;
    object-fit: cover;
  }
  .attachment-body {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }
  .attachments .alt {
    padding: 0.2rem 0.35rem;
    border: 1px solid transparent;
    border-radius: 4px;
    background: none;
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-sm);
  }
  .attachments .alt:hover,
  .attachments .alt:focus-visible {
    border-color: var(--color-border);
    background: var(--color-bg);
  }
  .attachment-state {
    padding-left: 0.35rem;
    color: var(--color-text-secondary);
    font-size: var(--text-2xs);
  }
  .failed .attachment-state {
    color: var(--color-error);
  }
  .attachments .remove {
    flex: none;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 50%;
    color: var(--color-text-secondary);
    font-size: var(--text-base);
    line-height: 1;
  }
  .attachments .remove:hover {
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }
  /* Undo the text-field styling `.field input` gives every input in a field
     (and outrank it, hence the two classes). */
  .field input.file-input {
    width: auto;
    padding: 0;
    border: 0;
    background: none;
    font-size: var(--text-sm);
  }
  .file-input::file-selector-button {
    margin-right: 0.6rem;
    padding: 0.3rem 0.7rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    cursor: pointer;
  }
  .file-input:disabled::file-selector-button {
    cursor: default;
    opacity: 0.55;
  }
  .hint {
    color: var(--color-text-secondary);
    font-size: var(--text-2xs);
  }
  .composer-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.85rem;
    margin-top: 0.15rem;
  }
  .disclosure {
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
  }
  .error {
    margin: 0;
    color: var(--color-error);
    font-size: var(--text-sm);
  }
  .controls {
    padding-bottom: 0.9rem;
    border-bottom: 1px solid var(--color-border);
  }
  /* The tracks by default; the container query below swaps in the selects. */
  .chip-controls {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem 1rem;
  }
  .menu-controls {
    display: none;
  }
  .filter-stack {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 0.4rem;
    min-width: 0;
  }
  .filters {
    display: flex;
    align-items: baseline;
    gap: 0.3rem;
  }
  .filters.sort {
    flex: none;
    align-items: center;
  }
  /* A fixed column for the label, so Status here and Sort opposite it sit on
     one baseline however wide the words are. */
  .filter-stack .filter-label {
    min-width: 3.25rem;
  }
  .filter-label {
    flex: none;
    margin-right: 0.2rem;
    color: var(--color-text-secondary);
    font-size: var(--text-2xs);
    font-weight: var(--weight-medium);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  /* Chips, the same language the discussion filters speak elsewhere in the app. */
  .filters button {
    flex: none;
    padding: 0.25rem 0.625rem;
    border-radius: 999px;
    background: var(--color-bg-secondary);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    line-height: var(--leading-none);
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }
  .filters button:hover {
    color: var(--color-text);
  }
  .filters button.active {
    background: var(--color-sidebar-active);
    color: var(--color-primary);
    /* Weight stays put so choosing a chip doesn't reflow the row. */
    font-weight: var(--weight-medium);
  }
  /* Sort is one track with two positions, not two independent chips. */
  .segmented {
    display: inline-flex;
    flex: none;
    padding: 2px;
    border-radius: 999px;
    background: var(--color-bg-secondary);
  }
  .segmented button {
    background: none;
  }
  .segmented button.active {
    background: var(--color-bg);
    color: var(--color-text);
  }
  .control-group {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    cursor: pointer;
  }
  .control-group select {
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    cursor: pointer;
  }
  .control-group select:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }
  /* Your own posts, on the composer's surface: the two things on this page that
     belong to the reader rather than to the board share one card, and the tint
     is enough to set them apart without a rule or a shadow. */
  .mine {
    margin-top: 1.25rem;
    padding: 0.9rem 1.1rem;
    border: 1px solid var(--color-border);
    border-radius: 10px;
    background: var(--color-bg-secondary);
  }
  .mine-heading {
    margin: 0 0 0.15rem;
    color: var(--color-text-secondary);
    font-size: var(--text-2xs);
    font-weight: var(--weight-medium);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  /* The card's own edge closes the list; a second rule under it reads as a gap. */
  .mine .posts {
    border-bottom: 0;
  }
  .mine .post {
    padding: 0.9rem 0;
  }
  button {
    padding: 0;
    border: 0;
    background: none;
    color: var(--color-text-secondary);
    font: inherit;
    font-size: var(--text-sm);
    cursor: pointer;
  }
  button.link {
    color: var(--color-primary);
    text-decoration: underline;
  }
  button:hover {
    color: var(--color-primary);
  }
  button:focus-visible,
  a:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 3px;
  }
  .posts {
    border-bottom: 1px solid var(--color-border);
  }
  .post {
    display: block;
    padding: 1.15rem 0;
    border-bottom: 1px solid var(--color-border);
    color: inherit;
    text-decoration: none;
  }
  .post:last-child {
    border-bottom: 0;
  }
  .post-heading {
    display: flex;
    align-items: baseline;
    gap: 0.65rem;
  }
  h3 {
    margin: 0;
    font-size: var(--text-base);
    line-height: var(--leading-snug);
  }
  h3 a {
    color: inherit;
    text-decoration: none;
  }
  h3 a:hover {
    color: var(--color-primary);
  }
  .status,
  .tag {
    flex: none;
    padding: 0.1rem 0.45rem;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    color: var(--color-text-secondary);
    font-size: var(--text-2xs);
    font-weight: var(--weight-medium);
    white-space: nowrap;
  }
  /* The type is the post's own word for itself; the status is the maintainer's,
     so it stays neutral and the type carries the tint. */
  .tag {
    border-color: transparent;
    background: var(--color-sidebar-active);
    color: var(--color-primary);
  }
  .body {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    margin: 0.4rem 0 0;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    line-height: var(--leading-normal);
  }
  /* Opened, the description stops being a preview and becomes what its author
     wrote: their line breaks are kept, and a pasted URL wraps instead of
     pushing the column sideways. */
  .body.open {
    display: block;
    overflow: visible;
    -webkit-line-clamp: none;
    line-clamp: none;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .more {
    margin-top: 0.3rem;
    font-size: var(--text-xs);
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    margin-top: 0.65rem;
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
  }
  .votes {
    font-variant-numeric: tabular-nums;
    font-weight: var(--weight-medium);
  }
  /* The count reads as the rest of the meta row does; only the caret says it
     opens, and it turns rather than swapping for a second glyph. */
  .reply-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: var(--text-xs);
  }
  .caret {
    display: inline-block;
    line-height: 1;
    transition: transform 0.15s ease;
  }
  .caret.open {
    transform: rotate(90deg);
  }
  @media (prefers-reduced-motion: reduce) {
    .caret {
      transition: none;
    }
  }
  /* The replies hang off the post rather than sitting beside it: one rule down
     the left edge, the way a quotation is set in the reader. */
  .thread {
    margin: 0.85rem 0 0.15rem;
    padding-left: 0.9rem;
    border-left: 2px solid var(--color-border);
  }
  .thread-state {
    margin: 0;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }
  .replies {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .replies .nested {
    padding-left: 1.1rem;
  }
  .reply-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
  }
  .reply-meta img {
    width: 1.15rem;
    height: 1.15rem;
    border-radius: 50%;
    object-fit: cover;
  }
  .reply-author {
    color: var(--color-text);
    font-weight: var(--weight-medium);
  }
  /* Who answered matters more here than anywhere else on the page: a reply from
     the board's own moderators is the one that settles the question. */
  .mod {
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    background: var(--color-sidebar-active);
    color: var(--color-primary);
    font-size: var(--text-2xs);
    font-weight: var(--weight-medium);
  }
  .reply-body {
    margin: 0.2rem 0 0;
    font-size: var(--text-sm);
    line-height: var(--leading-normal);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  /* Same neutral pill as a status: it is a fact about the post, not a warning. */
  .pending {
    padding: 0.05rem 0.4rem;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    font-size: var(--text-2xs);
    white-space: nowrap;
  }
  .author {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    min-width: 0;
  }
  .author img {
    width: 1.15rem;
    height: 1.15rem;
    border-radius: 50%;
    object-fit: cover;
  }
  .state {
    margin: 2rem 0;
    color: var(--color-text-secondary);
  }
  .state a {
    color: var(--color-primary);
  }
  @media (max-width: 1000px) {
    .feedback-page {
      padding-top: 0.5rem;
      padding-bottom: calc(var(--bottom-bar-height) + var(--safe-area-bottom) + 4rem);
    }
  }
  /* Below this the chip rows start wrapping into a ragged block, so the three
     choices collapse into the compact selects instead. Measured on the reading
     column, so a narrow window and a wide window with the sidebar out both get
     the version that fits. */
  @container (max-width: 560px) {
    .chip-controls {
      display: none;
    }
    .menu-controls {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem 1.25rem;
    }
  }
</style>
