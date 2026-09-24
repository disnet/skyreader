<script lang="ts">
  // Home's first read: the links people you follow shared on Bluesky this week,
  // as a short list. A new account has no feeds and no saves yet, but it does
  // have a Following timeline, so this is the one thing Home can offer to read
  // before any setup. Covers the whole path: the permission ask (a fresh sign-in
  // doesn't carry the timeline scope), the first gather, the links, and the
  // quiet ends (nothing shared, timeline unreachable). Lanes take over once the
  // reader has a library. See docs/plans/FOLLOWS_LINKS_PLAN.md.
  import Icon from '$lib/components/Icon.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { followLinksStore } from '$lib/stores/followLinks.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { getFaviconUrl } from '$lib/utils/favicon';
  import {
    followLinkReadKey,
    followLinkSaid,
    followLinkTitle,
    sharedByLabel,
  } from '$lib/utils/followLinks';
  import { FOLLOWING_PATH, grantFollowsAccess } from '$lib/utils/followsChannel';
  import type { FollowLink } from '$lib/types';

  interface Props {
    onOpen: (link: FollowLink) => void;
    /** How many links to list before "See all". */
    limit?: number;
  }

  let { onOpen, limit = 6 }: Props = $props();

  let links = $derived(followLinksStore.links.slice(0, limit));

  // Nothing has answered yet, or the first refresh is still walking the
  // timeline with nothing found so far.
  let waiting = $derived(
    !followLinksStore.scopeRequired &&
      followLinksStore.links.length === 0 &&
      ((!followLinksStore.loaded && !followLinksStore.error) || followLinksStore.gathering)
  );

  function avatarsOf(link: FollowLink): string[] {
    return link.sharers
      .map((s) => s.avatar)
      .filter((a): a is string => !!a)
      .slice(0, 3);
  }
</script>

<section class="follows-start" aria-labelledby="follows-start-title">
  {#if followLinksStore.scopeRequired}
    <div class="invite">
      <h2 id="follows-start-title">See what people you follow are sharing</h2>
      <p>
        Skyreader can gather the links from your Bluesky Following timeline, so you can read them
        here without the timeline.
      </p>
      <div class="invite-actions">
        <button
          type="button"
          class="primary"
          disabled={auth.grantingPermissions}
          onclick={() => grantFollowsAccess('/home')}
        >
          <Icon name="share-2" size={16} />
          {auth.grantingPermissions ? 'Opening Bluesky…' : 'Allow access'}
        </button>
        <span class="invite-note">Bluesky asks you to confirm, then brings you back.</span>
      </div>
    </div>
  {:else}
    <header class="head">
      <h2 id="follows-start-title">Shared by people you follow</h2>
      <p class="head-meta">This week on Bluesky</p>
    </header>

    {#if waiting}
      <ul class="rows" aria-hidden="true">
        {#each [0, 1, 2] as i (i)}
          <li class="row skeleton">
            <div class="row-text">
              <div class="bar"></div>
              <div class="bar short"></div>
            </div>
            <div class="thumb"></div>
          </li>
        {/each}
      </ul>
      <p class="status" role="status">
        Reading your Following timeline. This takes a few seconds the first time.
      </p>
    {:else if links.length > 0}
      <ul class="rows">
        {#each links as link (link.urlNormalized)}
          {@const said = followLinkSaid(link)}
          {@const avatars = avatarsOf(link)}
          {@const title = followLinkTitle(link)}
          <li>
            <button
              type="button"
              class="row"
              class:read={itemLabelsStore.isRead(followLinkReadKey(link))}
              onclick={() => onOpen(link)}
            >
              <span class="row-text">
                <span class="title">{title}</span>
                <span class="source">
                  <img class="favicon" src={getFaviconUrl(link.url)} alt="" loading="lazy" />
                  {link.site}
                </span>
                {#if said}
                  <span class="said">“{said.text}”</span>
                {/if}
                <span class="sharers">
                  {#if avatars.length > 0}
                    <span class="avatars">
                      {#each avatars as avatar (avatar)}
                        <img src={avatar} alt="" loading="lazy" />
                      {/each}
                    </span>
                  {/if}
                  {sharedByLabel(link.sharers)}
                </span>
              </span>
              {#if link.thumb}
                <img class="thumb" src={link.thumb} alt="" loading="lazy" />
              {/if}
            </button>
          </li>
        {/each}
      </ul>
      <a class="see-all" href={FOLLOWING_PATH}>
        See all shared this week
        <Icon name="arrow-right" size={14} />
      </a>
    {:else if followLinksStore.error}
      <p class="status">
        Couldn't reach your Bluesky timeline.
        <button type="button" class="link-button" onclick={() => followLinksStore.load(true)}>
          Try again
        </button>
      </p>
    {:else}
      <p class="status">
        Nothing shared by people you follow this week. New links show up here as they're posted.
      </p>
    {/if}
  {/if}
</section>

<style>
  .follows-start {
    min-width: 0;
  }

  /* The ask: a flat tinted panel like FollowsIntro. It sits in the page as a
     standing question, it doesn't float over it. */
  .invite {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    padding: 1.25rem 1.25rem 1.125rem;
    background: var(--color-bg-secondary);
    border: 1px solid var(--color-border);
    border-radius: 10px;
  }

  h2 {
    margin: 0;
    font-size: var(--text-xl);
    font-weight: var(--weight-semibold);
    line-height: var(--leading-tight);
    letter-spacing: var(--tracking-tight);
    color: var(--color-text);
    text-wrap: balance;
  }

  .invite p {
    margin: 0;
    max-width: 52ch;
    font-size: var(--text-md);
    line-height: var(--leading-normal);
    color: var(--color-text-secondary);
  }

  .invite-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.875rem;
    margin-top: 0.375rem;
  }

  .primary {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    font: inherit;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    color: #fff;
    background: var(--color-primary);
    border: 1px solid var(--color-primary);
    border-radius: var(--radius-md, 6px);
    cursor: pointer;
    transition: background-color 0.15s ease;
  }

  .primary:hover:not(:disabled) {
    background: var(--color-primary-dark);
    border-color: var(--color-primary-dark);
  }

  .primary:disabled {
    opacity: 0.7;
    cursor: default;
  }

  .invite-note {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.25rem 1rem;
    padding: 0 0.25rem 0.625rem;
  }

  .head-meta {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  /* A list, not a grid of cards: rows separated by hairlines, like the feed. */
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    border-top: 1px solid var(--color-border);
  }

  .rows > li {
    border-bottom: 1px solid var(--color-border);
  }

  .row {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
    width: 100%;
    padding: 0.875rem 0.25rem;
    font: inherit;
    text-align: left;
    color: inherit;
    background: none;
    border: none;
    cursor: pointer;
    transition: background-color 0.15s ease;
  }

  button.row:hover {
    background: var(--color-bg-secondary);
  }

  button.row:focus-visible,
  .see-all:focus-visible,
  .link-button:focus-visible,
  .primary:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  .row-text {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    flex: 1;
    min-width: 0;
  }

  .title {
    font-size: var(--text-base);
    line-height: var(--leading-snug);
    color: var(--color-text);
    overflow-wrap: anywhere;
  }

  /* Read links recede the way read rows do in the river; the weight and color
     change is the cue, not color alone. */
  .row.read .title {
    color: var(--color-text-secondary);
  }

  .source {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .favicon {
    width: 14px;
    height: 14px;
    border-radius: 3px;
    flex-shrink: 0;
  }

  .said {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    max-width: 62ch;
    font-size: var(--text-sm);
    line-height: var(--leading-normal);
    color: var(--color-text-secondary);
  }

  .sharers {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.125rem;
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    color: var(--color-text-secondary);
  }

  .avatars {
    display: inline-flex;
  }

  .avatars img {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 2px solid var(--color-bg);
    object-fit: cover;
    background: var(--color-bg-secondary);
  }

  .avatars img + img {
    margin-left: -6px;
  }

  .thumb {
    width: 5.5rem;
    height: 4.25rem;
    flex-shrink: 0;
    border-radius: 6px;
    object-fit: cover;
    background: var(--color-bg-secondary);
  }

  @media (max-width: 640px) {
    .thumb {
      width: 4.25rem;
      height: 4.25rem;
    }
  }

  .skeleton {
    cursor: default;
  }

  .bar {
    height: 0.8rem;
    width: 80%;
    border-radius: 4px;
    background: var(--color-bg-secondary);
  }

  .bar.short {
    width: 40%;
  }

  .skeleton .bar,
  .skeleton .thumb {
    animation: pulse 1.4s ease-in-out infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.45;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .skeleton .bar,
    .skeleton .thumb {
      animation: none;
    }

    .row,
    .primary {
      transition: none;
    }
  }

  .status {
    margin: 0.875rem 0.25rem 0;
    max-width: 52ch;
    font-size: var(--text-sm);
    line-height: var(--leading-normal);
    color: var(--color-text-secondary);
  }

  .see-all {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    margin: 0.75rem 0.25rem 0;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-primary);
    text-decoration: none;
  }

  .see-all:hover {
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .link-button {
    padding: 0;
    border: none;
    background: none;
    color: var(--color-primary);
    font: inherit;
    cursor: pointer;
  }

  .link-button:hover {
    text-decoration: underline;
  }
</style>
