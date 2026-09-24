<script lang="ts">
  // Home for an account with nothing in it yet: no sources, no saves. It leads
  // with something to read (what your Bluesky follows are sharing), then offers
  // to bring in what you already read, then suggestions. Portability is one
  // line pointing at Settings, where the real controls live. The lanes take
  // over as soon as there is a library to draw them from.
  import Icon from '$lib/components/Icon.svelte';
  import ImportOPMLModal from '$lib/components/ImportOPMLModal.svelte';
  import SourcesDiscovery from '$lib/components/sources/SourcesDiscovery.svelte';
  import HomeFollowsStart from './HomeFollowsStart.svelte';
  import type { FollowLink } from '$lib/types';

  interface Props {
    /** False when the reader hid "Shared by people you follow" in Customize. */
    showFollows: boolean;
    onOpenFollowLink: (link: FollowLink) => void;
    onAddFeed: () => void;
    onAddHandle: () => void;
  }

  let { showFollows, onOpenFollowLink, onAddFeed, onAddHandle }: Props = $props();

  let showImportModal = $state(false);
</script>

<div class="first-run" class:solo={!showFollows}>
  {#if showFollows}
    <div class="read-now">
      <HomeFollowsStart onOpen={onOpenFollowLink} />
    </div>
  {/if}

  <aside class="build" aria-labelledby="first-run-add-title">
    <h2 id="first-run-add-title">Bring in what you already read</h2>
    <p class="lede">Sites, blogs, and Atmosphere publications, together in one calm list.</p>

    <div class="add-actions">
      <button type="button" class="add-action" onclick={onAddFeed}>
        <Icon name="rss" size={16} />
        <span class="label">Add a site or RSS feed</span>
        <Icon name="chevron-right" size={16} />
      </button>
      <button type="button" class="add-action" onclick={onAddHandle}>
        <Icon name="at-sign" size={16} />
        <span class="label">Add an Atmosphere publication</span>
        <Icon name="chevron-right" size={16} />
      </button>
      <button type="button" class="add-action" onclick={() => (showImportModal = true)}>
        <Icon name="file-text" size={16} />
        <span class="label">Import OPML</span>
        <Icon name="chevron-right" size={16} />
      </button>
    </div>

    <div class="discovery">
      <SourcesDiscovery />
    </div>

    <p class="ownership">
      What you follow stays private on Skyreader. Atmospheric sync makes it portable across the
      Atmosphere, and public. <a href="/settings#subscriptions">Turn it on in Settings</a>
    </p>
  </aside>
</div>

<ImportOPMLModal open={showImportModal} onclose={() => (showImportModal = false)} />

<style>
  /* Two columns on a wide card: reading on the left (the wider share, since it's
     the point), building the library on the right. Stacks below 1000px, reading
     first. */
  .first-run {
    display: grid;
    grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
    gap: 2.5rem 3.5rem;
    align-items: start;
    padding: 0.75rem 0.25rem 1rem;
  }

  /* Follows hidden in Customize: the build column is all there is. */
  .first-run.solo {
    grid-template-columns: minmax(0, 1fr);
    max-width: 40rem;
  }

  @media (max-width: 1000px) {
    .first-run {
      grid-template-columns: minmax(0, 1fr);
      gap: 2.75rem;
    }
  }

  .read-now {
    min-width: 0;
    max-width: 48rem;
  }

  .build {
    min-width: 0;
  }

  /* On the wide layout the column reads as a side rail: a hairline, not a card. */
  @media (min-width: 1001px) {
    .first-run:not(.solo) .build {
      padding-left: 2rem;
      border-left: 1px solid var(--color-border);
    }
  }

  @media (max-width: 1000px) {
    .first-run:not(.solo) .build {
      padding-top: 2rem;
      border-top: 1px solid var(--color-border);
    }
  }

  h2 {
    margin: 0 0 0.375rem;
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    line-height: var(--leading-snug);
    color: var(--color-text);
  }

  .lede {
    margin: 0 0 1rem;
    max-width: 42ch;
    font-size: var(--text-md);
    line-height: var(--leading-normal);
    color: var(--color-text-secondary);
  }

  .add-actions {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    overflow: hidden;
  }

  .add-action {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.7rem 0.875rem;
    font: inherit;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    line-height: var(--leading-snug);
    text-align: left;
    color: var(--color-text);
    background: var(--color-bg);
    border: none;
    cursor: pointer;
    transition: background-color 0.15s ease;
  }

  .add-action + .add-action {
    border-top: 1px solid var(--color-border);
  }

  .add-action .label {
    flex: 1;
  }

  .add-action :global(.icon:first-child) {
    color: var(--color-primary);
  }

  .add-action :global(.icon:last-child) {
    color: var(--color-text-secondary);
  }

  .add-action:hover {
    background: var(--color-bg-secondary);
  }

  .add-action:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
  }

  .discovery {
    margin-top: 2rem;
  }

  .ownership {
    margin: 2rem 0 0;
    max-width: 48ch;
    font-size: var(--text-sm);
    line-height: var(--leading-normal);
    color: var(--color-text-secondary);
  }

  .ownership a {
    color: var(--color-primary);
    text-underline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .add-action {
      transition: none;
    }
  }
</style>
