<script lang="ts">
  import { onMount } from 'svelte';
  import { linkblogDiscoveryStore } from '$lib/stores/linkblogDiscovery.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import type { LinkblogPerson } from '$lib/types';
  import ShowMoreButton from './ShowMoreButton.svelte';
  import LimitNotice from './LimitNotice.svelte';
  import SourceRow from './sources/SourceRow.svelte';
  import SourceList from './sources/SourceList.svelte';
  import { SubscriptionLimitError } from '$lib/services/api';
  import { feedLimitLine } from '$lib/utils/limitCopy';

  // The Discover page's linkblog section: the whole registry, people you follow
  // first. Rows are ordinary source rows, the same ones Manage Sources uses.
  // The registry arrives whole, so windowing is purely about what we put in the
  // DOM: show a screenful, reveal the rest a batch at a time.
  const INITIAL_WINDOW = 10;
  const WINDOW_STEP = 25;

  interface Props {
    /** Page-wide search text. */
    query?: string;
    /** Page-wide "Hide added". */
    hideAdded?: boolean;
    /** Out: rows matching the filters, or null until the registry loads (for the tab). */
    shownCount?: number | null;
  }
  let { query = '', hideAdded = false, shownCount = $bindable(null) }: Props = $props();

  onMount(() => {
    linkblogDiscoveryStore.loadDiscover();
  });

  // Publications we already subscribe to — to render an "Added" state.
  let subscribedPubUris = $derived(
    new Set(
      subscriptionsStore.subscriptions
        .filter((s) => s.sourceType === 'atproto.documents' && s.feedUrl)
        .map((s) => s.feedUrl as string)
    )
  );

  let friends = $derived(linkblogDiscoveryStore.people.filter((p) => p.isFollow));
  let others = $derived(linkblogDiscoveryStore.people.filter((p) => !p.isFollow));

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
  $effect(() => {
    shownCount = loaded ? shownPeople : null;
  });

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

  let loading = $derived(linkblogDiscoveryStore.loadingPeople);
  let loaded = $derived(linkblogDiscoveryStore.peopleLoaded);

  // Follow state: which row is in flight, plus one notice for the section. The
  // active-feed cap is the same wall for every row, so it isn't per-row.
  let pending = $state<Record<string, boolean>>({});
  let addError = $state<string | null>(null);
  let limitHit = $state(false);

  function displayName(p: LinkblogPerson): string {
    return p.displayName?.trim() || (p.handle ? `@${p.handle}` : p.did);
  }

  async function follow(p: LinkblogPerson) {
    if (pending[p.did]) return;
    pending = { ...pending, [p.did]: true };
    limitHit = false;
    addError = null;
    try {
      await linkblogDiscoveryStore.subscribe(p);
    } catch (e) {
      if (e instanceof SubscriptionLimitError) limitHit = true;
      else addError = e instanceof Error ? e.message : `Could not add ${displayName(p)}.`;
    } finally {
      const { [p.did]: _, ...rest } = pending;
      pending = rest;
    }
  }
</script>

{#snippet personRow(p: LinkblogPerson)}
  <!-- No blogUrl means this author turned their Skyreader page off: the title
       goes flat rather than linking somewhere that 404s. Adding them still
       works — that goes through `publicationUri`. -->
  <SourceRow
    iconUrl={p.avatar ?? null}
    iconRound
    title={displayName(p)}
    subtitle={p.handle ? `@${p.handle}` : p.did}
    href={p.blogUrl}
    fallbackIcon="link"
    subscribed={false}
    added={subscribedPubUris.has(p.publicationUri)}
    pending={!!pending[p.did]}
    onSubscribe={() => follow(p)}
  />
{/snippet}

<section class="linkblog-discovery">
  <p class="section-desc">Links and notes people share from Skyreader.</p>

  {#if limitHit}
    <div class="notice">
      <LimitNotice kind="feeds">
        <p>{feedLimitLine(subscriptionsStore.maxSubscriptions)}</p>
      </LimitNotice>
    </div>
  {:else if addError}
    <p class="status error">{addError}</p>
  {/if}

  {#if loading && !loaded}
    <p class="status">Looking for linkblogs…</p>
  {:else}
    {#if filteredFriends.length > 0}
      <SourceList label="People you follow" count={filteredFriends.length}>
        {#each filteredFriends.slice(0, visibleFriends) as p (p.did)}
          {@render personRow(p)}
        {/each}
        <ShowMoreButton
          remaining={filteredFriends.length - visibleFriends}
          batchSize={WINDOW_STEP}
          onclick={() => (visibleFriends += WINDOW_STEP)}
        />
      </SourceList>
    {/if}

    {#if filteredOthers.length > 0}
      <SourceList
        label={filteredFriends.length > 0 ? 'More on Skyreader' : null}
        count={filteredOthers.length}
      >
        {#each filteredOthers.slice(0, visibleOthers) as p (p.did)}
          {@render personRow(p)}
        {/each}
        <ShowMoreButton
          remaining={filteredOthers.length - visibleOthers}
          batchSize={WINDOW_STEP}
          onclick={() => (visibleOthers += WINDOW_STEP)}
        />
      </SourceList>
    {/if}

    {#if shownPeople === 0}
      {#if totalPeople === 0}
        {#if loaded}
          <p class="status">No linkblogs yet. Check back as more people start one.</p>
        {/if}
      {:else if normalizedQuery}
        <p class="status">No linkblogs match “{query.trim()}”.</p>
      {:else}
        <p class="status">You've already added every linkblog here.</p>
      {/if}
    {/if}
  {/if}
</section>

<style>
  .section-desc {
    margin: 0 0.25rem 0.75rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    line-height: var(--leading-normal);
  }

  .notice {
    margin-bottom: 0.75rem;
  }

  .status {
    margin: 0.25rem 0.25rem 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .status.error {
    margin-bottom: 0.5rem;
    color: var(--color-error);
  }
</style>
