<script lang="ts">
  import { onMount } from 'svelte';
  import { standardSubsStore } from '$lib/stores/standardSubs.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { getFaviconUrl } from '$lib/utils/favicon';
  import type { StandardSub } from '$lib/stores/standardSubs.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import LinkblogDiscovery from '$lib/components/LinkblogDiscovery.svelte';
  import FollowingPublications from '$lib/components/FollowingPublications.svelte';

  onMount(() => {
    standardSubsStore.load();
  });

  // DIDs we already have an Atmosphere subscription for — hide those suggestions.
  let subscribedDids = $derived(
    new Set(
      subscriptionsStore.subscriptions
        .filter((s) => s.subjectDid)
        .map((s) => s.subjectDid as string)
    )
  );

  let suggestedStandardSubs = $derived(
    standardSubsStore.subs.filter((s) => !subscribedDids.has(s.publisherDid))
  );

  let failedIcons = $state<Set<string>>(new Set());
  function iconUrl(sub: StandardSub): string {
    if (failedIcons.has(sub.uri)) return '';
    return sub.publication.url ? getFaviconUrl(sub.publication.url, 64) : '';
  }
  function onIconError(uri: string) {
    if (!failedIcons.has(uri)) failedIcons = new Set(failedIcons).add(uri);
  }

  // Total registry linkbloggers eligible to suggest (before the inline cap) — drives "see all".
  let moreLinkblogs = $state(0);
  // Total accounts you follow with standard.site publications (before the cap) — drives "see all".
  let moreFollowingPubs = $state(0);

  let adding = $state<string | null>(null);
  async function add(sub: StandardSub) {
    if (adding) return;
    adding = sub.uri;
    try {
      await standardSubsStore.subscribe(sub);
    } finally {
      adding = null;
    }
  }
</script>

<section class="discovery">
  <h2 class="discovery-title">Find more</h2>

  <div class="block">
    <h3 class="block-title">People you know with Skyreader linkblogs</h3>
    <LinkblogDiscovery variant="friends" />
  </div>

  {#if standardSubsStore.loading || suggestedStandardSubs.length > 0}
    <div class="block">
      <h3 class="block-title">
        <Icon name="standard-site" size={13} /> Your standard.site subscriptions
      </h3>
      {#if standardSubsStore.loading && !standardSubsStore.loaded}
        <p class="status">Looking for subscriptions…</p>
      {:else}
        <ul class="sub-list">
          {#each suggestedStandardSubs as sub (sub.uri)}
            <li class="sub-row">
              {#if iconUrl(sub)}
                <img
                  class="sub-icon"
                  src={iconUrl(sub)}
                  alt=""
                  loading="lazy"
                  onerror={() => onIconError(sub.uri)}
                />
              {:else}
                <span class="sub-icon placeholder"><Icon name="standard-site" size={15} /></span>
              {/if}
              <div class="sub-info">
                <span class="sub-name">{sub.publication.name}</span>
                <span class="sub-url">{sub.publication.url}</span>
              </div>
              <button class="add-btn" disabled={adding === sub.uri} onclick={() => add(sub)}>
                {#if adding === sub.uri}
                  <span class="spinner"></span>
                {:else}
                  <Icon name="plus" size={14} />
                {/if}
                Add
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}

  <FollowingPublications
    variant="suggestions"
    limit={3}
    heading="Publications from people you follow"
    bind:totalAvailable={moreFollowingPubs}
  />

  {#if moreFollowingPubs > 3}
    <a class="see-all" href="/discover">
      See all publications
      <Icon name="chevron-right" size={15} />
    </a>
  {/if}

  <LinkblogDiscovery
    variant="suggestions"
    limit={3}
    heading="More Skyreader linkblogs"
    bind:totalAvailable={moreLinkblogs}
  />

  {#if moreLinkblogs > 3}
    <a class="see-all" href="/discover">
      See all linkblogs
      <Icon name="chevron-right" size={15} />
    </a>
  {/if}
</section>

<style>
  .discovery {
    margin-bottom: 1.5rem;
    padding: 1rem;
    background: var(--color-bg-secondary, rgba(0, 0, 0, 0.025));
    border: 1px solid var(--color-border);
    border-radius: 12px;
  }

  .discovery-title {
    font-size: 0.9375rem;
    font-weight: 600;
    letter-spacing: -0.01em;
    margin: 0 0 0.75rem;
  }

  .block {
    margin-bottom: 1rem;
  }

  .block-title {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--color-text-secondary);
    margin: 0 0 0.375rem;
  }

  .status {
    font-size: 0.875rem;
    color: var(--color-text-secondary);
    margin: 0.25rem 0;
  }

  .sub-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .sub-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--color-border);
  }

  .sub-row:last-child {
    border-bottom: none;
  }

  .sub-icon {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    object-fit: cover;
    background: var(--color-bg);
  }

  .sub-icon.placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-secondary);
  }

  .sub-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    line-height: 1.3;
  }

  .sub-name {
    font-size: 0.875rem;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sub-url {
    font-size: 0.75rem;
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .add-btn {
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
    border-radius: 6px;
    cursor: pointer;
    transition: opacity 0.15s;
  }

  .add-btn:hover:not(:disabled) {
    opacity: 0.9;
  }

  .add-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .see-all {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    margin-top: 0.75rem;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--color-primary);
    text-decoration: none;
  }

  .see-all:hover {
    text-decoration: underline;
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

  @media (prefers-color-scheme: dark) {
    .discovery {
      background: var(--color-bg-secondary, rgba(255, 255, 255, 0.04));
    }
  }
</style>
