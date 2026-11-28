<script lang="ts">
  // Back again: saves the reader asked to come back to (stores/resurface), once
  // their day has come, the longest-waiting first. A tile leaves when the piece
  // is opened (the reader clears it) or put off with Not yet, which offers the
  // same choices again. No badge, no notification: the lane is the whole of it.
  import Icon from '$lib/components/Icon.svelte';
  import HomeLane from '$lib/components/feed/HomeLane.svelte';
  import type { LaneCardVM } from '$lib/components/feed/homeLane';
  import { decodeEntities } from '$lib/utils/entities';
  import { getFaviconUrl } from '$lib/utils/favicon';
  import { formatAskedWhen, type ResurfaceProps } from '$lib/utils/resurface';
  import { shelfKind } from '$lib/utils/shelf';
  import type { SavedItem } from '$lib/types';

  interface Entry {
    save: SavedItem;
    resurface: ResurfaceProps;
  }

  interface Props {
    entries: Entry[];
    now: number;
    onOpen: (save: SavedItem) => void;
    onHover?: (save: SavedItem) => void;
    onNotYet: (save: SavedItem) => void;
  }

  let { entries, now, onOpen, onHover, onNotYet }: Props = $props();

  let byKey = $derived(new Map(entries.map((entry) => [entry.save.rkey, entry])));
  let items = $derived(
    entries.map(({ save }): LaneCardVM => ({
      key: save.rkey,
      title: saveTitle(save),
      domain: null,
      image: null,
      faviconUrl: '',
      metaLabel: null,
      progress: null,
    }))
  );

  function saveTitle(save: SavedItem): string {
    return decodeEntities(save.title || '') || save.url || 'Untitled';
  }

  function isArticle(save: SavedItem): boolean {
    return shelfKind(save) === 'article';
  }

  function saveSite(save: SavedItem): string | null {
    return (isArticle(save) ? save.domain || save.author : save.author) || null;
  }
</script>

{#snippet tile(vm: LaneCardVM)}
  {@const entry = byKey.get(vm.key)}
  {#if entry}
    {@const save = entry.save}
    <div
      class="tile"
      role="group"
      aria-label={vm.title}
      onpointerenter={() => onHover?.(save)}
      onfocusin={() => onHover?.(save)}
    >
      <button class="save" data-tile-title onclick={() => onOpen(save)}>
        {#if save.url && isArticle(save)}
          <img class="favicon" src={getFaviconUrl(save.url)} alt="" loading="lazy" />
        {/if}
        <span class="save-title">{vm.title}</span>
      </button>

      <p class="asked">
        You asked to come back to this in {formatAskedWhen(entry.resurface.setAt, now)}.
      </p>

      <span class="meta">
        <span class="meta-text">
          {#if saveSite(save)}<span class="site">{saveSite(save)}</span>{/if}
        </span>
        <button class="not-yet" onclick={() => onNotYet(save)}>Not yet</button>
      </span>
    </div>
  {/if}
{/snippet}

<HomeLane
  title="Back again"
  icon="clock"
  {items}
  card={tile}
  resetOnChange={false}
  onOpen={(vm) => {
    const entry = byKey.get(vm.key);
    if (entry) onOpen(entry.save);
  }}
/>

<style>
  .tile {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: 17rem;
    flex-shrink: 0;
    padding: 0.75rem 0.875rem 0.6rem;
    border: 1px solid var(--color-border);
    border-radius: 12px;
    color: var(--color-text);
    scroll-snap-align: start;
  }

  @media (max-width: 640px) {
    .tile {
      width: 15rem;
    }
  }

  button {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: inherit;
    cursor: pointer;
    text-align: left;
  }

  button:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
    border-radius: 4px;
  }

  .save {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
    min-width: 0;
  }

  .favicon {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    margin-top: 0.2rem;
    border-radius: 3px;
  }

  .save-title {
    min-width: 0;
    font-weight: var(--weight-semibold);
    line-height: var(--leading-snug);
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  @media (hover: hover) {
    .save:hover .save-title {
      text-decoration: underline;
      text-decoration-color: var(--color-text-secondary);
      text-underline-offset: 2px;
    }
  }

  .asked {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--leading-snug);
    color: var(--color-text-secondary);
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: auto;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .meta-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }

  .site {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .not-yet {
    padding: 0.25rem 0.375rem;
    margin: -0.25rem -0.375rem -0.25rem 0;
    border-radius: 6px;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .not-yet:hover {
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }
</style>
