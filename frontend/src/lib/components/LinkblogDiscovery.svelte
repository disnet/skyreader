<script lang="ts">
  import { onMount } from 'svelte';
  import { linkblogDiscoveryStore } from '$lib/stores/linkblogDiscovery.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import type { LinkblogPerson } from '$lib/types';
  import Icon from './Icon.svelte';

  interface Props {
    /** `friends` = only people you follow (onboarding); `full` = the whole registry. */
    variant?: 'friends' | 'full';
  }
  let { variant = 'friends' }: Props = $props();

  onMount(() => {
    if (variant === 'full') linkblogDiscoveryStore.loadDiscover();
    else linkblogDiscoveryStore.loadFriends();
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
  let loading = $derived(
    variant === 'full'
      ? linkblogDiscoveryStore.loadingPeople
      : linkblogDiscoveryStore.loadingFriends
  );
  let loaded = $derived(
    variant === 'full' ? linkblogDiscoveryStore.peopleLoaded : linkblogDiscoveryStore.friendsLoaded
  );

  // Per-person follow state (keyed by DID): in-flight + last error.
  let pending = $state<Record<string, boolean>>({});
  let failed = $state<Record<string, string>>({});

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
    if (failed[p.did]) {
      const { [p.did]: _, ...rest } = failed;
      failed = rest;
    }
    try {
      await linkblogDiscoveryStore.subscribe(p);
    } catch (e) {
      failed = { ...failed, [p.did]: e instanceof Error ? e.message : 'Could not follow' };
    } finally {
      const { [p.did]: _, ...rest } = pending;
      pending = rest;
    }
  }
</script>

{#snippet personRow(p: LinkblogPerson)}
  {@const subscribed = subscribedPubUris.has(p.publicationUri)}
  <li class="person">
    <a
      class="avatar"
      href={`/blogs/${p.did}/`}
      target="_blank"
      rel="noopener"
      tabindex="-1"
      aria-hidden="true"
    >
      {#if p.avatar}
        <img src={p.avatar} alt="" loading="lazy" />
      {:else}
        <span class="avatar-fallback">{initial(p)}</span>
      {/if}
    </a>
    <div class="who">
      <a class="name" href={`/blogs/${p.did}/`} target="_blank" rel="noopener">{displayName(p)}</a>
      {#if p.handle}
        <span class="handle">@{p.handle}</span>
      {/if}
      {#if failed[p.did]}
        <span class="follow-error">{failed[p.did]}</span>
      {/if}
    </div>
    {#if subscribed}
      <span class="following"><Icon name="check" size={14} /> Following</span>
    {:else}
      <button class="follow-btn" disabled={pending[p.did]} onclick={() => follow(p)}>
        {#if pending[p.did]}
          <span class="spinner"></span>
        {:else}
          <Icon name="plus" size={14} />
        {/if}
        Follow
      </button>
    {/if}
  </li>
{/snippet}

<div class="linkblog-discovery">
  {#if loading && !loaded}
    <p class="status">Looking for linkblogs…</p>
  {:else}
    {#if friends.length > 0}
      {#if variant === 'full'}
        <h3 class="group-title">People you follow</h3>
      {/if}
      <ul class="person-list">
        {#each friends as p (p.did)}
          {@render personRow(p)}
        {/each}
      </ul>
    {:else if variant === 'friends' && loaded}
      <p class="status">None of the people you follow have a linkblog yet.</p>
    {/if}

    {#if variant === 'full' && others.length > 0}
      <h3 class="group-title">More on Skyreader</h3>
      <ul class="person-list">
        {#each others as p (p.did)}
          {@render personRow(p)}
        {/each}
      </ul>
    {/if}

    {#if variant === 'full' && loaded && friends.length === 0 && others.length === 0}
      <p class="status">No linkblogs to show yet — check back as more people start one.</p>
    {/if}
  {/if}
</div>

<style>
  .linkblog-discovery {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .group-title {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--color-text-secondary);
    margin: 0.75rem 0 0.25rem;
  }

  .group-title:first-child {
    margin-top: 0;
  }

  .status {
    font-size: 0.875rem;
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
    font-size: 1rem;
    font-weight: 600;
    color: var(--color-text-secondary);
  }

  .who {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    line-height: 1.3;
  }

  .name {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--color-text);
    text-decoration: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .name:hover {
    text-decoration: underline;
  }

  .handle {
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .follow-error {
    font-size: 0.75rem;
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
    font-size: 0.8125rem;
    font-weight: 500;
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
    font-size: 0.8125rem;
    font-weight: 500;
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
