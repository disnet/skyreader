<script lang="ts">
  import { onMount } from 'svelte';
  import { followingPublicationsStore } from '$lib/stores/followingPublications.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import type { FollowingPublication } from '$lib/types';
  import Icon from './Icon.svelte';

  interface Props {
    /**
     * `full` = the grouped, hideable discovery list (the /discover page);
     * `suggestions` = a quiet, capped sample of accounts you don't already
     * subscribe to, for the Sources "Find more" / empty-state widget.
     */
    variant?: 'full' | 'suggestions';
    /** For `suggestions`: max accounts to show. */
    limit?: number;
    /** For `suggestions`: heading rendered above the list when there are results. */
    heading?: string;
    /** For `suggestions`: total eligible accounts before `limit`, so a parent can show "see all". */
    totalAvailable?: number;
  }
  let { variant = 'full', limit, heading, totalAvailable = $bindable(0) }: Props = $props();

  onMount(() => {
    followingPublicationsStore.load();
  });

  let loading = $derived(followingPublicationsStore.loading);
  let loaded = $derived(followingPublicationsStore.loaded);
  let scanning = $derived(followingPublicationsStore.scanning);
  let hiddenAccounts = $derived(followingPublicationsStore.hiddenAccounts);

  type AccountLike = { did: string; handle: string | null; displayName?: string; avatar?: string };
  interface AccountGroup extends AccountLike {
    publications: FollowingPublication[];
  }

  // Publications we already subscribe to — to render a "Following" state.
  let subscribedPubUris = $derived(
    new Set(
      subscriptionsStore.subscriptions
        .filter((s) => s.sourceType === 'atproto.documents' && s.feedUrl)
        .map((s) => s.feedUrl as string)
    )
  );

  // Group a publication list by account, preserving discovery order. Optionally
  // drop publications the user already subscribes to (for the suggestions sample).
  function groupByAccount(pubs: FollowingPublication[], skipSubscribed: boolean): AccountGroup[] {
    const map = new Map<string, AccountGroup>();
    for (const p of pubs) {
      if (skipSubscribed && subscribedPubUris.has(p.publicationUri)) continue;
      let g = map.get(p.did);
      if (!g) {
        g = {
          did: p.did,
          handle: p.handle,
          displayName: p.displayName,
          avatar: p.avatar,
          publications: [],
        };
        map.set(p.did, g);
      }
      g.publications.push(p);
    }
    return [...map.values()];
  }

  // Full view: every account, grouped.
  let groups = $derived(groupByAccount(followingPublicationsStore.publications, false));

  // Full-view counts (total scanned so far) and free-text filter.
  let pubCount = $derived(followingPublicationsStore.publications.length);
  let accountCount = $derived(groups.length);
  let query = $state('');

  // Filter the grouped list by query, matching the account (name/handle) or any
  // of its publications (name/description). An account match keeps all its pubs.
  let filteredGroups = $derived.by<AccountGroup[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    const out: AccountGroup[] = [];
    for (const g of groups) {
      if (accountName(g).toLowerCase().includes(q) || g.handle?.toLowerCase().includes(q)) {
        out.push(g);
        continue;
      }
      const pubs = g.publications.filter(
        (p) => p.name?.toLowerCase().includes(q) || p.description?.toLowerCase().includes(q)
      );
      if (pubs.length) out.push({ ...g, publications: pubs });
    }
    return out;
  });

  // Suggestions: accounts with at least one not-yet-subscribed publication.
  let eligibleAccounts = $derived(
    variant === 'suggestions' ? groupByAccount(followingPublicationsStore.publications, true) : []
  );
  let suggestions = $derived(eligibleAccounts.slice(0, limit ?? eligibleAccounts.length));
  $effect(() => {
    totalAvailable = eligibleAccounts.length;
  });

  // Per-publication follow state (keyed by URI): in-flight + last error.
  let pending = $state<Record<string, boolean>>({});
  let failed = $state<Record<string, string>>({});

  // Hidden-accounts affordance: collapsed by default, with per-account unhide
  // state (unhiding triggers a re-scan, so it can take a moment).
  let showHidden = $state(false);
  let unhiding = $state<Record<string, boolean>>({});

  function accountName(g: AccountLike): string {
    return g.displayName?.trim() || (g.handle ? `@${g.handle}` : g.did);
  }

  function accountInitial(g: AccountLike): string {
    const source = g.displayName?.trim() || g.handle || '?';
    return source.replace(/^@/, '').charAt(0).toUpperCase();
  }

  function profileUrl(g: AccountLike): string {
    return `https://bsky.app/profile/${g.handle ?? g.did}`;
  }

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

  function pubInitial(p: FollowingPublication): string {
    return (p.name?.trim() || '?').charAt(0).toUpperCase();
  }

  async function follow(p: FollowingPublication) {
    if (pending[p.publicationUri]) return;
    pending = { ...pending, [p.publicationUri]: true };
    if (failed[p.publicationUri]) {
      const { [p.publicationUri]: _, ...rest } = failed;
      failed = rest;
    }
    try {
      await followingPublicationsStore.subscribe(p);
    } catch (e) {
      failed = {
        ...failed,
        [p.publicationUri]: e instanceof Error ? e.message : 'Could not follow',
      };
    } finally {
      const { [p.publicationUri]: _, ...rest } = pending;
      pending = rest;
    }
  }
</script>

{#snippet accountBlock(g: AccountGroup, canHide: boolean)}
  <li class="account">
    <div class="account-header">
      <a
        class="avatar"
        href={profileUrl(g)}
        target="_blank"
        rel="noopener"
        tabindex="-1"
        aria-hidden="true"
      >
        {#if g.avatar}
          <img src={g.avatar} alt="" loading="lazy" />
        {:else}
          <span class="avatar-fallback">{accountInitial(g)}</span>
        {/if}
      </a>
      <a class="who" href={profileUrl(g)} target="_blank" rel="noopener">
        <span class="name">{accountName(g)}</span>
        {#if g.handle}
          <span class="handle">@{g.handle}</span>
        {/if}
      </a>
      {#if canHide}
        <button
          class="hide-btn"
          title="Hide this account from discovery"
          onclick={() => followingPublicationsStore.hide(g.did)}
        >
          <Icon name="x" size={14} /> Hide
        </button>
      {/if}
    </div>

    <ul class="pub-sublist">
      {#each g.publications as p (p.publicationUri)}
        {@const subscribed = subscribedPubUris.has(p.publicationUri)}
        <li class="pub">
          <span class="pub-icon">
            {#if p.iconUrl}
              <img src={p.iconUrl} alt="" loading="lazy" />
            {:else}
              <span class="pub-icon-fallback">{pubInitial(p)}</span>
            {/if}
          </span>
          <div class="pub-meta">
            {#if p.url}
              <a class="pub-name" href={p.url} target="_blank" rel="noopener">{p.name}</a>
            {:else}
              <span class="pub-name">{p.name}</span>
            {/if}
            {#if p.description}
              <span class="pub-desc">{p.description}</span>
            {/if}
            {#if failed[p.publicationUri]}
              <span class="follow-error">{failed[p.publicationUri]}</span>
            {/if}
          </div>
          {#if subscribed}
            <span class="following"><Icon name="check" size={14} /> Following</span>
          {:else}
            <button
              class="follow-btn"
              disabled={pending[p.publicationUri]}
              onclick={() => follow(p)}
            >
              {#if pending[p.publicationUri]}
                <span class="spinner"></span>
              {:else}
                <Icon name="plus" size={14} />
              {/if}
              Follow
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  </li>
{/snippet}

<div class="following-publications">
  {#if variant === 'suggestions'}
    <!-- Quiet by design: render nothing while loading or when none are found. -->
    {#if suggestions.length > 0}
      {#if heading}
        <h3 class="group-title">{heading}</h3>
      {/if}
      <ul class="account-list">
        {#each suggestions as g (g.did)}
          {@render accountBlock(g, false)}
        {/each}
      </ul>
    {/if}
  {:else if loading && !loaded}
    <p class="status">Looking for publications…</p>
  {:else if groups.length === 0 && loaded && !scanning}
    <p class="status">No publications found among the people you follow.</p>
  {:else if groups.length > 0}
    <div class="discovery-toolbar">
      <p class="count">
        {pubCount}
        {pubCount === 1 ? 'publication' : 'publications'} from {accountCount}
        {accountCount === 1 ? 'account' : 'accounts'} you follow
        {#if scanning}<span class="count-scanning"
            ><span class="spinner dark"></span> finding more…</span
          >{/if}
      </p>
      <div class="search">
        <Icon name="search" size={15} />
        <input
          type="search"
          placeholder="Search publications"
          aria-label="Search publications"
          bind:value={query}
        />
      </div>
    </div>

    {#if filteredGroups.length > 0}
      <ul class="account-list">
        {#each filteredGroups as g (g.did)}
          {@render accountBlock(g, true)}
        {/each}
      </ul>
    {:else}
      <p class="status">No publications match “{query.trim()}”.</p>
    {/if}
  {:else if scanning}
    <p class="status"><span class="spinner dark"></span> Searching the people you follow…</p>
  {/if}

  {#if variant === 'full' && loaded && hiddenAccounts.length > 0}
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
        <ul class="hidden-list">
          {#each hiddenAccounts as a (a.did)}
            <li class="hidden-account">
              <span class="avatar small">
                {#if a.avatar}
                  <img src={a.avatar} alt="" loading="lazy" />
                {:else}
                  <span class="avatar-fallback">{accountInitial(a)}</span>
                {/if}
              </span>
              <a class="who" href={profileUrl(a)} target="_blank" rel="noopener">
                <span class="name">{accountName(a)}</span>
                {#if a.handle}
                  <span class="handle">@{a.handle}</span>
                {/if}
              </a>
              <button class="unhide-btn" disabled={unhiding[a.did]} onclick={() => unhide(a.did)}>
                {#if unhiding[a.did]}
                  <span class="spinner dark"></span>
                {/if}
                Unhide
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>

<style>
  .following-publications {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .status {
    font-size: var(--text-md);
    color: var(--color-text-secondary);
    margin: 0.5rem 0;
  }

  .group-title {
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--color-text-secondary);
    margin: 0 0 0.375rem;
  }

  .discovery-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-bottom: 0.25rem;
  }

  .count {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    margin: 0;
  }

  .search {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.625rem;
    color: var(--color-text-secondary);
    background: var(--color-bg-secondary, rgba(0, 0, 0, 0.04));
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 6px);
    transition: border-color 0.15s;
  }

  .search:focus-within {
    border-color: var(--color-primary);
  }

  .search input {
    width: 14rem;
    max-width: 100%;
    font: inherit;
    font-size: var(--text-sm);
    color: var(--color-text);
    background: transparent;
    border: none;
    outline: none;
    padding: 0;
  }

  .search input::placeholder {
    color: var(--color-text-secondary);
  }

  @media (max-width: 520px) {
    .search,
    .search input {
      width: 100%;
    }
  }

  .account-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .account {
    padding: 0.875rem 0;
    border-bottom: 1px solid var(--color-border);
  }

  .account:last-child {
    border-bottom: none;
  }

  .account-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
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
    text-decoration: none;
  }

  .name {
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .who:hover .name {
    text-decoration: underline;
  }

  .handle {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hide-btn {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.375rem 0.5rem;
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-text-secondary);
    background: transparent;
    border: none;
    border-radius: var(--radius-md, 6px);
    cursor: pointer;
    transition:
      color 0.15s,
      background 0.15s;
  }

  .hide-btn:hover {
    color: var(--color-text);
    background: var(--color-bg-secondary, rgba(0, 0, 0, 0.04));
  }

  .pub-sublist {
    list-style: none;
    margin: 0.5rem 0 0;
    /* Align under the account name (avatar 40px + 0.75rem gap). */
    padding: 0 0 0 calc(40px + 0.75rem);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .pub {
    display: flex;
    align-items: center;
    gap: 0.625rem;
  }

  .pub-icon {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    overflow: hidden;
    background: var(--color-bg-secondary, rgba(0, 0, 0, 0.04));
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .pub-icon img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .pub-icon-fallback {
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--color-text-secondary);
  }

  .pub-meta {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    line-height: var(--leading-tight);
  }

  .pub-name {
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    color: var(--color-text);
    text-decoration: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  a.pub-name:hover {
    text-decoration: underline;
  }

  .pub-desc {
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

  .count-scanning {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    margin-left: 0.5rem;
    color: var(--color-text-secondary);
  }

  .status .spinner {
    display: inline-block;
    vertical-align: middle;
    margin-right: 0.375rem;
  }

  .avatar.small {
    width: 32px;
    height: 32px;
  }

  .hidden-section {
    margin-top: 0.75rem;
  }

  .hidden-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0;
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

  .hidden-list {
    list-style: none;
    margin: 0.25rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .hidden-account {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.5rem 0;
  }

  .unhide-btn {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.75rem;
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-text);
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 6px);
    cursor: pointer;
    transition: background 0.15s;
  }

  .unhide-btn:hover:not(:disabled) {
    background: var(--color-bg-secondary, rgba(0, 0, 0, 0.04));
  }

  .unhide-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .spinner {
    width: 13px;
    height: 13px;
    border: 2px solid rgba(255, 255, 255, 0.5);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  .spinner.dark {
    border-color: var(--color-border);
    border-top-color: var(--color-text-secondary);
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
