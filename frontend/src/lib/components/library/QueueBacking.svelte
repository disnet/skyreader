<script lang="ts" module>
  // Collections whose name has been asked for, across remounts (the line
  // remounts each time the reader closes).
  const askedFor = new Set<string>();
  // Back from granting a provider's permission: reopen the dialog.
  const GRANT_PARAM = 'backing';
</script>

<script lang="ts">
  // Where the Queue lives, on one quiet line under the Library row: on Skyreader
  // (private), or linked to a Semble/Margin collection (public), the way an
  // opened Shelf collection says it's linked. The line opens the same backing
  // picker as Settings, in a dialog, so changing it needn't leave the Queue.
  // See docs/plans/EXTERNAL_BACKED_SAVES_PLAN.md.
  import { onMount } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import Modal from '$lib/components/common/Modal.svelte';
  import SaveBackingPicker from '$lib/components/settings/SaveBackingPicker.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { collectionsStore } from '$lib/stores/collections.svelte';
  import { saveBackingStore } from '$lib/stores/saveBacking.svelte';
  import { syncStore } from '$lib/stores/sync.svelte';
  import { ownCollectionHref } from '$lib/services/rooms';
  import { formatRelativeTime } from '$lib/utils/date';
  import type { SaveBacking } from '$lib/types';

  const providerLabel = (p: 'semble' | 'margin') => (p === 'semble' ? 'Semble' : 'Margin');

  let backing = $derived(saveBackingStore.backing);
  let linked = $derived(backing && backing.provider !== 'skyreader' ? backing : null);
  let collectionName = $derived(
    linked
      ? collectionsStore.collections[linked.provider].find((c) => c.uri === linked.collectionUri)
          ?.name || null
      : null
  );

  // The collection's name comes from the reader's list over there; ask once
  // per collection.
  $effect(() => {
    if (!linked || collectionName || askedFor.has(linked.collectionUri)) return;
    askedFor.add(linked.collectionUri);
    void collectionsStore.loadAndRefresh(linked.provider);
  });

  let open = $state(false);
  let busy = $state(false);
  // The picker's own copy, seeded from the store each time the dialog opens.
  let draft = $state<SaveBacking>({ provider: 'skyreader' });

  function openDialog() {
    draft = backing ?? { provider: 'skyreader' };
    open = true;
  }

  onMount(() => {
    // Guests have no settings. A signed-in reader's are re-read on each mount:
    // one row, and every Queue load moves the sync time on.
    if (auth.isGuest || !syncStore.isOnline) return;
    void saveBackingStore.load().then(() => {
      const url = new URL(window.location.href);
      if (!url.searchParams.has(GRANT_PARAM)) return;
      url.searchParams.delete(GRANT_PARAM);
      history.replaceState(history.state, '', url);
      openDialog();
    });
  });
</script>

{#if backing}
  <p class="queue-backing">
    {#if linked}
      <Icon name="link" size={13} />
      <span>
        Linked to
        <a
          href={ownCollectionHref(linked.collectionUri, auth.user)}
          target="_blank"
          rel="noopener noreferrer"
          >{providerLabel(linked.provider)}{#if collectionName}&nbsp;· {collectionName}{/if}</a
        >, public.
        {#if saveBackingStore.lastSync}
          Synced {formatRelativeTime(saveBackingStore.lastSync)}.
        {/if}
      </span>
      <button class="text-btn" onclick={openDialog}>Change</button>
    {:else}
      <Icon name="lock" size={13} />
      <span>Private to Skyreader.</span>
      <button class="text-btn" onclick={openDialog}>
        <Icon name="link" size={13} />
        Link to Semble or Margin
      </button>
    {/if}
  </p>
{/if}

<Modal
  {open}
  onclose={() => !busy && (open = false)}
  title="Where your Queue lives"
  icon="link"
  description={busy
    ? 'This closes once the change is done.'
    : 'Keep it on Skyreader, or make your saves a public collection.'}
  maxWidth="480px"
>
  {#if open}
    <SaveBackingPicker bind:backing={draft} bind:busy returnUrl="/saved?{GRANT_PARAM}" />
  {/if}
</Modal>

<style>
  /* One run of text, so on a phone it wraps like a sentence rather than
     stacking the icon, the words and the button on lines of their own. */
  .queue-backing {
    margin: -0.25rem 1rem 0.75rem;
    font-size: var(--text-sm);
    line-height: 1.6;
    color: var(--color-text-secondary);
  }

  .queue-backing :global(svg) {
    vertical-align: -2px;
  }

  .queue-backing a {
    color: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .text-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.125rem 0.375rem;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .text-btn:hover {
    color: var(--color-text);
    background: var(--color-bg-secondary);
  }

  .text-btn:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }
</style>
