<script lang="ts">
  // Opening a room from the /rooms index. One field does both jobs, because both
  // are the same intent: paste a room or collection link, or click in and pick
  // one of your own Semble/Margin collections. A collection you already keep IS
  // a room, so the list you curate elsewhere is the shortest way into one — no
  // trip to semble.so to copy a URL back here.
  //
  // Collections load on first focus (stale-while-revalidate, collections.svelte.ts),
  // so nobody who never opens the list pays for it, and a cached list opens with
  // the click. A provider the user hasn't connected simply contributes nothing.
  //
  // The field, panel and rows are RoomCombo's — shared with the article adder,
  // which is the same interaction. What lives here is what the rows mean.
  import RoomCombo, { type ComboRow } from './RoomCombo.svelte';
  import { matchesTerms, normalize, parseQuery } from '$lib/services/savedSearch';
  import { resolveRoomInput } from '$lib/services/rooms';
  import { auth } from '$lib/stores/auth.svelte';
  import {
    collectionsStore,
    type CollectionEntry,
    type IntegrationKind,
  } from '$lib/stores/collections.svelte';

  interface Props {
    /** Collection uris already under "Your rooms" — marked, not hidden: picking
     *  one here is still the quickest way back in. */
    joinedSubjects: Set<string>;
    onOpen: (uri: string) => void;
  }

  let { joinedSubjects, onOpen }: Props = $props();

  /** Rows shown at once. Past this the field says so and asks for a few more
   *  letters, rather than growing a panel nobody reads to the bottom of. */
  const MAX_RESULTS = 8;
  const PROVIDERS: IntegrationKind[] = ['semble', 'margin'];
  /** The one row that isn't a collection: whatever was pasted. */
  const LINK_KEY = 'link';

  let query = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);

  function loadCollections() {
    if (!auth.user) return;
    for (const provider of PROVIDERS) void collectionsStore.loadAndRefresh(provider);
  }

  const trimmed = $derived(query.trim());

  /** The typed text as something that resolves to a room: an at-uri, a /rooms
   *  link, or a collection page. A bare "semble.so/profile/…" counts — people
   *  paste from the address bar, which drops the scheme. Only shape is checked
   *  here; resolveRoomInput does the real work when the row is chosen. */
  const typedLink = $derived.by(() => {
    if (!trimmed || /\s/.test(trimmed)) return null;
    if (trimmed.startsWith('at://')) return trimmed;
    try {
      const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
      // Bare words shouldn't masquerade as hosts: require a dot in the hostname.
      return url.hostname.includes('.') ? url.toString() : null;
    } catch {
      return null;
    }
  });

  const linkLabel = $derived.by(() => {
    if (!typedLink) return '';
    if (typedLink.startsWith('at://')) return typedLink;
    try {
      const url = new URL(typedLink);
      return `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`;
    } catch {
      return typedLink;
    }
  });

  interface CollectionRow {
    provider: IntegrationKind;
    entry: CollectionEntry;
    joined: boolean;
  }

  function collectionName(entry: CollectionEntry): string {
    return entry.name?.trim() || 'Untitled collection';
  }

  const providerLabel = (provider: IntegrationKind) =>
    provider === 'semble' ? 'Semble' : 'Margin';

  const allCollections = $derived.by(() => {
    const rows: CollectionRow[] = [];
    for (const provider of PROVIDERS) {
      for (const entry of collectionsStore.collections[provider]) {
        rows.push({ provider, entry, joined: joinedSubjects.has(entry.uri) });
      }
    }
    return rows;
  });

  const loadingCollections = $derived(
    PROVIDERS.some((p) => collectionsStore.loading[p]) && allCollections.length === 0
  );

  // Once the text is a link, it is a link — narrowing a name list under it would
  // only be noise beside the one row that can act on what was pasted.
  const matches = $derived.by(() => {
    if (typedLink) return [];
    const terms = parseQuery(trimmed);
    const rows =
      terms.length === 0
        ? [...allCollections]
        : allCollections.filter((row) =>
            matchesTerms(
              normalize(
                [collectionName(row.entry), row.entry.description].filter(Boolean).join(' ')
              ),
              terms
            )
          );
    const first = terms[0] ?? '';
    // A name match reads as the answer; a description-only match reads as a
    // near miss, so it sits below. With an empty field there's nothing to rank
    // by but use: the collections you file into are the ones you read in.
    const nameHit = (row: CollectionRow) =>
      first && normalize(collectionName(row.entry)).includes(first) ? 0 : 1;
    return rows.sort(
      (a, b) =>
        nameHit(a) - nameHit(b) ||
        (b.entry.lastUsedAt ?? 0) - (a.entry.lastUsedAt ?? 0) ||
        collectionName(a.entry).localeCompare(collectionName(b.entry), undefined, {
          sensitivity: 'base',
        })
    );
  });

  const shown = $derived(matches.slice(0, MAX_RESULTS));
  const hiddenCount = $derived(matches.length - shown.length);

  const rows = $derived.by((): ComboRow[] => {
    const list: ComboRow[] = [];
    if (typedLink) {
      list.push({ key: LINK_KEY, icon: 'link', title: 'Open this link', meta: linkLabel });
    }
    for (const row of shown) {
      list.push({
        key: row.entry.uri,
        icon: row.provider,
        title: collectionName(row.entry),
        meta:
          providerLabel(row.provider) +
          (row.entry.description ? ` · ${row.entry.description}` : ''),
        note: row.joined ? 'Joined' : null,
      });
    }
    return list;
  });

  // A panel with nothing in it stays shut: an empty field before the collections
  // have loaded has nothing to say yet.
  const hint = $derived.by(() => {
    if (hiddenCount > 0) return `${hiddenCount} more. Keep typing to narrow.`;
    if (loadingCollections) return 'Loading your collections…';
    if (rows.length === 0 && trimmed.length > 0) {
      return 'No collection matches. Paste a room link to open one.';
    }
    return null;
  });

  async function choose(key: string) {
    if (busy) return;
    if (key !== LINK_KEY) {
      error = null;
      query = '';
      onOpen(key);
      return;
    }
    busy = true;
    // A semble.so collection page needs a handle → DID resolution, so this is async.
    const parsed = await resolveRoomInput(typedLink ?? '');
    busy = false;
    if (!parsed) {
      error = 'That does not look like a room link.';
      return;
    }
    error = null;
    query = '';
    onOpen(parsed);
  }

  // Enter or "Open" with no row to take it: the text isn't link-shaped and
  // nothing matched. Say so where the reader is looking rather than leaving the
  // button inert.
  function onSubmit() {
    if (!trimmed) return;
    error = 'That does not look like a room link.';
  }
</script>

<RoomCombo
  bind:value={query}
  placeholder="Paste a Semble or Margin collection link, or pick one of your collections"
  icon="search"
  idPrefix="room-open"
  {rows}
  {hint}
  {busy}
  {error}
  action={{ label: 'Open', busyLabel: 'Opening…' }}
  onChoose={(key) => void choose(key)}
  onFirstOpen={loadCollections}
  onInput={() => (error = null)}
  {onSubmit}
/>
