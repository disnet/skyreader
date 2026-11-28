<script lang="ts">
  // Updates on what you're watching: saves the reader switched Watch on, with
  // what's happened to each since they last looked (stores/savedWatches.svelte.ts).
  // A lane with one tile per save, a line per kind of news: who posted it on
  // Bluesky or noted it on margin.at, which paper cited it. A tile stays until
  // the reader marks it seen, here or all at once. New connections keep their
  // own lane (NewConnections.svelte), since they reach every save.
  import { tick } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import HomeLane from '$lib/components/feed/HomeLane.svelte';
  import type { LaneCardVM } from '$lib/components/feed/homeLane';
  import { decodeEntities } from '$lib/utils/entities';
  import { getFaviconUrl } from '$lib/utils/favicon';
  import { formatRelativeTime } from '$lib/utils/date';
  import { shelfKind } from '$lib/utils/shelf';
  import { updatesLabel, watchEventIcon, watchEventLine } from '$lib/utils/watchEvents';
  import type { SaveWatch, SavedItem } from '$lib/types';

  interface Entry {
    save: SavedItem;
    watch: SaveWatch;
  }

  interface Props {
    entries: Entry[];
    onOpen: (save: SavedItem) => void;
    onHover?: (save: SavedItem) => void;
    /** Clear one save's updates. */
    onMarkSeen?: (save: SavedItem) => void;
    /** Clear every save's updates. */
    onClearAll?: () => void;
  }

  let { entries, onOpen, onHover, onMarkSeen, onClearAll }: Props = $props();

  let byKey = $derived(new Map(entries.map((entry) => [entry.save.rkey, entry])));
  // HomeLane wants view-models for its keys and its label; the tiles below draw
  // from the entry itself.
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

  // Clearing a tile takes it out of the lane, so focus moves to a neighbour's
  // title rather than falling back to the top of the page.
  async function markSeen(e: MouseEvent, save: SavedItem) {
    const tile = (e.currentTarget as HTMLElement).closest('.tile');
    const lane = tile?.parentElement?.closest('section');
    const titles = lane ? [...lane.querySelectorAll<HTMLElement>('[data-tile-title]')] : [];
    const at = titles.findIndex((t) => tile?.contains(t));
    const neighbour = titles[at + 1] ?? titles[at - 1];
    onMarkSeen?.(save);
    await tick();
    neighbour?.focus();
  }
</script>

{#snippet tile(vm: LaneCardVM)}
  {@const entry = byKey.get(vm.key)}
  {#if entry}
    {@const save = entry.save}
    {@const events = entry.watch.events}
    {@const count = updatesLabel(entry.watch.unseen)}
    {@const more = Math.max(0, entry.watch.unseen - events.length)}
    <div
      class="tile"
      role="group"
      aria-label="{vm.title}, {count}"
      onpointerenter={() => onHover?.(save)}
      onfocusin={() => onHover?.(save)}
    >
      <button class="save" data-tile-title onclick={() => onOpen(save)}>
        {#if save.url && isArticle(save)}
          <img class="favicon" src={getFaviconUrl(save.url)} alt="" loading="lazy" />
        {/if}
        <span class="save-title">{vm.title}</span>
      </button>

      <ul class="events">
        {#each events as event, i (i)}
          <li class="event">
            <span class="event-icon" aria-hidden="true">
              <Icon name={watchEventIcon(event)} size={13} />
            </span>
            <span class="event-line"
              >{#each watchEventLine(event) as segment, j (j)}{#if segment.href}<a
                    href={segment.href}
                    target="_blank"
                    rel="noopener noreferrer">{segment.text}</a
                  >{:else}{segment.text}{/if}{/each}</span
            >
          </li>
        {/each}
      </ul>

      <span class="meta">
        <span class="meta-text">
          {#if saveSite(save)}<span class="site">{saveSite(save)}</span><span aria-hidden="true"
              >·</span
            >{/if}
          {#if entry.watch.latestAt}<span>{formatRelativeTime(entry.watch.latestAt)}</span>{/if}
          {#if more > 0}<span aria-hidden="true">·</span><span>+{more} more</span>{/if}
        </span>
        {#if onMarkSeen}
          <button
            class="seen"
            aria-label="Mark {count} on {vm.title} as seen"
            title="Mark seen"
            onclick={(e) => markSeen(e, save)}
          >
            <Icon name="check" size={14} />
          </button>
        {/if}
      </span>
    </div>
  {/if}
{/snippet}

<HomeLane
  title="Updates on what you're watching"
  icon="bell"
  {items}
  card={tile}
  resetOnChange={false}
  action={onClearAll ? { kind: 'button', label: 'Mark all seen', onClick: onClearAll } : undefined}
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
    width: 19rem;
    flex-shrink: 0;
    padding: 0.75rem 0.875rem 0.6rem;
    border: 1px solid var(--color-border);
    border-radius: 12px;
    color: var(--color-text);
    scroll-snap-align: start;
  }

  @media (max-width: 640px) {
    .tile {
      width: 16rem;
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

  button:focus-visible,
  a:focus-visible {
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

  .events {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .event {
    display: flex;
    align-items: flex-start;
    gap: 0.45rem;
    min-width: 0;
    font-size: var(--text-sm);
    line-height: var(--leading-snug);
  }

  .event-icon {
    display: inline-flex;
    flex-shrink: 0;
    margin-top: 0.125rem;
    color: var(--color-text-secondary);
  }

  .event-line {
    min-width: 0;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .event-line a {
    color: var(--color-primary);
    text-decoration: none;
  }

  @media (hover: hover) {
    .event-line a:hover {
      text-decoration: underline;
    }
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
    display: flex;
    gap: 0.3rem;
    overflow: hidden;
    white-space: nowrap;
  }

  .site {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .seen {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    margin: -0.25rem -0.375rem -0.25rem 0;
    border-radius: 6px;
    color: var(--color-text-secondary);
  }

  .seen:hover {
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }
</style>
