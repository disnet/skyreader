<script lang="ts">
  // A Bluesky post as a river row (docs/plans/BLUESKY_FEEDS_PLAN.md): the post
  // whole, as Bluesky shows it, with the few things a reader does to one: reply,
  // repost, like, and read what it links to in the calm reader. Posts are short,
  // so there's no collapsed state; a card is always the whole post.
  import Icon from '$lib/components/Icon.svelte';
  import { bskyFeedsStore } from '$lib/stores/bskyFeeds.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import {
    POST_MAX_GRAPHEMES,
    bskyPostLink,
    compactCount,
    graphemeLength,
    profileUrl,
    relativeTime,
    segmentHref,
  } from '$lib/utils/bskyPosts';
  import type { BskyPost, BskyTextSegment } from '$lib/types';

  interface Props {
    post: BskyPost;
    highlighted?: boolean;
    /** Whether the page it links to is saved. */
    isSaved?: boolean;
    onSelect?: () => void;
    /** Read what it links to (the calm reader). */
    onOpenLink?: () => void;
    onToggleSave?: () => void;
  }

  let {
    post,
    highlighted = false,
    isSaved = false,
    onSelect,
    onOpenLink,
    onToggleSave,
  }: Props = $props();

  let link = $derived(bskyPostLink(post));
  let quote = $derived(post.quote && 'uri' in post.quote ? post.quote : null);
  let quoteUnavailable = $derived(post.quote && 'unavailable' in post.quote ? post.quote : null);
  let showMedia = $state(false);
  let asking = $state(false);
  let replying = $state(false);
  let draft = $state('');
  let sending = $state(false);
  let replyInput = $state<HTMLTextAreaElement | null>(null);

  let draftLength = $derived(graphemeLength(draft.trim()));
  let canSend = $derived(draftLength > 0 && draftLength <= POST_MAX_GRAPHEMES && !sending);

  function name(actor: { displayName?: string; handle: string }): string {
    return actor.displayName?.trim() || actor.handle;
  }

  function host(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  /** Every write goes through here: without the permission, ask inline first. */
  function act(run: () => void) {
    if (!bskyFeedsStore.canWrite) {
      asking = true;
      return;
    }
    run();
  }

  function toggleReply() {
    act(() => {
      replying = !replying;
      if (replying) queueMicrotask(() => replyInput?.focus());
    });
  }

  async function sendReply() {
    if (!canSend) return;
    sending = true;
    try {
      const url = await bskyFeedsStore.reply(post, draft.trim());
      draft = '';
      replying = false;
      toastStore.update(toastStore.add(''), 'success', 'Replied', { label: 'View', href: url });
    } catch (err) {
      if ((err as { name?: string })?.name !== 'ScopeUpgradeError') {
        toastStore.update(toastStore.add(''), 'error', "Couldn't post the reply. Try again.");
      }
    } finally {
      sending = false;
    }
  }

  function onReplyKey(e: KeyboardEvent) {
    // Keep j/k and friends from firing while typing.
    e.stopPropagation();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void sendReply();
    } else if (e.key === 'Escape') {
      replying = false;
    }
  }

  // A click on the card's own ground selects it; links and buttons do their thing.
  function onCardClick(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('a, button, textarea, input')) return;
    onSelect?.();
  }
</script>

{#snippet richText(segments: BskyTextSegment[])}
  {#each segments as seg, i (i)}
    {@const href = segmentHref(seg)}
    {#if href}
      <a {href} target="_blank" rel="noopener" class="facet">{seg.text}</a>
    {:else}
      {seg.text}
    {/if}
  {/each}
{/snippet}

<!-- Selecting by click mirrors j/k; keyboard users select with those. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<article class="bsky-post" class:highlighted onclick={onCardClick}>
  {#if post.repostedBy}
    <div class="context-line">
      <Icon name="repeat" size={13} />
      <span
        >Reposted by <a href={profileUrl(post.repostedBy)} target="_blank" rel="noopener"
          >{name(post.repostedBy)}</a
        ></span
      >
    </div>
  {:else if post.pinned}
    <div class="context-line">Pinned</div>
  {/if}

  <div class="post-row">
    <a class="avatar" href={profileUrl(post.author)} target="_blank" rel="noopener" tabindex="-1">
      {#if post.author.avatar}
        <img src={post.author.avatar} alt="" loading="lazy" />
      {:else}
        <span class="avatar-blank"></span>
      {/if}
    </a>

    <div class="post-main">
      <div class="byline">
        <a class="author" href={profileUrl(post.author)} target="_blank" rel="noopener">
          <span class="display-name">{name(post.author)}</span>
          {#if post.author.displayName}<span class="handle">@{post.author.handle}</span>{/if}
        </a>
        <span class="dot" aria-hidden="true">·</span>
        <a
          class="time"
          href={post.url}
          target="_blank"
          rel="noopener"
          title={new Date(post.createdAt).toLocaleString()}>{relativeTime(post.createdAt)}</a
        >
      </div>

      {#if post.replyParent}
        <div class="reply-context">
          {#if 'author' in post.replyParent}
            Replying to <a href={profileUrl(post.replyParent.author)} target="_blank" rel="noopener"
              >{name(post.replyParent.author)}</a
            >{#if post.replyParent.text}<span class="parent-text">: {post.replyParent.text}</span
              >{/if}
          {:else}
            Replying to a post that isn't available
          {/if}
        </div>
      {/if}

      {#if post.text}
        <p class="post-text">{@render richText(post.segments)}</p>
      {/if}

      {#if post.mediaWarning && !showMedia && (post.images || post.video)}
        <div class="media-warning">
          <span>Media hidden ({post.mediaWarning.replace('-', ' ')})</span>
          <button type="button" onclick={() => (showMedia = true)}>Show</button>
        </div>
      {:else}
        {#if post.images}
          <div class="images" data-count={post.images.length}>
            {#each post.images as image, i (i)}
              <a href={image.fullsize} target="_blank" rel="noopener" class="image">
                <img src={image.thumb} alt={image.alt} loading="lazy" />
              </a>
            {/each}
          </div>
        {/if}
        {#if post.video}
          <a
            class="video"
            href={post.url}
            target="_blank"
            rel="noopener"
            aria-label="Play the video on Bluesky"
          >
            {#if post.video.thumbnail}
              <img src={post.video.thumbnail} alt={post.video.alt ?? ''} loading="lazy" />
            {/if}
            <span class="play"><Icon name="play" size={20} /></span>
          </a>
        {/if}
      {/if}

      {#if post.external}
        <button type="button" class="link-card" onclick={() => onOpenLink?.()}>
          {#if post.external.thumb}
            <img src={post.external.thumb} alt="" loading="lazy" class="link-thumb" />
          {/if}
          <span class="link-body">
            <span class="link-host">{host(post.external.uri)}</span>
            {#if post.external.title}<span class="link-title">{post.external.title}</span>{/if}
            {#if post.external.description}
              <span class="link-description">{post.external.description}</span>
            {/if}
          </span>
        </button>
      {/if}

      {#if quote}
        <a class="quote" href={quote.url} target="_blank" rel="noopener">
          <span class="quote-byline">
            {#if quote.author.avatar}<img
                src={quote.author.avatar}
                alt=""
                class="quote-avatar"
              />{/if}
            <span class="display-name">{name(quote.author)}</span>
            <span class="time">{relativeTime(quote.createdAt)}</span>
          </span>
          {#if quote.text}<span class="quote-text">{quote.text}</span>{/if}
          {#if quote.images?.length}
            <span class="quote-media"
              >{quote.images.length === 1 ? 'Image' : `${quote.images.length} images`}</span
            >
          {:else if quote.video}
            <span class="quote-media">Video</span>
          {:else if quote.external}
            <span class="quote-media">{host(quote.external.uri)}</span>
          {/if}
        </a>
      {:else if quoteUnavailable}
        <div class="quote unavailable">
          {quoteUnavailable.unavailable === 'blocked'
            ? 'Quoted post is blocked'
            : quoteUnavailable.unavailable === 'detached'
              ? 'Quoted post was removed by its author'
              : 'Quoted post not found'}
        </div>
      {/if}

      <div class="actions">
        <button
          type="button"
          class="action"
          disabled={post.viewer.replyDisabled}
          title={post.viewer.replyDisabled ? 'Replies are off' : 'Reply'}
          aria-label="Reply"
          aria-expanded={replying}
          onclick={toggleReply}
        >
          <Icon name="message-circle" size={16} />
          {#if post.replyCount > 0}<span>{compactCount(post.replyCount)}</span>{/if}
        </button>
        <button
          type="button"
          class="action"
          class:reposted={!!post.viewer.repost}
          title={post.viewer.repost ? 'Undo repost' : 'Repost'}
          aria-label={post.viewer.repost ? 'Undo repost' : 'Repost'}
          aria-pressed={!!post.viewer.repost}
          disabled={bskyFeedsStore.isPending('repost', post.uri)}
          onclick={() => act(() => void bskyFeedsStore.toggleRepost(post))}
        >
          <Icon name="repeat" size={16} />
          {#if post.repostCount > 0}<span>{compactCount(post.repostCount)}</span>{/if}
        </button>
        <button
          type="button"
          class="action"
          class:liked={!!post.viewer.like}
          title={post.viewer.like ? 'Unlike' : 'Like'}
          aria-label={post.viewer.like ? 'Unlike' : 'Like'}
          aria-pressed={!!post.viewer.like}
          disabled={bskyFeedsStore.isPending('like', post.uri)}
          onclick={() => act(() => void bskyFeedsStore.toggleLike(post))}
        >
          <Icon name="heart" size={16} />
          {#if post.likeCount > 0}<span>{compactCount(post.likeCount)}</span>{/if}
        </button>
        <span class="spacer"></span>
        {#if link}
          <button
            type="button"
            class="action"
            class:saved={isSaved}
            title={isSaved ? 'Saved' : 'Save the link'}
            aria-label={isSaved ? 'Unsave the link' : 'Save the link'}
            aria-pressed={isSaved}
            onclick={() => onToggleSave?.()}
          >
            <Icon name="bookmark" size={16} />
          </button>
          <button
            type="button"
            class="action"
            title="Read in Skyreader"
            aria-label="Read the link in Skyreader"
            onclick={() => onOpenLink?.()}
          >
            <Icon name="book-open" size={16} />
          </button>
        {/if}
        <a
          class="action"
          href={post.url}
          target="_blank"
          rel="noopener"
          title="Open on Bluesky"
          aria-label="Open on Bluesky"
        >
          <Icon name="external-link" size={16} />
        </a>
      </div>

      {#if asking}
        <div class="ask">
          <p>
            To like, repost and reply, Skyreader needs permission to post to Bluesky as you. It only
            posts when you do.
          </p>
          <div class="ask-actions">
            <button type="button" class="btn-quiet" onclick={() => (asking = false)}>Not now</button
            >
            <button type="button" class="btn-primary" onclick={() => bskyFeedsStore.requestWrite()}
              >Allow</button
            >
          </div>
        </div>
      {/if}

      {#if replying}
        <div class="reply-box">
          <textarea
            bind:this={replyInput}
            bind:value={draft}
            rows="3"
            placeholder="Write your reply"
            aria-label="Reply to {name(post.author)}"
            onkeydown={onReplyKey}></textarea>
          <div class="reply-actions">
            <span class="count" class:over={draftLength > POST_MAX_GRAPHEMES}
              >{draftLength}/{POST_MAX_GRAPHEMES}</span
            >
            <button type="button" class="btn-quiet" onclick={() => (replying = false)}
              >Cancel</button
            >
            <button type="button" class="btn-primary" disabled={!canSend} onclick={sendReply}
              >{sending ? 'Replying…' : 'Reply'}</button
            >
          </div>
        </div>
      {/if}
    </div>
  </div>
</article>

<style>
  .bsky-post {
    padding: 0.75rem 1rem;
    border-radius: 8px;
    color: var(--color-text);
  }

  .bsky-post:hover {
    background-color: rgba(128, 128, 128, 0.05);
  }

  .bsky-post.highlighted {
    background-color: rgba(96, 165, 250, 0.05);
  }

  .bsky-post.highlighted:hover {
    background-color: rgba(96, 165, 250, 0.08);
  }

  a {
    color: inherit;
  }

  .context-line {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin: 0 0 0.375rem 1.75rem;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .context-line a {
    text-decoration: none;
  }

  .context-line a:hover {
    text-decoration: underline;
  }

  .post-row {
    display: flex;
    gap: 0.75rem;
  }

  .avatar {
    flex-shrink: 0;
    width: 36px;
    height: 36px;
  }

  .avatar img,
  .avatar-blank {
    display: block;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    object-fit: cover;
    background: var(--color-border);
  }

  .post-main {
    flex: 1;
    min-width: 0;
  }

  .byline {
    display: flex;
    align-items: baseline;
    gap: 0.25rem;
    min-width: 0;
    font-size: var(--text-sm);
    white-space: nowrap;
  }

  .author {
    display: inline-flex;
    align-items: baseline;
    gap: 0.25rem;
    min-width: 0;
    overflow: hidden;
    text-decoration: none;
  }

  .display-name {
    font-weight: var(--weight-medium);
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .handle,
  .dot,
  .time {
    color: var(--color-text-secondary);
  }

  .handle {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .time {
    flex-shrink: 0;
    text-decoration: none;
  }

  .author:hover .display-name,
  .time:hover {
    text-decoration: underline;
  }

  .reply-context {
    margin-top: 0.125rem;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .reply-context a {
    text-decoration: none;
    font-weight: var(--weight-medium);
  }

  .post-text {
    margin: 0.25rem 0 0;
    font-size: var(--text-md);
    line-height: var(--leading-normal);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .facet {
    color: var(--color-primary);
    text-decoration: none;
  }

  .facet:hover {
    text-decoration: underline;
  }

  .images {
    display: grid;
    gap: 0.25rem;
    margin-top: 0.5rem;
    max-width: 32rem;
    border-radius: 8px;
    overflow: hidden;
  }

  .images[data-count='2'],
  .images[data-count='4'] {
    grid-template-columns: 1fr 1fr;
  }

  .images[data-count='3'] {
    grid-template-columns: 1fr 1fr 1fr;
  }

  .image img {
    display: block;
    width: 100%;
    max-height: 22rem;
    object-fit: cover;
    background: var(--color-border);
  }

  .images:not([data-count='1']) .image img {
    aspect-ratio: 1;
  }

  .video {
    position: relative;
    display: block;
    margin-top: 0.5rem;
    max-width: 32rem;
    min-height: 6rem;
    border-radius: 8px;
    overflow: hidden;
    background: var(--color-border);
  }

  .video img {
    display: block;
    width: 100%;
    max-height: 22rem;
    object-fit: cover;
  }

  .play {
    position: absolute;
    inset: 50% auto auto 50%;
    transform: translate(-50%, -50%);
    display: flex;
    padding: 0.625rem;
    border-radius: 50%;
    color: #fff;
    background: rgba(0, 0, 0, 0.55);
  }

  .media-warning {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin-top: 0.5rem;
    max-width: 32rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .media-warning button {
    font: inherit;
    color: var(--color-primary);
    background: none;
    border: none;
    cursor: pointer;
  }

  .link-card {
    display: flex;
    width: 100%;
    max-width: 32rem;
    margin-top: 0.5rem;
    padding: 0;
    overflow: hidden;
    text-align: left;
    font: inherit;
    color: inherit;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    cursor: pointer;
  }

  .link-card:hover {
    border-color: var(--color-primary);
  }

  .link-thumb {
    flex-shrink: 0;
    width: 6.5rem;
    object-fit: cover;
    background: var(--color-border);
  }

  .link-body {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
    padding: 0.5rem 0.75rem;
  }

  .link-host {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .link-title {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .link-description {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .quote {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    max-width: 32rem;
    margin-top: 0.5rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    font-size: var(--text-sm);
    text-decoration: none;
  }

  a.quote:hover {
    border-color: var(--color-text-secondary);
  }

  .quote.unavailable {
    color: var(--color-text-secondary);
  }

  .quote-byline {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-width: 0;
    white-space: nowrap;
  }

  .quote-avatar {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    object-fit: cover;
  }

  .quote-text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 6;
    line-clamp: 6;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .quote-media {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    margin: 0.375rem 0 -0.25rem -0.375rem;
  }

  .spacer {
    flex: 1;
  }

  .action {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    min-width: 2rem;
    min-height: 2rem;
    padding: 0.25rem 0.375rem;
    font: inherit;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    background: none;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    text-decoration: none;
  }

  .action:hover:not(:disabled) {
    color: var(--color-text);
    background: rgba(128, 128, 128, 0.08);
  }

  .action:disabled {
    cursor: default;
    opacity: 0.5;
  }

  .action:focus-visible,
  .link-card:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  /* Done states are the one blue (DESIGN.md, the Reserved Color Rule), not
     Bluesky's pink and green: a like is a state, like a save. */
  .action.liked,
  .action.reposted,
  .action.saved {
    color: var(--color-primary);
  }

  .action.liked :global(svg path),
  .action.saved :global(svg path) {
    fill: currentColor;
  }

  .ask,
  .reply-box {
    margin-top: 0.5rem;
    max-width: 32rem;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
  }

  .ask p {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--leading-normal);
  }

  .ask-actions,
  .reply-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  .reply-box {
    padding: 0.5rem;
  }

  .reply-box textarea {
    display: block;
    width: 100%;
    box-sizing: border-box;
    padding: 0.375rem;
    font: inherit;
    font-size: var(--text-md);
    line-height: var(--leading-normal);
    color: var(--color-text);
    background: transparent;
    border: none;
    resize: vertical;
    outline: none;
  }

  .count {
    margin-right: auto;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .count.over {
    color: var(--color-error);
  }

  .btn-quiet,
  .btn-primary {
    padding: 0.3125rem 0.75rem;
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    border-radius: 6px;
    cursor: pointer;
  }

  .btn-quiet {
    color: var(--color-text-secondary);
    background: transparent;
    border: 1px solid transparent;
  }

  .btn-quiet:hover {
    color: var(--color-text);
  }

  .btn-primary {
    color: #fff;
    background: var(--color-primary);
    border: 1px solid var(--color-primary);
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--color-primary-dark);
  }

  .btn-primary:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
