<script lang="ts">
  // "Add an article" for a room whose collection accepts additions (yours, open,
  // or one you're a collaborator on — the backend decides, `room.canAdd` reports).
  //
  // One input does both jobs, because both are the same intent: paste a link, or
  // type a few words and pick something you already saved. A library pick carries
  // its metadata straight through, so those add without a fetch; a pasted link
  // gets its title extracted server-side.
  //
  // The field, panel and rows are RoomCombo's — shared with the room opener on
  // the index, which is the same interaction. What lives here is what the rows
  // mean.
  //
  // The membership record is written to YOUR repo, not the collection owner's,
  // which is what makes co-curation possible at all — see the room read path's
  // `includeForeign`. See docs/plans/READING_ROOMS_SPIKE.md.
  import RoomCombo, { type ComboRow } from './RoomCombo.svelte';
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
  /** The one row that isn't a save: whatever was pasted. */
  const URL_KEY = 'url';

  let query = $state('');
  let busy = $state(false);

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

  const typedUrlLabel = $derived.by(() => {
    if (!typedUrl) return '';
    try {
      const parsed = new URL(typedUrl);
      return `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`;
    } catch {
      return typedUrl;
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

  const rows = $derived.by((): ComboRow[] => {
    const list: ComboRow[] = [];
    if (typedUrl) {
      const duplicate = isDuplicate(typedUrl);
      list.push({
        key: URL_KEY,
        icon: 'link',
        title: 'Add this link',
        meta: typedUrlLabel,
        note: duplicate ? 'Already here' : null,
        disabled: duplicate,
      });
    }
    for (const item of savedMatches) {
      const duplicate = isDuplicate(item.url);
      list.push({
        // Keyed by rkey, not url: the key has to be unique across the list, and
        // the url is the one field a save could conceivably share with another.
        key: item.rkey,
        icon: 'bookmark',
        title: item.title || item.url,
        meta: item.domain ?? null,
        note: duplicate ? 'Already here' : null,
        disabled: duplicate,
      });
    }
    return list;
  });

  const hint = $derived(
    trimmed.length >= MIN_QUERY && rows.length === 0
      ? 'Nothing in your library matches. Paste a link to add it.'
      : null
  );

  async function add(key: string) {
    if (busy) return;
    // The URL row carries no save behind it; everything else is keyed by the
    // save's own url.
    const saved = key === URL_KEY ? null : savedMatches.find((item) => item.rkey === key);
    const url = key === URL_KEY ? typedUrl : saved?.url;
    if (!url) return;
    busy = true;
    try {
      const { item } = await api.addRoomItem(
        collectionUri,
        saved
          ? {
              url: saved.url,
              title: saved.title,
              description: saved.description,
              author: saved.author,
              publishedAt: saved.publishedAt,
            }
          : { url }
      );
      onAdded(item);
      // The row lands at the end of the room's unread pile, which can be below
      // the fold, so the toast is the confirmation.
      toastStore.update(toastStore.add('Added to the room'), 'success');
      query = '';
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
</script>

<RoomCombo
  bind:value={query}
  placeholder="Add an article: paste a link, or search your library"
  icon="plus"
  idPrefix="room-add"
  {rows}
  {hint}
  {busy}
  busyLabel="Adding…"
  onChoose={(key) => void add(key)}
/>
