<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import StaticPageChrome from '$lib/components/feed/StaticPageChrome.svelte';
  import { api, ScopeUpgradeError, type FeedbackBoard, type FeedbackPost } from '$lib/services/api';
  import { auth } from '$lib/stores/auth.svelte';
  import { formatRelativeDate } from '$lib/utils/date';
  import {
    DEFAULT_FEEDBACK_TYPES,
    feedbackStatuses,
    feedbackTypes,
    filterFeedbackPosts,
    groupFeedbackPosts,
    sortFeedbackPosts,
    statusLabel,
  } from '$lib/utils/feedbackBoard';

  const fallbackUrl = 'https://userinput.app/s/did:plc:ra4jsemddo2ii4pn5jaf6x4v/3mobgsd6d5n27';
  const TITLE_MAX = 300;
  const BODY_MAX = 10000;

  let loadState = $state<'loading' | 'loaded' | 'failed'>('loading');
  let board = $state<FeedbackBoard | null>(null);
  let activeType = $state<string | null>(null);
  let activeStatus = $state<string | null>(null);
  let sort = $state<'top' | 'new'>('top');

  // Whether this session may write an app.userinput.discussion record. Asked up
  // front so nobody writes a post only to be told their session can't send it.
  let postScopes = $state<'unknown' | 'granted' | 'missing'>('unknown');
  let composerOpen = $state(false);
  let draftTitle = $state('');
  let draftBody = $state('');
  let draftType = $state('');
  let posting = $state(false);
  let postError = $state<string | null>(null);
  let postedNote = $state(false);

  // Two vocabularies, deliberately: the filters show every type posts actually
  // carry (including one the board has since dropped), while the composer offers
  // only what the board still accepts — the backend rejects anything else.
  let types = $derived(feedbackTypes(board?.types, board?.posts ?? []));
  let composerTypes = $derived(board?.types?.length ? board.types : DEFAULT_FEEDBACK_TYPES);
  let statuses = $derived(feedbackStatuses(board?.posts ?? []));
  let visiblePosts = $derived(
    sortFeedbackPosts(
      filterFeedbackPosts(board?.posts ?? [], { type: activeType, status: activeStatus }),
      sort
    )
  );
  // Grouped by type while the reader is looking at everything; a chosen type is
  // already one group, and a heading over the whole list is just noise.
  let groups = $derived(activeType ? [] : groupFeedbackPosts(visiblePosts, types));

  function authorLabel(post: FeedbackPost): string {
    return post.author.handle.startsWith('did:') ? post.author.handle : `@${post.author.handle}`;
  }

  function typeLabel(value: string): string {
    return types.find((type) => type.value === value)?.label ?? value;
  }

  async function loadBoard() {
    if (!navigator.onLine) {
      loadState = 'failed';
      return;
    }
    try {
      board = await api.getFeedbackBoard();
      loadState = 'loaded';
    } catch (error) {
      console.error('Failed to load feedback board:', error);
      loadState = 'failed';
    }
  }

  async function loadPostScopes() {
    if (!auth.isAuthenticated || !navigator.onLine) return;
    try {
      const status = await api.getIntegrationStatus();
      postScopes = status.scopeStatus.userinput ? 'granted' : 'missing';
    } catch (error) {
      console.error('Failed to load feedback posting status:', error);
    }
  }

  async function reauthForScopes() {
    await auth.logout();
    goto(`/auth/login?returnUrl=${encodeURIComponent('/feedback')}`);
  }

  async function submitPost(event: SubmitEvent) {
    event.preventDefault();
    const title = draftTitle.trim();
    if (!title || posting) return;
    posting = true;
    postError = null;
    try {
      const created = await api.createFeedbackPost({
        title,
        body: draftBody.trim() || undefined,
        tags: draftType ? [draftType] : undefined,
      });
      // Upstream indexes posts by backlink, so the board won't return this one
      // for a moment. Show it now, from what we already know, and let the next
      // load replace it. The self-upvote is a second, best-effort write, so the
      // row shows one vote only when the backend says that write landed.
      const selfVote = created.upvoted ? 1 : 0;
      if (board) {
        board = {
          ...board,
          total: board.total + 1,
          posts: [
            {
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
              tags: draftType ? [draftType] : [],
              createdAt: created.createdAt,
              votes: { up: selfVote, down: 0, net: selfVote },
              replyCount: 0,
              status: null,
            },
            ...board.posts.filter((post) => post.uri !== created.uri),
          ],
        };
      }
      draftTitle = '';
      draftBody = '';
      draftType = '';
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
  <a class="post" href={post.url} target="_blank" rel="noopener noreferrer">
    <div class="post-heading">
      <h3>{post.title}</h3>
      {#each post.tags as tag}<span class="tag">{typeLabel(tag)}</span>{/each}
      {#if post.status}<span class="status">{statusLabel(post.status)}</span>{/if}
    </div>
    {#if post.body}<p class="body">{post.body}</p>{/if}
    <div class="meta">
      <span aria-label={`${post.votes.net} net votes`}>▲ {post.votes.net}</span>
      <span>{post.replyCount} {post.replyCount === 1 ? 'reply' : 'replies'}</span>
      <span class="author">
        {#if post.author.avatar}<img src={post.author.avatar} alt="" />{/if}
        {authorLabel(post)}
      </span>
      <time datetime={post.createdAt}>{formatRelativeDate(post.createdAt)}</time>
    </div>
  </a>
{/snippet}

<div class="feedback-page">
  <section class="intro">
    <p>
      Ideas, bugs, questions. Post from here and it lands on the Skyreader board at userinput.app —
      an Atmospheric app — as a record in your own repo. Posts are public.
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
      <button
        class="post-link"
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
        <label class="field">
          <span>Type</span>
          <select bind:value={draftType}>
            <option value="">No type</option>
            {#each composerTypes as type}
              <option value={type.value}>{type.label}</option>
            {/each}
          </select>
        </label>
        <label class="field">
          <span>Title</span>
          <input
            bind:value={draftTitle}
            maxlength={TITLE_MAX}
            placeholder="One line — what happened, or what you want"
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
        {#if postError}<p class="error" aria-live="polite">{postError}</p>{/if}
        <div class="composer-actions">
          <button class="post-link" type="submit" disabled={posting || !draftTitle.trim()}>
            {posting ? 'Posting…' : 'Post'}
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
    <div class="controls">
      <div class="filters" role="group" aria-label="Filter by type">
        <span class="filter-label">Type</span>
        <button
          class:active={activeType === null}
          aria-pressed={activeType === null}
          onclick={() => (activeType = null)}>All</button
        >
        {#each types as type}
          <button
            class:active={activeType === type.value}
            aria-pressed={activeType === type.value}
            onclick={() => (activeType = type.value)}>{type.label}</button
          >
        {/each}
      </div>
      {#if statuses.length > 1}
        <div class="filters" role="group" aria-label="Filter by status">
          <span class="filter-label">Status</span>
          <button
            class:active={activeStatus === null}
            aria-pressed={activeStatus === null}
            onclick={() => (activeStatus = null)}>All</button
          >
          {#each statuses as status}
            <button
              class:active={activeStatus === status}
              aria-pressed={activeStatus === status}
              onclick={() => (activeStatus = status)}>{statusLabel(status)}</button
            >
          {/each}
        </div>
      {/if}
      <div class="filters sort" role="group" aria-label="Sort feedback">
        <span class="filter-label">Sort</span>
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

    {#if visiblePosts.length === 0}
      <p class="state">No feedback here yet.</p>
    {:else if activeType}
      <div class="posts">
        {#each visiblePosts as post (post.uri)}
          {@render postRow(post)}
        {/each}
      </div>
    {:else}
      {#each groups as group (group.type)}
        <section class="group">
          <h2 class="group-heading">{group.label} <span>{group.posts.length}</span></h2>
          <div class="posts">
            {#each group.posts as post (post.uri)}
              {@render postRow(post)}
            {/each}
          </div>
        </section>
      {/each}
    {/if}
  {/if}
</div>

<style>
  .feedback-page {
    max-width: 640px;
    margin: 0 auto;
    padding: 3.5rem 1rem 4rem;
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
    display: inline-block;
    padding: 0.5rem 1rem;
    border-radius: var(--radius-md);
    background: var(--color-primary);
    color: white;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    text-decoration: none;
  }
  .post-link:hover:not(:disabled) {
    background: var(--color-primary-dark);
    color: white;
  }
  .post-link:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .note {
    margin: 0.75rem 0 0;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }
  .note a {
    color: var(--color-primary);
  }
  .composer {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    margin-top: 1.25rem;
    padding-top: 1.25rem;
    border-top: 1px solid var(--color-border);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .field span {
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
  }
  .field input,
  .field textarea,
  .field select {
    padding: 0.5rem 0.65rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg);
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-sm);
  }
  .field textarea {
    resize: vertical;
  }
  .field input:focus-visible,
  .field textarea:focus-visible,
  .field select:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }
  .composer-actions {
    display: flex;
    align-items: center;
    gap: 0.85rem;
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
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 0.75rem 1.5rem;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid var(--color-border);
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.85rem;
  }
  .filter-label {
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .group {
    margin-top: 1.75rem;
  }
  .group-heading {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    margin: 0 0 0.25rem;
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
  }
  .group-heading span {
    color: var(--color-text-secondary);
    font-weight: var(--weight-normal);
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
  button:hover,
  button.active {
    color: var(--color-primary);
  }
  button.active {
    font-weight: var(--weight-semibold);
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
  .post:hover h3 {
    color: var(--color-primary);
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
  .status,
  .tag {
    flex: none;
    padding: 0.1rem 0.4rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
    text-transform: capitalize;
  }
  .tag {
    color: var(--color-primary);
    text-transform: capitalize;
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
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    margin-top: 0.65rem;
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
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
  @media (max-width: 560px) {
    .controls {
      align-items: flex-start;
      flex-direction: column;
    }
  }
</style>
