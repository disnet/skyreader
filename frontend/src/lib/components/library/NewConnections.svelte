<script lang="ts">
  // The Shelf's New connections: what other people connected to the reader's
  // saves since they last looked, as a lane with one tile per save. Each tile
  // says what happened — who linked it to what, and their note — for the newest
  // connections, and counts the rest. Semble's notification feed, attached to the
  // thing it's news about (stores/savedConnections.svelte.ts). A tile stays
  // until the reader marks it seen: here, in the save's discussion, or all at once.
  //
  // The tile isn't one button: what the reader wants from the news is the other
  // end, not their own save's discussion. So each connection's far end is a link
  // that opens the reader's usual link menu (open, save, collect), and the save's
  // title goes back to reading it, at the reader's place.
  import { tick, untrack } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import HomeLane from '$lib/components/feed/HomeLane.svelte';
  import LinkContextMenu from '$lib/components/feed/LinkContextMenu.svelte';
  import type { LinkMenuState } from '$lib/hooks/useLinkInterception.svelte';
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
    /** Clear one save's new connections. */
    onMarkSeen?: (save: SavedItem) => void;
    /** Clear every save's new connections. */
    onClearAll?: () => void;
  }

  let { entries, onOpen, onHover, onMarkSeen, onClearAll }: Props = $props();

  let linkMenu = $state<LinkMenuState | null>(null);
  // Where focus goes back to when the menu closes.
  let linkMenuAnchor: HTMLElement | null = null;

  // As links in the reader: a plain tap asks what to do with it, a modified
  // click (new tab, new window) is the browser's.
  // No link text: the label is read off the URL, and the menu would hand it to a
  // save or a Semble card as the page's title.
  function openLinkMenu(e: MouseEvent, url: string) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    linkMenuAnchor = e.currentTarget as HTMLElement;
    linkMenu = { url, linkText: '', anchorRect: linkMenuAnchor.getBoundingClientRect() };
  }

  // A keyboard close (Escape, or an action) hands focus back to the link; a
  // click elsewhere keeps it wherever that click put it.
  function closeLinkMenu() {
    const active = document.activeElement;
    const anchor = linkMenuAnchor;
    const refocus = !active || active === document.body || !!active.closest('[role="menu"]');
    linkMenu = null;
    linkMenuAnchor = null;
    if (refocus && anchor?.isConnected) anchor.focus({ preventScroll: true });
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
    return Math.max(0, entry.activity.unseen - entry.activity.newest.length);
  }
</script>

{#snippet tile(vm: LaneCardVM)}
  {@const entry = byKey.get(vm.key)}
  {#if entry}
    {@const save = entry.save}
    {@const connections = entry.activity.newest}
    {@const single = connections.length === 1}
    {@const type = single ? connectionTypeLabel(connections[0].type) : null}
    {@const count = `${entry.activity.unseen} new ${entry.activity.unseen === 1 ? 'connection' : 'connections'}`}
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

      {#if connections.length > 0}
        <ul class="edges">
          {#each connections as connection (connection.uri)}
            {@const avatar = profiles.get(connection.curatorDid)?.avatar}
            {@const label = connectionTargetLabel(connection.otherUrl)}
            <li class="edge">
              <span class="avatar" aria-hidden="true">
                {#if avatar}
                  <img src={avatar} alt="" loading="lazy" />
                {:else}
                  <Icon name="user" size={11} />
                {/if}
              </span>
              <span class="edge-body">
                <span class="edge-line">
                  <span class="who">{curatorName(connection.curatorDid)}</span>
                  {connection.direction === 'out' ? 'linked it to' : 'linked to it from'}
                  <a
                    class="other"
                    href={connection.otherUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onclick={(e) => openLinkMenu(e, connection.otherUrl)}>{label}</a
                  >
                </span>
                {#if connection.note}
                  <span class="note" class:short={!single}>{connection.note}</span>
                {/if}
              </span>
            </li>
          {/each}
        </ul>
      {/if}

      <span class="meta">
        <span class="meta-text">
          {#if saveSite(save)}<span class="site">{saveSite(save)}</span><span aria-hidden="true"
              >·</span
            >{/if}
          {#if connections.length === 0}
            <span>{count}</span>
          {:else}
            {#if type && type !== 'related'}<span>{type}</span><span aria-hidden="true">·</span
              >{/if}
            <span>{formatRelativeTime(connections[0].indexedAt)}</span>
            {#if more(entry) > 0}
              <span aria-hidden="true">·</span><span class="more">+{more(entry)} more</span>
            {/if}
          {/if}
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

{#if linkMenu}
  {#key linkMenu.url + linkMenu.anchorRect.top + linkMenu.anchorRect.left}
    <LinkContextMenu
      url={linkMenu.url}
      linkText={linkMenu.linkText}
      anchorRect={linkMenu.anchorRect}
      onClose={closeLinkMenu}
    />
  {/key}
{/if}

<style>
  .tile {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    /* Wider than Continue reading's tiles: these carry sentences and notes. */
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
  .other:focus-visible {
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

  .edges {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    margin: 0;
    padding: 0;
    list-style: none;
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

  .edge-body {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 0;
  }

  .edge-line,
  .note,
  .meta {
    font-size: var(--text-sm);
    line-height: var(--leading-snug);
  }

  /* Padded so the clamp doesn't clip the link's focus ring. */
  .edge-line {
    min-width: 0;
    margin: -3px;
    padding: 3px;
    color: var(--color-text-secondary);
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .who {
    font-weight: var(--weight-medium);
    color: var(--color-text);
  }

  /* The link ends the sentence either way ("linked it to …", "linked to it
     from …"), so a long one shortens itself and the direction always shows. */
  .other {
    display: inline-block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: bottom;
    font-weight: var(--weight-medium);
    color: var(--color-primary);
    text-decoration: none;
  }

  @media (hover: hover) {
    .other:hover {
      text-decoration: underline;
      text-underline-offset: 2px;
    }
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

  /* Several connections share the tile: a line of each note. */
  .note.short {
    -webkit-line-clamp: 1;
    line-clamp: 1;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: auto;
    color: var(--color-text-secondary);
  }

  .meta-text {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    min-width: 0;
    flex: 1;
  }

  .site {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .more {
    color: var(--color-text);
    font-weight: var(--weight-medium);
  }

  .seen,
  .seen:focus-visible {
    border-radius: 50%;
  }

  .seen {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    margin: -4px -6px -4px 0;
    color: var(--color-text-secondary);
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }

  @media (hover: hover) {
    .seen:hover {
      background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.04));
      color: var(--color-text);
    }
  }
</style>
