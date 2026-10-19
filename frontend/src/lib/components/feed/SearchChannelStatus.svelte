<script lang="ts">
  // What a saved search is matching and where it stands: a quiet line above
  // its matches, or the empty state in their place. Every message waits on
  // something the reader can see or do, so none of it is a banner.
  import EmptyState from '$lib/components/EmptyState.svelte';
  import { searchChannelsStore } from '$lib/stores/searchChannels.svelte';
  import { feedViewStore } from '$lib/stores/feedView.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { syncStore } from '$lib/stores/sync.svelte';

  interface Props {
    /** The channel has nothing to show: render the empty state, not the line. */
    empty: boolean;
    onEdit?: () => void;
  }

  let { empty, onEdit }: Props = $props();

  let query = $derived(feedViewStore.searchQuery ?? '');
  let limit = $derived(auth.user?.limits?.maxSavedSearches ?? 0);
  let error = $derived(searchChannelsStore.error);
  // A channel just made has nothing to show until its first answer, which is
  // part of looking back, not "no matches".
  let lookingBack = $derived(
    searchChannelsStore.backfilling ||
      error === 'not_ready' ||
      (!searchChannelsStore.loaded && error === null)
  );
</script>

{#if empty}
  {#if error === 'upgrade'}
    <EmptyState
      title="Saved searches come with Supporter"
      description="This channel keeps its search, and fills again on a Supporter plan."
      actionHref="/supporter"
      actionText="About Supporter"
    />
  {:else if error === 'off'}
    <EmptyState
      title="Saved searches are paused"
      description="This channel keeps its search. Matches come back when saved searches do."
    />
  {:else if error === 'offline' || (!syncStore.isOnline && !searchChannelsStore.loaded)}
    <EmptyState title="You're offline" description="This search loads when you're back online." />
  {:else if error === 'failed'}
    <EmptyState
      title="Couldn't load this search"
      description="Skyreader didn't answer. Try again in a bit."
      onAction={() => void searchChannelsStore.retry()}
      actionText="Try again"
    />
  {:else if searchChannelsStore.status === 'over_limit'}
    <EmptyState
      title="Past your plan's saved searches"
      description={`Your plan keeps ${limit} saved ${limit === 1 ? 'search' : 'searches'}, so nothing new lands here.`}
    />
  {:else if lookingBack}
    <div class="looking" role="status">
      <span class="sweep" aria-hidden="true"></span>
      <EmptyState
        title="Looking back through the last 30 days"
        description={`Anything that matches “${query}” lands here as it's found.`}
      />
    </div>
  {:else if feedViewStore.showOnlyUnread && searchChannelsStore.matches.length > 0}
    <EmptyState title="All caught up" description={`Nothing unread matches “${query}”.`} />
  {:else}
    <EmptyState
      title="No matches yet"
      description={`Nothing from the last 30 days matches “${query}”. New items that do will land here.`}
      onAction={onEdit}
      actionText={onEdit ? 'Edit search' : undefined}
    />
  {/if}
{:else}
  <p class="search-status" aria-live="polite">
    <span class="query">Matching <q>{query}</q></span>
    {#if lookingBack}
      <span class="state"
        ><span class="dot" aria-hidden="true"></span>Still looking back through the last 30 days.</span
      >
    {:else if searchChannelsStore.status === 'over_limit'}
      <span class="state"
        >Past your plan's {limit} saved {limit === 1 ? 'search' : 'searches'}, so nothing new
        arrives here.</span
      >
    {:else if error === 'offline'}
      <span class="state">Offline. This is what was here last.</span>
    {/if}
  </p>
{/if}

<style>
  .search-status {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.5rem;
    margin: 0 0 0.5rem;
    padding: 0 0.25rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .query q {
    color: var(--color-text);
  }

  /* A slow sweep while the look back runs, so a new channel reads as working. */
  .looking {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding-top: 2rem;
  }

  .sweep {
    position: relative;
    width: 8rem;
    height: 2px;
    border-radius: 1px;
    overflow: hidden;
    background: var(--color-border);
  }

  .sweep::after {
    content: '';
    position: absolute;
    inset: 0;
    width: 40%;
    border-radius: 1px;
    background: var(--color-primary);
    animation: sweep 1.6s ease-in-out infinite;
  }

  @keyframes sweep {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(250%);
    }
  }

  .dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    margin-right: 0.375rem;
    border-radius: 50%;
    background: var(--color-primary);
    vertical-align: middle;
    animation: pulse 1.6s ease-in-out infinite;
  }

  @keyframes pulse {
    50% {
      opacity: 0.3;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .sweep::after,
    .dot {
      animation: none;
    }
  }
</style>
