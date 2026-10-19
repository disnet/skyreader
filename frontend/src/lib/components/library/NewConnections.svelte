<script lang="ts">
  // The Shelf's New connections: what other people connected to the reader's
  // saves since they last looked, as a lane with one tile per save. Each tile
  // says what happened — who linked it to what, and their note — for the newest
  // connection, and counts the rest. Semble's notification feed, attached to the
  // thing it's news about (stores/savedConnections.svelte.ts). A tile stays
  // until the reader marks it seen, in the save's discussion or all at once here.
  import { untrack } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import HomeLane from '$lib/components/feed/HomeLane.svelte';
  import type { LaneCardVM } from '$lib/components/feed/homeLane';
  import { profileService } from '$lib/services/profiles';
  import { decodeEntities } from '$lib/utils/entities';
  import { getFaviconUrl } from '$lib/utils/favicon';
  import { formatRelativeTime } from '$lib/utils/date';
  import { connectionTargetLabel, connectionTypeLabel } from '$lib/utils/connectionLabels';
  import { shelfKind } from '$lib/utils/shelf';
  import type { BlueskyProfile, SavedConnectionActivity, SavedItem } from '$lib/types';

  interface Entry {
    save: SavedItem;
    activity: SavedConnectionActivity;
  }

  interface Props {
    entries: Entry[];
    onOpen: (save: SavedItem) => void;
    onHover?: (save: SavedItem) => void;
    /** Clear every save's new connections. */
    onClearAll?: () => void;
  }

  let { entries, onOpen, onHover, onClearAll }: Props = $props();

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

  // Curators are DIDs on the wire; their names come from the public appview,
  // after the first paint (a name-less line still reads).
  let profiles = $state<Map<string, BlueskyProfile>>(new Map());
  let curatorKey = $derived(
    [...new Set(entries.flatMap((e) => e.activity.newest.map((c) => c.curatorDid)))]
      .sort()
      .join(',')
  );
  // Asked once each: a DID the appview doesn't know shouldn't be asked again.
  const asked = new Set<string>();
  $effect(() => {
    const dids = curatorKey ? curatorKey.split(',') : [];
    const missing = untrack(() => dids.filter((did) => !asked.has(did) && !profiles.has(did)));
    if (missing.length === 0) return;
    for (const did of missing) asked.add(did);
    // Not cancelled when the set changes: what it finds is still worth keeping.
    profileService
      .getProfiles(missing)
      .then((found) => {
        if (found.size === 0) return;
        const next = new Map(profiles);
        for (const [did, profile] of found) next.set(did, profile);
        profiles = next;
      })
      .catch(() => {
        // Names are adornment; the line reads without them.
      });
  });

  function curatorName(did: string): string {
    const profile = profiles.get(did);
    return profile?.displayName?.trim() || (profile?.handle ? `@${profile.handle}` : 'Someone');
  }

  function saveTitle(save: SavedItem): string {
    return decodeEntities(save.title || '') || save.url || 'Untitled';
  }

  // As the Shelf's other lanes: a book or PDF is credited to its author, an
  // article to its site.
  function saveSite(save: SavedItem): string | null {
    return (isArticle(save) ? save.domain || save.author : save.author) || null;
  }

  function isArticle(save: SavedItem): boolean {
    return shelfKind(save) === 'article';
  }

  function more(entry: Entry): number {
    return Math.max(0, entry.activity.unseen - 1);
  }
</script>

{#snippet tile(vm: LaneCardVM)}
  {@const entry = byKey.get(vm.key)}
  {#if entry}
    {@const save = entry.save}
    {@const connection = entry.activity.newest[0]}
    {@const type = connection ? connectionTypeLabel(connection.type) : null}
    {@const avatar = connection ? profiles.get(connection.curatorDid)?.avatar : undefined}
    <button
      class="tile"
      aria-label="{vm.title}, {entry.activity.unseen} new {entry.activity.unseen === 1
        ? 'connection'
        : 'connections'}"
      onclick={() => onOpen(save)}
      onpointerenter={() => onHover?.(save)}
      onfocus={() => onHover?.(save)}
    >
      <span class="save">
        {#if save.url && isArticle(save)}
          <img class="favicon" src={getFaviconUrl(save.url)} alt="" loading="lazy" />
        {/if}
        <span class="save-title">{vm.title}</span>
      </span>

      {#if connection}
        <span class="edge">
          <span class="avatar" aria-hidden="true">
            {#if avatar}
              <img src={avatar} alt="" loading="lazy" />
            {:else}
              <Icon name="user" size={11} />
            {/if}
          </span>
          <span class="edge-line">
            <span class="who">{curatorName(connection.curatorDid)}</span>
            {#if connection.direction === 'out'}
              linked it to <span class="other">{connectionTargetLabel(connection.otherUrl)}</span>
            {:else}
              linked to it from <span class="other"
                >{connectionTargetLabel(connection.otherUrl)}</span
              >
            {/if}
          </span>
        </span>
        {#if connection.note}
          <span class="note">{connection.note}</span>
        {/if}
        <span class="meta">
          {#if saveSite(save)}<span class="site">{saveSite(save)}</span><span aria-hidden="true"
              >·</span
            >{/if}
          {#if type && type !== 'related'}<span>{type}</span><span aria-hidden="true">·</span>{/if}
          <span>{formatRelativeTime(connection.indexedAt)}</span>
          {#if more(entry) > 0}
            <span aria-hidden="true">·</span><span class="more">+{more(entry)} more</span>
          {/if}
        </span>
      {:else}
        <span class="meta">
          {#if saveSite(save)}<span class="site">{saveSite(save)}</span><span aria-hidden="true"
              >·</span
            >{/if}
          {entry.activity.unseen} new {entry.activity.unseen === 1 ? 'connection' : 'connections'}
        </span>
      {/if}
    </button>
  {/if}
{/snippet}

<HomeLane
  title="New connections"
  icon="semble"
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
    gap: 0.4rem;
    /* Wider than Continue reading's tiles: these carry a sentence and a note. */
    width: 19rem;
    flex-shrink: 0;
    padding: 0.75rem 0.875rem 0.8rem;
    background: none;
    border: 1px solid var(--color-border);
    border-radius: 12px;
    cursor: pointer;
    text-align: left;
    font: inherit;
    color: var(--color-text);
    scroll-snap-align: start;
    transition:
      background-color 0.15s ease,
      border-color 0.15s ease;
  }

  @media (max-width: 640px) {
    .tile {
      width: 16rem;
    }
  }

  @media (hover: hover) {
    .tile:hover {
      background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.025));
      border-color: var(--color-text-secondary);
    }
  }

  @media (prefers-color-scheme: dark) {
    .tile:hover {
      background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.03));
    }
  }

  .tile:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
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

  .edge {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
    min-width: 0;
  }

  .avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    overflow: hidden;
    background: var(--color-bg-secondary);
    color: var(--color-text-secondary);
  }

  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .edge-line,
  .note,
  .meta {
    font-size: var(--text-sm);
    line-height: var(--leading-snug);
  }

  .edge-line {
    min-width: 0;
    color: var(--color-text-secondary);
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .who,
  .other {
    font-weight: var(--weight-medium);
    color: var(--color-text);
  }

  /* The label ends the sentence either way ("linked it to …", "linked to it
     from …"), so a long one shortens itself and the direction always shows. */
  .other {
    display: inline-block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: bottom;
  }

  .note {
    color: var(--color-text);
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin-top: auto;
    color: var(--color-text-secondary);
  }

  .site {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .more {
    color: var(--color-primary);
    font-weight: var(--weight-medium);
  }
</style>
