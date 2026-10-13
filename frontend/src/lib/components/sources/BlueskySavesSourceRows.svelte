<script lang="ts">
  // Your Bluesky likes and bookmarks as sources: the posts you liked or
  // bookmarked that link somewhere become articles to read here, so something
  // spotted in a Bluesky client is one tap from the reader (and from Saved).
  // Each is one private subscription, gathered server-side; see
  // $lib/utils/bskySources.ts. Shaped like FollowsSourceRow: a text action,
  // because "Allow" needs words.
  import { onMount } from 'svelte';
  import Icon, { type IconName } from '$lib/components/Icon.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { appManager } from '$lib/stores/app.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { articlesStore } from '$lib/stores/articles.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { fetchSingleFeed } from '$lib/services/feedFetcher';
  import { api, SubscriptionLimitError, type BlueskySourcesStatus } from '$lib/services/api';
  import type { BskySourceKind } from '$lib/utils/bskySources';
  import { feedLimitLine } from '$lib/utils/limitCopy';

  // Where the bookmarks permission comes back to: this section, which then
  // finishes turning the source on.
  const GRANT_PARAM = 'bluesky';
  const GRANT_RETURN = `/sources?${GRANT_PARAM}=bookmarks#bluesky`;

  const ROWS: { kind: BskySourceKind; icon: IconName; title: string; meta: string }[] = [
    {
      kind: 'likes',
      icon: 'heart',
      title: 'Your Bluesky likes',
      meta: 'Posts you like that link somewhere, as articles to read.',
    },
    {
      kind: 'bookmarks',
      icon: 'bookmark',
      title: 'Your Bluesky bookmarks',
      meta: 'Posts you bookmark that link somewhere. Your bookmarks stay private.',
    },
  ];

  let status = $state<BlueskySourcesStatus | null>(null);
  let busy = $state<BskySourceKind | null>(null);

  onMount(() => {
    void (async () => {
      try {
        status = await api.getBlueskySources();
      } catch (e) {
        console.error('Failed to load Bluesky sources:', e);
        return;
      }
      // Back from granting the bookmarks permission: finish what the reader
      // started, then drop the param so a reload doesn't repeat it.
      const url = new URL(window.location.href);
      if (url.searchParams.get(GRANT_PARAM) === 'bookmarks') {
        url.searchParams.delete(GRANT_PARAM);
        history.replaceState(history.state, '', url);
        // Turn it on, or, when it was already on but refused for want of the
        // permission, ask again so its next walk runs with the new grant.
        const b = status.bookmarks;
        if (b.enabled ? b.error === 'scope_denied' : !b.scopeRequired) {
          await setEnabled('bookmarks', true);
        }
      }
    })();
  });

  async function setEnabled(kind: BskySourceKind, enabled: boolean) {
    busy = kind;
    try {
      status = await api.setBlueskySource(kind, enabled);
      // Turned on past the plan's active limit: it's in, but parked.
      if (enabled && status[kind].parked) {
        toastStore.update(
          toastStore.add(''),
          'error',
          feedLimitLine(subscriptionsStore.maxSubscriptions, { onSources: true })
        );
      }
      // The subscription was made (or removed) server-side; pull it into the
      // reader, and fetch a new one's first items straight away.
      await appManager.syncSubscriptions();
      if (enabled) {
        const sub = subscriptionsStore.subscriptions.find(
          (s) => s.feedUrl === `bsky-${kind}:${auth.user?.did}`
        );
        if (sub) await fetchSingleFeed(sub, true, articlesStore.savedGuids);
      }
    } catch (e) {
      const message =
        e instanceof SubscriptionLimitError
          ? feedLimitLine(subscriptionsStore.maxSubscriptions, { onSources: true })
          : enabled
            ? 'Couldn’t add that source. Try again in a moment.'
            : 'Couldn’t remove that source. Try again in a moment.';
      toastStore.update(toastStore.add(''), 'error', message);
    } finally {
      busy = null;
    }
  }
</script>

{#each ROWS as row, i (row.kind)}
  {@const s = status?.[row.kind]}
  <div class="bluesky-row" id={i === 0 ? 'bluesky' : undefined}>
    <div class="bluesky-icon"><Icon name={row.icon} size={16} /></div>

    <div class="bluesky-info">
      <span class="bluesky-title">{row.title}</span>
      <span class="bluesky-meta">
        {s?.parked ? 'Parked. Nothing new arrives until it’s active again.' : row.meta}
      </span>
    </div>

    <!-- Permission first: an enabled source without it (granted on another
         device, or refused by the PDS) gathers nothing until it's allowed. -->
    {#if s?.scopeRequired}
      <button
        type="button"
        class="bluesky-action primary"
        disabled={auth.grantingPermissions}
        onclick={() => auth.grantPermissions(['bskyBookmarks'], GRANT_RETURN)}
      >
        Allow
      </button>
    {/if}
    {#if s?.enabled}
      <button
        type="button"
        class="bluesky-action"
        disabled={busy !== null}
        onclick={() => setEnabled(row.kind, false)}
      >
        Remove
      </button>
    {:else if s && !s.scopeRequired}
      <button
        type="button"
        class="bluesky-action primary"
        disabled={busy !== null}
        onclick={() => setEnabled(row.kind, true)}
      >
        {busy === row.kind ? 'Adding…' : 'Add'}
      </button>
    {/if}
  </div>
{/each}

<style>
  .bluesky-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem 0.75rem;
    background: var(--color-bg);
    scroll-margin-top: 4rem;
  }

  .bluesky-icon {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-secondary);
  }

  .bluesky-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .bluesky-title {
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
  }

  .bluesky-meta {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    line-height: var(--leading-normal);
  }

  .bluesky-action {
    flex-shrink: 0;
    padding: 0.3125rem 0.75rem;
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-primary);
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 6px);
    cursor: pointer;
  }

  .bluesky-action:hover {
    border-color: var(--color-primary);
  }

  .bluesky-action.primary {
    color: #fff;
    background: var(--color-primary);
    border-color: var(--color-primary);
  }

  .bluesky-action.primary:hover {
    background: var(--color-primary-dark);
  }

  .bluesky-action:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .bluesky-action:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
</style>
