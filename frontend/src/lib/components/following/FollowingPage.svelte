<script lang="ts">
  // From your follows: the links people you follow are sharing on Bluesky, one
  // row per article, ranked by how many of them shared it. Opening a row reads
  // it in the calm reader without saving it (the rooms path). The list ends;
  // there is no infinite scroll. See docs/plans/FOLLOWS_LINKS_PLAN.md.
  import SavedReader from '$lib/components/feed/SavedReader.svelte';
  import StaticPageChrome from '$lib/components/feed/StaticPageChrome.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { useReaderStack } from '$lib/hooks/useReaderStack.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { followLinksStore } from '$lib/stores/followLinks.svelte';
  import { getFaviconUrl } from '$lib/utils/favicon';
  import { decodeEntities } from '$lib/utils/entities';
  import { formatRelativeTime } from '$lib/utils/date';
  import {
    bskyPostUrl,
    followLinkTitle,
    openFollowLink,
    sharedByLabel,
  } from '$lib/utils/followLinks';
  import type { FollowLink, FollowLinksWindow } from '$lib/types';

  const reader = useReaderStack();

  const WINDOWS: { value: FollowLinksWindow; label: string }[] = [
    { value: '24h', label: 'Day' },
    { value: '3d', label: '3 days' },
    { value: '7d', label: 'Week' },
  ];

  // Wait for the account: a hard load can run this before auth hydrates, and
  // the layout sends a guest through sign-in anyway.
  $effect(() => {
    if (!auth.isAuthenticated) return;
    void followLinksStore.load();
  });

  let expanded = $state<Record<string, boolean>>({});
  let openingUrl = $state<string | null>(null);

  async function open(link: FollowLink) {
    if (openingUrl) return;
    openingUrl = link.url;
    try {
      await openFollowLink(link, reader);
    } finally {
      openingUrl = null;
    }
  }

  function grantAccess() {
    // Progressive scopes: ask for just the timeline permission and come back
    // here still signed in.
    void auth.grantPermissions(['follows'], '/following');
  }

  const windowLabel = $derived(
    followLinksStore.window === '24h'
      ? 'today'
      : followLinksStore.window === '3d'
        ? 'in the last 3 days'
        : 'this week'
  );
</script>

<StaticPageChrome title="From your follows" readerOpen={reader.readerItem !== null} />

<div class="following">
  <header class="following-head">
    <p class="following-lede">
      What the people you follow on Bluesky are sharing, one article at a time.
    </p>
    {#if !followLinksStore.scopeRequired}
      <div class="following-windows" role="group" aria-label="Time window">
        {#each WINDOWS as w (w.value)}
          <button
            type="button"
            class="following-window"
            aria-pressed={followLinksStore.window === w.value}
            onclick={() => void followLinksStore.load(w.value)}
          >
            {w.label}
          </button>
        {/each}
      </div>
    {/if}
  </header>

  {#if followLinksStore.scopeRequired}
    <aside class="following-ask">
      <h2>See what your follows are sharing</h2>
      <p>
        Skyreader can read your Bluesky Following timeline and gather the links in it, so you can
        read them here, calmly, without the timeline. It keeps them for a week and never posts
        anything.
      </p>
      <button
        type="button"
        class="following-ask-btn"
        disabled={auth.grantingPermissions}
        onclick={grantAccess}
      >
        Allow access
      </button>
    </aside>
  {:else if followLinksStore.links.length === 0}
    {#if followLinksStore.gathering}
      <p class="following-quiet">Gathering links from your timeline.</p>
    {:else if followLinksStore.error && !followLinksStore.complete}
      <p class="following-quiet">Couldn't reach your Bluesky timeline. Try again in a bit.</p>
    {:else if !followLinksStore.loading}
      <p class="following-quiet">
        Nothing shared {windowLabel}.
        {#if followLinksStore.window !== '7d'}
          <button type="button" class="following-inline" onclick={() => followLinksStore.load('7d')}
            >Look at the week</button
          >
        {/if}
      </p>
    {/if}
  {:else}
    <ul class="following-list">
      {#each followLinksStore.links as link (link.urlNormalized)}
        {@const title = followLinkTitle(link)}
        <li class="following-row">
          <div class="following-item">
            <button
              type="button"
              class="following-open"
              class:opened={link.opened}
              onclick={() => open(link)}
              disabled={openingUrl !== null}
            >
              <span class="following-main">
                <span class="following-title">
                  {title}
                  {#if openingUrl === link.url}<span class="following-opening">Opening</span>{/if}
                </span>
                {#if link.description}
                  <span class="following-description">{decodeEntities(link.description)}</span>
                {/if}
                <span class="following-meta">
                  <img src={getFaviconUrl(link.url)} alt="" width="12" height="12" />
                  {link.site} · {formatRelativeTime(link.lastSharedAt)}
                </span>
              </span>
              {#if link.thumb}
                <img class="following-thumb" src={link.thumb} alt="" loading="lazy" />
              {/if}
            </button>

            <div class="following-readers">
              <span class="following-avatars" aria-hidden="true">
                {#each link.sharers.slice(0, 5) as s (s.did)}
                  <span class="following-avatar">
                    {#if s.avatar}
                      <img src={s.avatar} alt="" />
                    {:else}
                      <span class="following-avatar-fallback">
                        {(s.name || s.handle || '?').slice(0, 1).toUpperCase()}
                      </span>
                    {/if}
                  </span>
                {/each}
              </span>
              <button
                type="button"
                class="following-said"
                aria-expanded={!!expanded[link.urlNormalized]}
                onclick={() =>
                  (expanded = {
                    ...expanded,
                    [link.urlNormalized]: !expanded[link.urlNormalized],
                  })}
              >
                {sharedByLabel(link.sharers)}
                <Icon
                  name={expanded[link.urlNormalized] ? 'chevron-up' : 'chevron-down'}
                  size={12}
                />
              </button>
            </div>

            {#if expanded[link.urlNormalized]}
              <ul class="following-comments">
                {#each link.sharers as s (s.did)}
                  <li class="following-comment">
                    <span class="following-comment-who">
                      {s.name || s.handle || 'Someone'}
                      <span class="following-comment-when">
                        {s.kind === 'repost' ? 'reposted' : 'shared'}
                        {formatRelativeTime(s.sharedAt)}
                      </span>
                    </span>
                    {#if s.text && s.kind !== 'repost'}
                      <span class="following-comment-text">{s.text}</span>
                    {/if}
                    <a
                      class="following-comment-link"
                      href={bskyPostUrl(s.postUri)}
                      target="_blank"
                      rel="noopener"
                    >
                      View on Bluesky
                    </a>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>

          <button
            type="button"
            class="following-dismiss"
            title="Hide this link"
            aria-label="Hide this link"
            onclick={() => followLinksStore.dismiss(link.url, link.urlNormalized)}
          >
            <Icon name="x" size={14} />
          </button>
        </li>
      {/each}
    </ul>
    {#if followLinksStore.gathering || followLinksStore.refreshing}
      <p class="following-quiet following-tail">Checking your timeline for more.</p>
    {/if}
  {/if}
</div>

{#if reader.readerItem}
  <SavedReader readerItem={reader.readerItem} onClose={reader.closeReader} />
{/if}

<style>
  .following {
    max-width: 42rem;
    margin: 0 auto;
    padding: 2rem 1.25rem 4rem;
  }

  /* Clear the mobile bottom bar, which this page carries. */
  @media (max-width: 1000px) {
    .following {
      padding-top: 1rem;
      padding-bottom: calc(var(--bottom-bar-height) + var(--safe-area-bottom) + 4rem);
    }
  }

  .following-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
    margin-bottom: 0.75rem;
  }

  .following-lede {
    margin: 0;
    color: var(--color-text-secondary);
    font-size: var(--text-md);
  }

  .following-windows {
    display: inline-flex;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    overflow: hidden;
  }

  .following-window {
    padding: 0.25rem 0.625rem;
    border: none;
    background: none;
    font: inherit;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .following-window + .following-window {
    border-left: 1px solid var(--color-border);
  }

  .following-window[aria-pressed='true'] {
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }

  /* The permission ask: flat, a bordered block in the flow (DESIGN.md). */
  .following-ask {
    margin-top: 1rem;
    padding: 1rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg-secondary);
  }

  .following-ask h2 {
    margin: 0 0 0.375rem;
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
  }

  .following-ask p {
    margin: 0 0 0.875rem;
    font-size: var(--text-md);
    line-height: 1.5;
    color: var(--color-text-secondary);
  }

  .following-ask-btn {
    padding: 0.4375rem 0.875rem;
    border: none;
    border-radius: 6px;
    background: var(--color-primary);
    color: #fff;
    font: inherit;
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
  }

  .following-quiet {
    color: var(--color-text-secondary);
    font-size: var(--text-md);
  }

  .following-tail {
    font-size: var(--text-sm);
  }

  .following-inline {
    border: none;
    background: none;
    padding: 0;
    font: inherit;
    color: var(--color-primary);
    cursor: pointer;
  }

  .following-inline:hover {
    text-decoration: underline;
  }

  .following-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .following-row {
    display: flex;
    align-items: flex-start;
    border-bottom: 1px solid var(--color-border);
  }

  .following-item {
    flex: 1;
    min-width: 0;
    padding: 0.875rem 0;
  }

  .following-open {
    display: flex;
    align-items: flex-start;
    gap: 0.875rem;
    width: 100%;
    padding: 0;
    border: none;
    background: none;
    text-align: left;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .following-open:disabled {
    cursor: default;
  }

  .following-open:hover .following-title {
    color: var(--color-primary);
  }

  .following-main {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }

  .following-title {
    font-size: var(--text-base);
    font-weight: 500;
    line-height: 1.35;
  }

  /* Opened reads like a read item in the river: quieter, still there. */
  .following-open.opened .following-title {
    color: var(--color-text-secondary);
    font-weight: 400;
  }

  .following-opening {
    margin-left: 0.5rem;
    font-size: var(--text-sm);
    font-weight: 400;
    color: var(--color-text-secondary);
  }

  .following-description {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .following-meta {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .following-thumb {
    flex-shrink: 0;
    width: 4rem;
    height: 4rem;
    object-fit: cover;
    border-radius: 4px;
    background: var(--color-bg-secondary);
  }

  .following-readers {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  .following-avatars {
    display: flex;
  }

  .following-avatar {
    display: block;
    width: 20px;
    height: 20px;
    margin-left: -6px;
    border: 1.5px solid var(--color-bg);
    border-radius: 50%;
    overflow: hidden;
    background: var(--color-bg-secondary);
  }

  .following-avatar:first-child {
    margin-left: 0;
  }

  .following-avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .following-avatar-fallback {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .following-said {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0;
    border: none;
    background: none;
    font: inherit;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .following-said:hover {
    color: var(--color-text);
  }

  .following-comments {
    list-style: none;
    margin: 0.625rem 0 0;
    padding: 0 0 0 0.75rem;
    border-left: 2px solid var(--color-border);
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  .following-comment {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    font-size: var(--text-sm);
  }

  .following-comment-who {
    font-weight: 500;
  }

  .following-comment-when {
    font-weight: 400;
    color: var(--color-text-secondary);
  }

  .following-comment-text {
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .following-comment-link {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    text-decoration: none;
  }

  .following-comment-link:hover {
    color: var(--color-primary);
    text-decoration: underline;
  }

  .following-dismiss {
    display: flex;
    align-items: center;
    padding: 0.25rem;
    margin: 0.75rem 0 0 0.5rem;
    border: none;
    border-radius: 4px;
    background: none;
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .following-dismiss:hover {
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }
</style>
