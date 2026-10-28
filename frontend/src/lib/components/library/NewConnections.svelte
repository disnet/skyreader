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
  import { SvelteSet } from 'svelte/reactivity';
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
  import {
    NON_DIRECTIONAL_CONNECTION_TYPES,
    type BlueskyProfile,
    type SavedConnectionActivity,
    type SavedConnectionDetail,
    type SavedItem,
    type SembleConnectionType,
  } from '$lib/types';

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

  let linkMenu = $state<(LinkMenuState & { from: SavedItem }) | null>(null);
  // Where focus goes back to when the menu closes.
  let linkMenuAnchor: HTMLElement | null = null;

  // As links in the reader: a plain tap asks what to do with it, a modified
  // click (new tab, new window) is the browser's.
  // No link text: the label is read off the URL, and the menu would hand it to a
  // save or a Semble card as the page's title.
  // `from` is the save the tile is about, so the menu can offer to connect
  // back: the reader's own edge between their save and the page someone
  // linked to it.
  function openLinkMenu(e: MouseEvent, url: string, from: SavedItem) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    linkMenuAnchor = e.currentTarget as HTMLElement;
    linkMenu = { url, linkText: '', anchorRect: linkMenuAnchor.getBoundingClientRect(), from };
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
    // If news brings the save back, its tile comes back folded.
    expanded.delete(save.rkey);
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

  // The relation, the way the discussion's Connections tab says it: an arrow
  // shows which way a directional one runs ("supports → this": the other piece
  // supports the save). Related and helpful read the same both ways.
  function relation(connection: SavedConnectionDetail): string | null {
    const type = connectionTypeLabel(connection.type);
    if (!type) return null;
    const directional = !NON_DIRECTIONAL_CONNECTION_TYPES.includes(
      connection.type as SembleConnectionType
    );
    if (!directional) return type;
    return connection.direction === 'out' ? `this → ${type}` : `${type} → this`;
  }

  // A note longer than its lines says so with a toggle under the tile's
  // connections, which opens the tile's notes in place: the tile grows to hold
  // them. Cut-off notes are kept by connection, opened tiles by save.
  const clamped = new SvelteSet<string>();
  const expanded = new SvelteSet<string>();

  // Watches a note while it's clamped: it's cut off when its text runs past its
  // box. Fonts, the lane's width and the tile's own changes all show up as a
  // resize; new text re-runs the watch. Measured a frame later, so what it
  // changes can't resize what it's watching inside the same observation.
  function watchClamp(uri: string, open: boolean, _text: string | null) {
    return (el: HTMLElement) => {
      if (open) return;
      let frame = 0;
      const measure = () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          if (el.scrollHeight > el.clientHeight + 1) clamped.add(uri);
          else clamped.delete(uri);
        });
      };
      const observer = new ResizeObserver(measure);
      observer.observe(el);
      return () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
      };
    };
  }

  function toggleNotes(save: SavedItem) {
    if (expanded.has(save.rkey)) expanded.delete(save.rkey);
    else expanded.add(save.rkey);
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
    {@const open = expanded.has(save.rkey)}
    {@const cut = connections.some((c) => clamped.has(c.uri))}
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
        <ul class="edges" id="edges-{save.rkey}">
          {#each connections as connection (connection.uri)}
            {@const avatar = profiles.get(connection.curatorDid)?.avatar}
            {@const label = connectionTargetLabel(connection.otherUrl)}
            {@const rel = relation(connection)}
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
                  <span class="by"
                    ><span class="who" dir="auto" title={curatorName(connection.curatorDid)}
                      >{curatorName(connection.curatorDid)}</span
                    >
                    <span class="verb"
                      >{connection.direction === 'out' ? 'linked it to' : 'linked to it from'}</span
                    ></span
                  >
                  <a
                    class="other"
                    href={connection.otherUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onclick={(e) => openLinkMenu(e, connection.otherUrl, save)}>{label}</a
                  >
                </span>
                {#if rel || connection.note}
                  <span
                    class="note"
                    class:short={!single}
                    class:open
                    {@attach watchClamp(connection.uri, open, connection.note)}
                    >{#if rel}<span class="type">{rel}</span>{' '}{/if}{connection.note ?? ''}</span
                  >
                {/if}
              </span>
            </li>
          {/each}
        </ul>
        {#if open || cut}
          <button
            class="note-toggle"
            aria-expanded={open}
            aria-controls="edges-{save.rkey}"
            onclick={() => toggleNotes(save)}
            >{open ? 'Show less' : single ? 'Show full note' : 'Show full notes'}</button
          >
        {/if}
      {/if}

      <span class="meta">
        <span class="meta-text">
          {#if saveSite(save)}<span class="site">{saveSite(save)}</span><span aria-hidden="true"
              >·</span
            >{/if}
          {#if connections.length === 0}
            <span>{count}</span>
          {:else}
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
      connectFrom={linkMenu.from.url
        ? {
            url: linkMenu.from.url,
            title: decodeEntities(linkMenu.from.title || '') || undefined,
          }
        : undefined}
      connectLabel="Connect back on Semble…"
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

  /* Two lines, each one line long: who and how, then the link. A long name
     shortens itself rather than pushing the link out of the tile. Padded by
     the link's focus ring (2px outline, 2px offset) so the overflow can't clip it. */
  .edge-line {
    display: flex;
    flex-direction: column;
    min-width: 0;
    margin: -4px;
    padding: 4px;
    color: var(--color-text-secondary);
    overflow: hidden;
  }

  .by {
    display: flex;
    gap: 0.25em;
    min-width: 0;
    white-space: nowrap;
  }

  .who {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: var(--weight-medium);
    color: var(--color-text);
  }

  .verb {
    flex-shrink: 0;
  }

  /* The link has its own line, so a long one shortens itself and the
     direction above it always shows. */
  .other {
    align-self: flex-start;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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

  /* What kind of connection: Semble's relation, as the discussion's
     Connections tab says it. It leads the note, so the two clamp together. */
  .type {
    display: inline-block;
    margin-right: 0.35rem;
    padding: 0 0.4375rem;
    border-radius: 999px;
    background: var(--color-bg-secondary);
    font-size: var(--text-xs);
    line-height: 1.5;
    color: var(--color-text-secondary);
    vertical-align: 1px;
  }

  /* Several connections share the tile: a line of each note. */
  .note.short {
    -webkit-line-clamp: 1;
    line-clamp: 1;
  }

  /* Opened: the whole note, however long. */
  .note.open {
    display: block;
    -webkit-line-clamp: none;
    line-clamp: none;
    overflow: visible;
  }

  .note-toggle {
    align-self: flex-start;
    font-size: var(--text-sm);
    line-height: var(--leading-snug);
    font-weight: var(--weight-medium);
    color: var(--color-text-secondary);
  }

  @media (hover: hover) {
    .note-toggle:hover {
      color: var(--color-text);
      text-decoration: underline;
      text-underline-offset: 2px;
    }
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
