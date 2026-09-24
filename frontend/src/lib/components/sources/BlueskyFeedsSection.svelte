<script lang="ts">
  // Bluesky feeds as sources (docs/plans/BLUESKY_FEEDS_PLAN.md): your Following
  // timeline and the feeds you saved in Bluesky, each one Add away from being a
  // channel. The list comes from your Bluesky preferences, so what you pinned
  // there is here, in the same order; nothing is copied until you add it.
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import SourceList from './SourceList.svelte';
  import SourceRow from './SourceRow.svelte';
  import SourceSectionHeader from './SourceSectionHeader.svelte';
  import { api } from '$lib/services/api';
  import { auth } from '$lib/stores/auth.svelte';
  import { bskyFeedsStore } from '$lib/stores/bskyFeeds.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import {
    addBskyFeedChannel,
    findBskyFeedChannel,
    removeBskyFeedChannel,
  } from '$lib/utils/bskyFeedChannel';
  import { channelPath } from '$lib/utils/viewNav';
  import type { BskyAccess, BskyFeedSource } from '$lib/types';

  let saved = $state<BskyFeedSource[]>([]);
  let access = $state<BskyAccess | null>(null);
  let savedError = $state<string | null>(null);
  let loading = $state(true);
  let pendingUri = $state<string | null>(null);

  onMount(async () => {
    try {
      const res = await api.getBskyFeeds(true);
      access = res.access;
      saved = res.saved ?? [];
      savedError = res.savedError ?? null;
    } catch {
      savedError = 'unavailable';
    } finally {
      loading = false;
    }
    void bskyFeedsStore.load().catch(() => {});
  });

  // Added feeds first come from the store (so an add or remove shows at once),
  // then the saved ones not yet added. An added feed you've since unsaved in
  // Bluesky stays: it's yours here until you remove it.
  let rows = $derived.by(() => {
    const added = new Set(bskyFeedsStore.feeds.map((f) => f.uri));
    const out: (BskyFeedSource & { added: boolean })[] = [];
    const order = [...saved.map((f) => f.uri), ...bskyFeedsStore.feeds.map((f) => f.uri)];
    const seen = new Set<string>();
    for (const uri of order) {
      if (seen.has(uri)) continue;
      seen.add(uri);
      const feed = bskyFeedsStore.feed(uri) ?? saved.find((f) => f.uri === uri);
      if (feed) out.push({ ...feed, added: added.has(uri) });
    }
    return out;
  });

  let canReadFeeds = $derived(access?.feeds ?? false);

  async function add(uri: string) {
    pendingUri = uri;
    try {
      const uuid = await addBskyFeedChannel(uri);
      const feed = bskyFeedsStore.feed(uri);
      const id = toastStore.add('');
      toastStore.update(id, 'success', `Added ${feed?.displayName ?? 'the feed'}`, {
        label: 'Open',
        run: () => void goto(channelPath(uuid)),
      });
    } catch {
      toastStore.update(toastStore.add(''), 'error', "Couldn't add the feed. Try again.");
    } finally {
      pendingUri = null;
    }
  }

  async function remove(uri: string) {
    try {
      await removeBskyFeedChannel(uri);
    } catch {
      toastStore.update(toastStore.add(''), 'error', "Couldn't remove the feed. Try again.");
    }
  }

  function open(uri: string) {
    const channel = findBskyFeedChannel(uri);
    if (channel) void goto(channelPath(channel.uuid));
    else void add(uri);
  }
</script>

<SourceSectionHeader title="Bluesky feeds" count={bskyFeedsStore.feeds.length || null} />
<SourceList>
  {#each rows as row (row.uri)}
    <SourceRow
      iconUrl={row.avatar ?? null}
      title={row.displayName}
      subtitle={row.uri === 'following' ? 'Your Bluesky timeline' : 'A feed you saved in Bluesky'}
      description={row.description ?? null}
      fallbackIcon="bluesky"
      subscribed={row.added}
      pending={pendingUri === row.uri}
      onSubscribe={row.added ? null : () => void add(row.uri)}
      onRemove={row.added ? () => void remove(row.uri) : null}
      action={row.added ? { label: 'Open', onclick: () => open(row.uri) } : null}
    />
  {/each}
</SourceList>

{#if !loading && !canReadFeeds}
  <p class="bluesky-note">
    Allow access to read the feeds you saved in Bluesky here. Reading never posts anything; liking
    and replying ask separately.
    <button
      type="button"
      disabled={auth.grantingPermissions}
      onclick={() => bskyFeedsStore.requestRead('/sources#bluesky')}>Allow access</button
    >
  </p>
{:else if savedError}
  <p class="bluesky-note">Couldn't read your saved feeds from Bluesky. Try again later.</p>
{/if}

<style>
  .bluesky-note {
    margin: 0.5rem 0 0;
    padding: 0 0.75rem;
    font-size: var(--text-sm);
    line-height: var(--leading-normal);
    color: var(--color-text-secondary);
  }

  .bluesky-note button {
    padding: 0;
    font: inherit;
    color: var(--color-primary);
    background: none;
    border: none;
    cursor: pointer;
  }

  .bluesky-note button:hover:not(:disabled) {
    text-decoration: underline;
  }
</style>
