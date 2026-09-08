<script lang="ts">
  import { onMount } from 'svelte';
  import StaticPageChrome from '$lib/components/feed/StaticPageChrome.svelte';
  import { api, type FeedbackBoard, type FeedbackPost } from '$lib/services/api';
  import { syncStore } from '$lib/stores/sync.svelte';
  import { formatRelativeDate } from '$lib/utils/date';

  const fallbackUrl = 'https://userinput.app/s/did:plc:ra4jsemddo2ii4pn5jaf6x4v/3mobgsd6d5n27';
  const filters = [
    { label: 'All', tag: null },
    { label: 'Features', tag: 'feature' },
    { label: 'Bugs', tag: 'bug' },
    { label: 'Questions', tag: 'question' },
  ] as const;

  let loadState = $state<'loading' | 'loaded' | 'failed'>('loading');
  let board = $state<FeedbackBoard | null>(null);
  let activeTag = $state<string | null>(null);
  let sort = $state<'top' | 'new'>('top');
  let visiblePosts = $derived.by(() => {
    const posts = board?.posts.filter((post) => !activeTag || post.tags.includes(activeTag)) ?? [];
    return [...posts].sort((a, b) =>
      sort === 'top'
        ? b.votes.net - a.votes.net || Date.parse(b.createdAt) - Date.parse(a.createdAt)
        : Date.parse(b.createdAt) - Date.parse(a.createdAt)
    );
  });

  function authorLabel(post: FeedbackPost): string {
    return post.author.handle.startsWith('did:') ? post.author.handle : `@${post.author.handle}`;
  }

  async function loadBoard() {
    if (!syncStore.isOnline) {
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

  onMount(() => void loadBoard());
</script>

<svelte:head><title>Feedback - Skyreader</title></svelte:head>

<StaticPageChrome title="Feedback" />

<main class="feedback-page">
  <section class="intro">
    <p>
      Ideas, bugs, questions. Feedback lives on userinput.app — an Atmospheric app; post and vote
      with the same account. Posts are public.
    </p>
    <a
      class="post-link"
      href={board?.spaceUrl ?? fallbackUrl}
      target="_blank"
      rel="noopener noreferrer"
    >
      Post feedback <span aria-hidden="true">↗</span>
    </a>
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
    <div class="controls" aria-label="Feedback filters">
      <div class="filters">
        {#each filters as filter}
          <button class:active={activeTag === filter.tag} onclick={() => (activeTag = filter.tag)}
            >{filter.label}</button
          >
        {/each}
      </div>
      <div class="sort" aria-label="Sort feedback">
        <button class:active={sort === 'top'} onclick={() => (sort = 'top')}>Top</button>
        <span aria-hidden="true">·</span>
        <button class:active={sort === 'new'} onclick={() => (sort = 'new')}>New</button>
      </div>
    </div>

    {#if visiblePosts.length === 0}
      <p class="state">No feedback here yet.</p>
    {:else}
      <div class="posts">
        {#each visiblePosts as post (post.uri)}
          <a class="post" href={post.url} target="_blank" rel="noopener noreferrer">
            <div class="post-heading">
              <h2>{post.title}</h2>
              {#if post.status}<span class="status">{post.status.replaceAll('-', ' ')}</span>{/if}
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
        {/each}
      </div>
    {/if}
  {/if}
</main>

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
  .post-link:hover {
    background: var(--color-primary-dark);
  }
  .controls {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid var(--color-border);
  }
  .filters,
  .sort {
    display: flex;
    align-items: center;
    gap: 0.85rem;
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
  .post:hover h2 {
    color: var(--color-primary);
  }
  .post-heading {
    display: flex;
    align-items: baseline;
    gap: 0.65rem;
  }
  h2 {
    margin: 0;
    font-size: var(--text-base);
    line-height: var(--leading-snug);
  }
  .status {
    flex: none;
    padding: 0.1rem 0.4rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
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
