<script lang="ts">
  import { onMount } from 'svelte';
  import { followingPublicationsStore } from '$lib/stores/followingPublications.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import type { FollowingPublication } from '$lib/types';
  import Icon from './Icon.svelte';
  import ShowMoreButton from './ShowMoreButton.svelte';
  import LimitNotice from './LimitNotice.svelte';
  import SourceRow from './sources/SourceRow.svelte';
  import SourceList from './sources/SourceList.svelte';
  import { SubscriptionLimitError } from '$lib/services/api';
  import { feedLimitLine } from '$lib/utils/limitCopy';

  // The Discover page's publications section: standard.site publications owned
  // by accounts you follow. One source row per publication, whose owner leads
  // the subtitle, rather than an indented block per account; hiding an account
  // is a row action. An account shows at most PER_ACCOUNT rows until asked, so
  // one prolific account can't fill the screen.
  //
  // The scan keeps appending publications for minutes on a large follow graph;
  // the window is what keeps that out of the DOM until the reader asks for it.
  const INITIAL_WINDOW = 10;
  const WINDOW_STEP = 25;
  const PER_ACCOUNT = 2;

  interface Props {
    /** Page-wide search text. */
    query?: string;
    /** Page-wide "Hide added". */
    hideAdded?: boolean;
    /** Out: publications matching the filters, or null before the first load (for the tab). */
    shownCount?: number | null;
  }
  let { query = '', hideAdded = false, shownCount = $bindable(null) }: Props = $props();

  onMount(() => {
    followingPublicationsStore.load();
  });

  let loading = $derived(followingPublicationsStore.loading);
  let loaded = $derived(followingPublicationsStore.loaded);
  let scanning = $derived(followingPublicationsStore.scanning);
  let hiddenAccounts = $derived(followingPublicationsStore.hiddenAccounts);
  let publications = $derived(followingPublicationsStore.publications);

  type AccountLike = { did: string; handle: string | null; displayName?: string; avatar?: string };
  interface AccountGroup {
    did: string;
    handle: string | null;
    publications: FollowingPublication[];
  }

  // Publications we already subscribe to — to render an "Added" state.
  let subscribedPubUris = $derived(
    new Set(
      subscriptionsStore.subscriptions
        .filter((s) => s.sourceType === 'atproto.documents' && s.feedUrl)
        .map((s) => s.feedUrl as string)
    )
  );

  function accountName(g: AccountLike): string {
    return g.displayName?.trim() || (g.handle ? `@${g.handle}` : g.did);
  }

  // Strip protocol/trailing slash so a publication URL reads cleanly inline.
  function formatPublicationUrl(url: string): string {
    return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  }

  function subtitle(p: FollowingPublication): string {
    const who = p.handle ? `@${p.handle}` : accountName(p);
    return p.url ? `${who} · ${formatPublicationUrl(p.url)}` : who;
  }

  // Match the owner (name/handle) or the publication (name/description).
  let normalizedQuery = $derived(query.trim().toLowerCase());
  let filteredPubs = $derived.by(() => {
    const q = normalizedQuery;
    return publications.filter((p) => {
      if (hideAdded && subscribedPubUris.has(p.publicationUri)) return false;
      if (!q) return true;
      return (
        accountName(p).toLowerCase().includes(q) ||
        (p.handle?.toLowerCase().includes(q) ?? false) ||
        (p.name?.toLowerCase().includes(q) ?? false) ||
        (p.description?.toLowerCase().includes(q) ?? false)
      );
    });
  });

  // Grouped by account in discovery order; the window counts accounts.
  let filtered = $derived.by((): AccountGroup[] => {
    const map = new Map<string, AccountGroup>();
    for (const p of filteredPubs) {
      let g = map.get(p.did);
      if (!g) {
        g = { did: p.did, handle: p.handle, publications: [] };
        map.set(p.did, g);
      }
      g.publications.push(p);
    }
    return [...map.values()];
  });

  let expanded = $state<Record<string, boolean>>({});

  $effect(() => {
    shownCount = loaded || publications.length > 0 ? filteredPubs.length : null;
  });

  // Windowing runs after filtering, so a match beyond the initial window is
  // never hidden behind an unexpanded list. New publications from the
  // background scan append, so they grow the "Show N more" count instead of
  // reshuffling what's on screen.
  let visible = $state(INITIAL_WINDOW);

  // Reset the window whenever the filter changes — and *only* then. Depending on
  // the publications array here would collapse an expanded list mid-scan.
  $effect(() => {
    void query;
    void hideAdded;
    visible = INITIAL_WINDOW;
  });

  // Per-publication follow state: in flight, plus one notice for the section.
  let pending = $state<Record<string, boolean>>({});
  let addError = $state<string | null>(null);
  let limitHit = $state(false);

  // Hidden accounts: collapsed by default, with per-account unhide state
  // (unhiding triggers a re-scan, so it can take a moment).
  let showHidden = $state(false);
  let unhiding = $state<Record<string, boolean>>({});

  async function unhide(did: string) {
    if (unhiding[did]) return;
    unhiding = { ...unhiding, [did]: true };
    try {
      await followingPublicationsStore.unhide(did);
    } finally {
      const { [did]: _, ...rest } = unhiding;
      unhiding = rest;
    }
  }

  async function follow(p: FollowingPublication) {
    if (pending[p.publicationUri]) return;
    pending = { ...pending, [p.publicationUri]: true };
    limitHit = false;
    addError = null;
    try {
      await followingPublicationsStore.subscribe(p);
    } catch (e) {
      if (e instanceof SubscriptionLimitError) limitHit = true;
      else addError = e instanceof Error ? e.message : `Could not add ${p.name}.`;
    } finally {
      const { [p.publicationUri]: _, ...rest } = pending;
      pending = rest;
    }
  }
</script>

<section class="following-publications">
  <p class="section-desc">
    Standard.site blogs run by the accounts you follow on Bluesky.
    {#if scanning}
      <span class="scanning"><span class="spinner"></span> Finding more</span>
    {/if}
  </p>

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
    <p class="status">Looking for publications…</p>
  {:else if publications.length === 0 && loaded && !scanning}
    <p class="status">No publications found among the people you follow.</p>
  {:else if publications.length > 0}
    {#if filtered.length > 0}
      <SourceList>
        {#each filtered.slice(0, visible) as g (g.did)}
          {@const shown = expanded[g.did] ? g.publications : g.publications.slice(0, PER_ACCOUNT)}
          {#each shown as p (p.publicationUri)}
            <SourceRow
              iconUrl={p.iconUrl || p.avatar || null}
              iconRound={!p.iconUrl}
              title={p.name?.trim() || accountName(p)}
              description={p.description}
              subtitle={subtitle(p)}
              href={p.url}
              fallbackIcon="standard-site"
              subscribed={false}
              added={subscribedPubUris.has(p.publicationUri)}
              pending={!!pending[p.publicationUri]}
              onSubscribe={() => follow(p)}
              onHide={() => followingPublicationsStore.hide(p.did)}
            />
          {/each}
          {#if g.publications.length > shown.length}
            <button
              class="account-more"
              onclick={() => (expanded = { ...expanded, [g.did]: true })}
            >
              {g.publications.length - shown.length} more from {g.handle
                ? `@${g.handle}`
                : accountName(g.publications[0])}
            </button>
          {/if}
        {/each}
        <ShowMoreButton
          remaining={filtered.length - visible}
          batchSize={WINDOW_STEP}
          onclick={() => (visible += WINDOW_STEP)}
        />
      </SourceList>
    {:else if normalizedQuery}
      <p class="status">No publications match “{query.trim()}”.</p>
    {:else}
      <p class="status">You've already added every publication here.</p>
    {/if}
  {:else if scanning}
    <p class="status">Searching the people you follow…</p>
  {/if}

  {#if loaded && hiddenAccounts.length > 0}
    <div class="hidden-section">
      <button
        class="hidden-toggle"
        aria-expanded={showHidden}
        onclick={() => (showHidden = !showHidden)}
      >
        <Icon name={showHidden ? 'chevron-down' : 'chevron-right'} size={14} />
        {hiddenAccounts.length} hidden {hiddenAccounts.length === 1 ? 'account' : 'accounts'}
      </button>
      {#if showHidden}
        <SourceList>
          {#each hiddenAccounts as a (a.did)}
            <SourceRow
              iconUrl={a.avatar ?? null}
              iconRound
              title={accountName(a)}
              subtitle={a.handle ? `@${a.handle}` : a.did}
              href={`https://bsky.app/profile/${a.handle ?? a.did}`}
              fallbackIcon="user"
              subscribed={false}
              pending={!!unhiding[a.did]}
              action={{ label: 'Unhide', onclick: () => unhide(a.did) }}
            />
          {/each}
        </SourceList>
      {/if}
    </div>
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

  .scanning {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    margin-left: 0.5rem;
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .spinner {
    width: 11px;
    height: 11px;
    border: 2px solid var(--color-border);
    border-top-color: var(--color-text-secondary);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* Sits in the list like a row, indented to the titles it extends. */
  .account-more {
    display: block;
    width: 100%;
    padding: 0.5rem 0.75rem 0.5rem calc(0.75rem + 28px + 0.75rem);
    font: inherit;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    text-align: left;
    background: var(--color-bg);
    border: none;
    cursor: pointer;
  }

  .account-more:hover {
    color: var(--color-text);
    background: var(--color-bg-hover, rgba(0, 0, 0, 0.02));
  }

  .account-more:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
  }

  .hidden-section {
    margin-top: 0.75rem;
  }

  .hidden-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    margin: 0 0 0.5rem;
    padding: 0.25rem;
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-text-secondary);
    background: transparent;
    border: none;
    cursor: pointer;
    transition: color 0.15s;
  }

  .hidden-toggle:hover {
    color: var(--color-text);
  }
</style>
