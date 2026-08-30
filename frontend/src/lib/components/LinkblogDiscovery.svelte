<script lang="ts">
  import { onMount } from 'svelte';
  import { linkblogDiscoveryStore } from '$lib/stores/linkblogDiscovery.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import type { LinkblogPerson } from '$lib/types';
  import DiscoveryToolbar from './DiscoveryToolbar.svelte';
  import Icon from './Icon.svelte';
  import ShowMoreButton from './ShowMoreButton.svelte';
  import LimitNotice from './LimitNotice.svelte';
  import { SubscriptionLimitError } from '$lib/services/api';
  import { feedLimitLine } from '$lib/utils/limitCopy';

  // The registry arrives whole, so windowing is purely about what we put in the
  // DOM: show a screenful, reveal the rest a batch at a time.
  const INITIAL_WINDOW = 10;
  const WINDOW_STEP = 25;

  interface Props {
    /**
     * `friends` = only people you follow (onboarding); `full` = the whole registry;
     * `suggestions` = a capped list of registry linkbloggers you don't already follow.
     */
    variant?: 'friends' | 'full' | 'suggestions';
    /** For `suggestions`: max people to show. */
    limit?: number;
    /** For `suggestions`: heading rendered above the list, only when there are results. */
    heading?: string;
    /** For `suggestions`: total eligible people before `limit` (so a parent can show "see all"). */
    totalAvailable?: number;
  }
  let { variant = 'friends', limit, heading, totalAvailable = $bindable(0) }: Props = $props();

  onMount(() => {
    if (variant === 'friends') linkblogDiscoveryStore.loadFriends();
    else linkblogDiscoveryStore.loadDiscover();
  });

  // Publications we already subscribe to — to render a "Following" state.
  let subscribedPubUris = $derived(
    new Set(
      subscriptionsStore.subscriptions
        .filter((s) => s.sourceType === 'atproto.documents' && s.feedUrl)
        .map((s) => s.feedUrl as string)
    )
  );

  let friends = $derived(
    variant === 'full'
      ? linkblogDiscoveryStore.people.filter((p) => p.isFollow)
      : linkblogDiscoveryStore.friends
  );
  let others = $derived(
    variant === 'full' ? linkblogDiscoveryStore.people.filter((p) => !p.isFollow) : []
  );
  // For `suggestions`: registry linkbloggers you don't already follow on Bluesky
  // (friends are surfaced separately) and aren't already subscribed to.
  let eligible = $derived(
    variant === 'suggestions'
      ? linkblogDiscoveryStore.people.filter(
          (p) => !p.isFollow && !subscribedPubUris.has(p.publicationUri)
        )
      : []
  );
  let suggestions = $derived(eligible.slice(0, limit ?? eligible.length));
  $effect(() => {
    totalAvailable = eligible.length;
  });

  // Full-view filters. Both are inert outside `full` — the suggestions and
  // friends variants never render the toolbar that drives them.
  let query = $state('');
  let hideAdded = $state(false);

  function matches(p: LinkblogPerson, q: string): boolean {
    if (hideAdded && subscribedPubUris.has(p.publicationUri)) return false;
    if (!q) return true;
    return (
      (p.displayName?.toLowerCase().includes(q) ?? false) ||
      (p.handle?.toLowerCase().includes(q) ?? false)
    );
  }

  let normalizedQuery = $derived(query.trim().toLowerCase());
  let filteredFriends = $derived(friends.filter((p) => matches(p, normalizedQuery)));
  let filteredOthers = $derived(others.filter((p) => matches(p, normalizedQuery)));
  let totalPeople = $derived(friends.length + others.length);
  let shownPeople = $derived(filteredFriends.length + filteredOthers.length);
  let filtering = $derived(normalizedQuery.length > 0 || hideAdded);

  // Windowing runs after filtering, so a match beyond the initial window is
  // never hidden behind an unexpanded list.
  let visibleFriends = $state(INITIAL_WINDOW);
  let visibleOthers = $state(INITIAL_WINDOW);

  // Reset both windows whenever the filter changes — and *only* then. A broader
  // dependency (the people array) would collapse an expanded list on refresh.
  $effect(() => {
    void query;
    void hideAdded;
    visibleFriends = INITIAL_WINDOW;
    visibleOthers = INITIAL_WINDOW;
  });

  let loading = $derived(
    variant === 'friends'
      ? linkblogDiscoveryStore.loadingFriends
      : linkblogDiscoveryStore.loadingPeople
  );
  let loaded = $derived(
    variant === 'friends'
      ? linkblogDiscoveryStore.friendsLoaded
      : linkblogDiscoveryStore.peopleLoaded
  );

  // Per-person follow state (keyed by DID): in-flight + last error.
  let pending = $state<Record<string, boolean>>({});
  let failed = $state<Record<string, string>>({});
  // The active-feed cap isn't a per-row failure: it's the same wall for every
  // row, so it gets one notice above the list instead of N red spans.
  let limitHit = $state(false);

  function displayName(p: LinkblogPerson): string {
    return p.displayName?.trim() || (p.handle ? `@${p.handle}` : p.did);
  }

  function initial(p: LinkblogPerson): string {
    const source = p.displayName?.trim() || p.handle || '?';
    return source.replace(/^@/, '').charAt(0).toUpperCase();
  }

  async function follow(p: LinkblogPerson) {
    if (pending[p.did]) return;
    pending = { ...pending, [p.did]: true };
    limitHit = false;
    if (failed[p.did]) {
      const { [p.did]: _, ...rest } = failed;
      failed = rest;
    }
    try {
      await linkblogDiscoveryStore.subscribe(p);
    } catch (e) {
      if (e instanceof SubscriptionLimitError) {
        limitHit = true;
      } else {
        failed = {
          ...failed,
          [p.did]: e instanceof Error ? e.message : 'Could not follow',
        };
      }
    } finally {
      const { [p.did]: _, ...rest } = pending;
      pending = rest;
    }
  }
</script>

{#snippet personRow(p: LinkblogPerson)}
  {@const subscribed = subscribedPubUris.has(p.publicationUri)}
  <li class="person">
    <!-- No blogUrl means this author turned their Skyreader page off: the avatar
         and name go flat rather than linking somewhere that 404s. Adding them
         still works — that goes through `publicationUri`. -->
    <svelte:element
      this={p.blogUrl ? 'a' : 'span'}
      class="avatar"
      href={p.blogUrl}
      target={p.blogUrl ? '_blank' : undefined}
      rel={p.blogUrl ? 'noopener' : undefined}
      tabindex="-1"
      aria-hidden="true"
    >
      {#if p.avatar}
        <img src={p.avatar} alt="" loading="lazy" />
      {:else}
        <span class="avatar-fallback">{initial(p)}</span>
      {/if}
    </svelte:element>
    <div class="who">
      {#if p.blogUrl}
        <a class="name" href={p.blogUrl} target="_blank" rel="noopener">{displayName(p)}</a>
      {:else}
        <span class="name">{displayName(p)}</span>
      {/if}
      {#if p.handle}
        <span class="handle">@{p.handle}</span>
      {/if}
      {#if failed[p.did]}
        <span class="follow-error">{failed[p.did]}</span>
      {/if}
    </div>
    {#if subscribed}
      <span class="following"><Icon name="check" size={14} /> Added</span>
    {:else}
      <button class="follow-btn" disabled={pending[p.did]} onclick={() => follow(p)}>
        {#if pending[p.did]}
          <span class="spinner"></span>
        {:else}
          <Icon name="plus" size={14} />
        {/if}
        Add
      </button>
    {/if}
  </li>
{/snippet}

<div class="linkblog-discovery">
  {#if limitHit}
    <div class="limit-wrap">
      <LimitNotice kind="feeds">
        <p>{feedLimitLine(subscriptionsStore.maxSubscriptions)}</p>
      </LimitNotice>
    </div>
  {/if}
  {#if variant === 'suggestions'}
    <!-- Quiet by design: render nothing while loading or when none are found. -->
    {#if suggestions.length > 0}
      {#if heading}
        <h3 class="group-title">{heading}</h3>
      {/if}
      <ul class="person-list">
        {#each suggestions as p (p.did)}
          {@render personRow(p)}
        {/each}
      </ul>
    {/if}
  {:else if loading && !loaded}
    <p class="status">Looking for linkblogs…</p>
  {:else if variant === 'full'}
    {#if totalPeople > 0}
      <DiscoveryToolbar bind:query bind:hideAdded searchLabel="Search linkblogs">
        {#snippet count()}
          {#if filtering}
            {shownPeople} of {totalPeople}
            {totalPeople === 1 ? 'linkblog' : 'linkblogs'}
          {:else}
            {totalPeople}
            {totalPeople === 1 ? 'linkblog' : 'linkblogs'} · {friends.length} from people you follow
          {/if}
        {/snippet}
      </DiscoveryToolbar>
    {/if}

    {#if filteredFriends.length > 0}
      <h3 class="group-title">People you follow</h3>
      <ul class="person-list">
        {#each filteredFriends.slice(0, visibleFriends) as p (p.did)}
          {@render personRow(p)}
        {/each}
      </ul>
      <ShowMoreButton
        remaining={filteredFriends.length - visibleFriends}
        batchSize={WINDOW_STEP}
        onclick={() => (visibleFriends += WINDOW_STEP)}
      />
    {/if}

    {#if filteredOthers.length > 0}
      <h3 class="group-title">More on Skyreader</h3>
      <ul class="person-list">
        {#each filteredOthers.slice(0, visibleOthers) as p (p.did)}
          {@render personRow(p)}
        {/each}
      </ul>
      <ShowMoreButton
        remaining={filteredOthers.length - visibleOthers}
        batchSize={WINDOW_STEP}
        onclick={() => (visibleOthers += WINDOW_STEP)}
      />
    {/if}

    {#if shownPeople === 0}
      {#if totalPeople === 0}
        {#if loaded}
          <p class="status">No linkblogs to show yet — check back as more people start one.</p>
        {/if}
      {:else if normalizedQuery}
        <p class="status">No linkblogs match “{query.trim()}”.</p>
      {:else}
        <p class="status">You've already added every linkblog here.</p>
      {/if}
    {/if}
  {:else}
    {#if friends.length > 0}
      <ul class="person-list">
        {#each friends as p (p.did)}
          {@render personRow(p)}
        {/each}
      </ul>
    {:else if loaded}
      <p class="status">None of the people you follow have a linkblog yet.</p>
    {/if}
  {/if}
</div>

<style>
  .linkblog-discovery {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .limit-wrap {
    margin-bottom: 0.75rem;
  }

  .group-title {
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--color-text-secondary);
    margin: 0.75rem 0 0.25rem;
  }

  .group-title:first-child {
    margin-top: 0;
  }

  .status {
    font-size: var(--text-md);
    color: var(--color-text-secondary);
    margin: 0.5rem 0;
  }

  .person-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .person {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem 0;
    border-bottom: 1px solid var(--color-border);
  }

  .person:last-child {
    border-bottom: none;
  }

  .avatar {
    flex-shrink: 0;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    overflow: hidden;
    background: var(--color-bg-secondary, rgba(0, 0, 0, 0.04));
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .avatar-fallback {
    font-size: var(--text-base);
    font-weight: var(--weight-semibold);
    color: var(--color-text-secondary);
  }

  .who {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    line-height: var(--leading-tight);
  }

  .name {
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    color: var(--color-text);
    text-decoration: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Only when it's actually a link — an author with no public page renders the
     name as a span, which shouldn't offer a hover affordance. */
  a.name:hover {
    text-decoration: underline;
  }

  .handle {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .follow-error {
    font-size: var(--text-xs);
    color: var(--color-danger, #c0392b);
    margin-top: 0.125rem;
  }

  .follow-btn {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.375rem 0.75rem;
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: #fff;
    background: var(--color-primary);
    border: none;
    border-radius: var(--radius-md, 6px);
    cursor: pointer;
    transition: opacity 0.15s;
  }

  .follow-btn:hover:not(:disabled) {
    opacity: 0.9;
  }

  .follow-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .following {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-text-secondary);
    padding: 0.375rem 0.5rem;
  }

  .spinner {
    width: 13px;
    height: 13px;
    border: 2px solid rgba(255, 255, 255, 0.5);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
