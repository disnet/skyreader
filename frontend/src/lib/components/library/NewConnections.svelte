<script lang="ts">
  // The Shelf's New connections: what other people connected to the reader's
  // saves since they last looked, said in full — who, to what, and their note —
  // grouped under the save it's about. Semble's notification feed, attached to
  // the thing it's news about (stores/savedConnections.svelte.ts). Opening the
  // save reads it in full and clears it from here.
  import Icon from '$lib/components/Icon.svelte';
  import { profileService } from '$lib/services/profiles';
  import { decodeEntities } from '$lib/utils/entities';
  import { getFaviconUrl } from '$lib/utils/favicon';
  import { formatRelativeTime } from '$lib/utils/date';
  import { connectionTargetLabel, connectionTypeLabel } from '$lib/utils/connectionLabels';
  import { shelfKind } from '$lib/utils/shelf';
  import { untrack } from 'svelte';
  import type { BlueskyProfile, SavedConnectionActivity, SavedItem } from '$lib/types';

  interface Entry {
    save: SavedItem;
    activity: SavedConnectionActivity;
  }

  interface Props {
    entries: Entry[];
    onOpen: (save: SavedItem) => void;
    onHover?: (save: SavedItem) => void;
  }

  let { entries, onOpen, onHover }: Props = $props();

  /** Saves shown before "Show more": the lane stays a glance, not a feed. */
  const PREVIEW = 4;
  let expanded = $state(false);
  let shown = $derived(expanded ? entries : entries.slice(0, PREVIEW));

  // Curators are DIDs on the wire; their names come from the public appview,
  // after the first paint (a handle-less line still reads).
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
  // article to its site, and only an article wears a favicon.
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

<section class="new-connections" aria-label="New connections">
  <h2 class="title">
    <span class="title-icon"><Icon name="semble" size={16} /></span>
    New connections
  </h2>

  <ul class="saves">
    {#each shown as entry (entry.save.rkey)}
      {@const save = entry.save}
      <li class="save">
        <button
          class="save-head"
          onclick={() => onOpen(save)}
          onpointerenter={() => onHover?.(save)}
          onfocus={() => onHover?.(save)}
        >
          {#if save.url && isArticle(save)}
            <img class="favicon" src={getFaviconUrl(save.url)} alt="" loading="lazy" />
          {/if}
          <span class="save-title">{saveTitle(save)}</span>
          {#if saveSite(save)}<span class="save-site">{saveSite(save)}</span>{/if}
        </button>

        <ul class="edges">
          {#each entry.activity.newest as connection (connection.uri)}
            {@const profile = profiles.get(connection.curatorDid)}
            {@const type = connectionTypeLabel(connection.type)}
            <li class="edge">
              <span class="avatar" aria-hidden="true">
                {#if profile?.avatar}
                  <img src={profile.avatar} alt="" loading="lazy" />
                {:else}
                  <Icon name="user" size={12} />
                {/if}
              </span>
              <div class="edge-body">
                <p class="edge-line">
                  <span class="who">{curatorName(connection.curatorDid)}</span>
                  {#if connection.direction === 'out'}
                    linked it to
                    <a
                      class="other"
                      href={connection.otherUrl}
                      target="_blank"
                      rel="noopener noreferrer">{connectionTargetLabel(connection.otherUrl)}</a
                    >
                  {:else}
                    linked
                    <a
                      class="other"
                      href={connection.otherUrl}
                      target="_blank"
                      rel="noopener noreferrer">{connectionTargetLabel(connection.otherUrl)}</a
                    >
                    to it
                  {/if}
                  <span class="meta">
                    {#if type && type !== 'related'}· {type}{/if}
                    · {formatRelativeTime(connection.indexedAt)}
                  </span>
                </p>
                {#if connection.note}
                  <p class="note">{connection.note}</p>
                {/if}
              </div>
            </li>
          {/each}
        </ul>

        {#if more(entry) > 0 || entry.activity.newest.length === 0}
          <button class="more" onclick={() => onOpen(save)}>
            {#if entry.activity.newest.length === 0}
              {entry.activity.unseen} new {entry.activity.unseen === 1
                ? 'connection'
                : 'connections'}
            {:else}
              and {more(entry)} more
            {/if}
          </button>
        {/if}
      </li>
    {/each}
  </ul>

  {#if entries.length > PREVIEW}
    <button class="toggle" onclick={() => (expanded = !expanded)}>
      {expanded ? 'Show fewer' : `Show ${entries.length - PREVIEW} more`}
    </button>
  {/if}
</section>

<style>
  .new-connections {
    margin-bottom: 1.75rem;
  }

  .title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0 0 0.625rem;
    padding: 0 0.25rem;
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    line-height: var(--leading-snug);
    color: var(--color-text);
  }

  .title-icon {
    display: inline-flex;
    color: var(--color-text-secondary);
  }

  .saves {
    list-style: none;
    margin: 0;
    padding: 0;
    border-top: 1px solid var(--color-border);
  }

  .save {
    padding: 0.75rem 0.25rem;
    border-bottom: 1px solid var(--color-border);
  }

  .save-head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    width: 100%;
    min-width: 0;
    padding: 0;
    background: none;
    border: none;
    font: inherit;
    text-align: left;
    color: var(--color-text);
    cursor: pointer;
  }

  .favicon {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    align-self: center;
    border-radius: 3px;
  }

  .save-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: var(--weight-semibold);
  }

  .save-site {
    flex-shrink: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  @media (hover: hover) {
    .save-head:hover .save-title {
      color: var(--color-primary);
    }
  }

  .save-head:focus-visible,
  .more:focus-visible,
  .toggle:focus-visible,
  .other:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
    border-radius: 4px;
  }

  .edges {
    list-style: none;
    margin: 0.5rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .edge {
    display: flex;
    gap: 0.5rem;
    align-items: flex-start;
  }

  .avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    margin-top: 0.05rem;
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
    min-width: 0;
  }

  .edge-line,
  .note {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--leading-snug);
  }

  .edge-line {
    color: var(--color-text-secondary);
    overflow-wrap: anywhere;
  }

  .who {
    font-weight: var(--weight-medium);
    color: var(--color-text);
  }

  .other {
    color: var(--color-primary);
    text-decoration: none;
  }

  @media (hover: hover) {
    .other:hover {
      text-decoration: underline;
    }
  }

  .meta {
    white-space: nowrap;
  }

  .note {
    margin-top: 0.2rem;
    overflow-wrap: anywhere;
    color: var(--color-text);
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .more,
  .toggle {
    padding: 0.25rem 0;
    margin-top: 0.375rem;
    background: none;
    border: none;
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .more {
    margin-left: 1.75rem;
  }

  .toggle {
    margin-left: 0.25rem;
  }

  @media (hover: hover) {
    .more:hover,
    .toggle:hover {
      color: var(--color-primary);
    }
  }
</style>
