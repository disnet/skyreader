<script lang="ts">
  // "Add an article" for a room whose collection accepts additions (yours, open,
  // or one you're a collaborator on — the backend decides, `room.canAdd` reports).
  //
  // One input does both jobs, because both are the same intent: paste a link, or
  // type a few words and pick something you already saved. A library pick carries
  // its metadata straight through, so those add without a fetch; a pasted link
  // gets its title extracted server-side.
  //
  // The membership record is written to YOUR repo, not the collection owner's,
  // which is what makes co-curation possible at all — see the room read path's
  // `includeForeign`. See docs/plans/READING_ROOMS_SPIKE.md.
  import Icon from '$lib/components/Icon.svelte';
  import { api } from '$lib/services/api';
  import { matchesTerms, normalize, parseQuery } from '$lib/services/savedSearch';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { urlKey } from '$lib/utils/urlKey';
  import type { RoomItem, SavedItem } from '$lib/types';

  interface Props {
    collectionUri: string;
    /** urlNormalized of everything already in the room, so a duplicate says so
     *  instead of writing a second membership record for the same article. */
    existingKeys: Set<string>;
    onAdded: (item: RoomItem) => void;
  }

  let { collectionUri, existingKeys, onAdded }: Props = $props();

  const MAX_RESULTS = 6;
  const MIN_QUERY = 2;

  let query = $state('');
  let activeIndex = $state(0);
  let busy = $state(false);
  let inputEl = $state<HTMLInputElement | null>(null);

  type Row =
    | { kind: 'url'; url: string; label: string; duplicate: boolean }
    | { kind: 'saved'; item: SavedItem; duplicate: boolean };

  const trimmed = $derived(query.trim());

  /** The typed text as a link, when it is one. A bare "example.com/post" counts:
   *  people paste from the address bar, which drops the scheme. */
  const typedUrl = $derived.by(() => {
    if (!trimmed || /\s/.test(trimmed)) return null;
    const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    // urlKey rejects anything that isn't an http(s) URL, so it doubles as the
    // validity test — but the raw string is what gets added.
    if (!urlKey(candidate)) return null;
    // Bare words shouldn't masquerade as hosts: require a dot in the hostname.
    try {
      const parsed = new URL(candidate);
      return parsed.hostname.includes('.') ? candidate : null;
    } catch {
      return null;
    }
  });

  const savedMatches = $derived.by(() => {
    const terms = parseQuery(trimmed);
    if (terms.length === 0 || trimmed.length < MIN_QUERY || typedUrl) return [];
    const out: SavedItem[] = [];
    for (const item of savesStore.articles) {
      const haystack = normalize(
        [item.title, item.author, item.description, item.domain, item.url].filter(Boolean).join(' ')
      );
      if (matchesTerms(haystack, terms)) out.push(item);
      if (out.length >= MAX_RESULTS) break;
    }
    return out;
  });

  function isDuplicate(url: string): boolean {
    return existingKeys.has(urlKey(url) ?? url);
  }

  const rows = $derived.by((): Row[] => {
    const list: Row[] = [];
    if (typedUrl) {
      let label = typedUrl;
      try {
        const parsed = new URL(typedUrl);
        label = `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`;
      } catch {
        // keep the raw string
      }
      list.push({ kind: 'url', url: typedUrl, label, duplicate: isDuplicate(typedUrl) });
    }
    for (const item of savedMatches) {
      list.push({ kind: 'saved', item, duplicate: isDuplicate(item.url) });
    }
    return list;
  });

  // Keep the highlighted row in range as the list changes under it.
  $effect(() => {
    if (activeIndex >= rows.length) activeIndex = 0;
  });

  async function add(row: Row) {
    if (busy || row.duplicate) return;
    busy = true;
    try {
      const { item } =
        row.kind === 'url'
          ? await api.addRoomItem(collectionUri, { url: row.url })
          : await api.addRoomItem(collectionUri, {
              url: row.item.url,
              title: row.item.title,
              description: row.item.description,
              author: row.item.author,
              publishedAt: row.item.publishedAt,
            });
      onAdded(item);
      query = '';
      activeIndex = 0;
      inputEl?.focus();
    } catch (error) {
      const message =
        error instanceof Error && /not open/i.test(error.message)
          ? 'This room is not open for additions'
          : 'Could not add the article';
      toastStore.update(toastStore.add(message), 'error');
    } finally {
      busy = false;
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (rows.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeIndex = (activeIndex + 1) % rows.length;
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeIndex = (activeIndex - 1 + rows.length) % rows.length;
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = rows[activeIndex];
      if (row) void add(row);
    } else if (event.key === 'Escape') {
      query = '';
    }
  }
</script>

<div class="add-box">
  <div class="add-field">
    <Icon name="plus" size={16} />
    <input
      bind:this={inputEl}
      class="add-input"
      type="text"
      placeholder="Add an article: paste a link, or search your library"
      bind:value={query}
      onkeydown={onKeydown}
      disabled={busy}
      role="combobox"
      aria-expanded={rows.length > 0}
      aria-controls="room-add-results"
      aria-autocomplete="list"
    />
    {#if busy}
      <span class="add-status">Adding…</span>
    {/if}
  </div>

  <ul class="add-results" id="room-add-results" role="listbox">
    {#each rows as row, i (row.kind === 'url' ? `url:${row.url}` : row.item.rkey)}
      <li role="presentation">
        <button
          class="add-result"
          class:active={i === activeIndex}
          role="option"
          aria-selected={i === activeIndex}
          disabled={busy || row.duplicate}
          onmouseenter={() => (activeIndex = i)}
          onclick={() => add(row)}
        >
          <Icon name={row.kind === 'url' ? 'link' : 'bookmark'} size={14} />
          <span class="add-result-main">
            {#if row.kind === 'url'}
              <span class="add-result-title">Add this link</span>
              <span class="add-result-meta">{row.label}</span>
            {:else}
              <span class="add-result-title">{row.item.title || row.item.url}</span>
              <span class="add-result-meta">{row.item.domain ?? ''}</span>
            {/if}
          </span>
          {#if row.duplicate}
            <span class="add-result-note">Already here</span>
          {/if}
        </button>
      </li>
    {/each}
    {#if trimmed.length >= MIN_QUERY && rows.length === 0}
      <li class="add-empty">Nothing in your library matches. Paste a link to add it.</li>
    {/if}
  </ul>
</div>

<style>
  .add-box {
    margin-bottom: 1.5rem;
  }

  .add-field {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    color: var(--color-text-secondary);
  }

  .add-field:focus-within {
    border-color: var(--color-primary);
  }

  .add-input {
    flex: 1;
    min-width: 0;
    border: none;
    background: none;
    padding: 0;
    font-size: var(--text-md);
    color: var(--color-text);
  }

  .add-input:focus {
    outline: none;
  }

  .add-status {
    font-size: var(--text-sm);
    white-space: nowrap;
  }

  .add-results {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .add-result {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    text-align: left;
    padding: 0.5rem 0.75rem;
    background: none;
    border: none;
    border-radius: 6px;
    color: var(--color-text-secondary);
    font: inherit;
    cursor: pointer;
  }

  .add-result.active:not(:disabled) {
    background: var(--color-bg-secondary);
  }

  .add-result:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .add-result-main {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
    flex: 1;
  }

  .add-result-title {
    font-size: var(--text-sm);
    color: var(--color-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .add-result-meta {
    font-size: var(--text-xs);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .add-result-note {
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .add-empty {
    padding: 0.5rem 0.75rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }
</style>
