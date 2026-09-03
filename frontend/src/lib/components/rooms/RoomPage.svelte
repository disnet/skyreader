<script lang="ts">
  // Reading Rooms (spike). A room IS a Semble/Margin collection: this page shows
  // the collection's articles (backend backing read path), who's reading along
  // (Constellation backlinks, client-side), and anonymous per-article read
  // counts scoped to reads made through this surface. Join writes one public
  // readAlong record to the joiner's own repo; that record is the consent
  // boundary that licenses showing their avatar here.
  // See docs/plans/READING_ROOMS_SPIKE.md.
  import { onDestroy } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import SavedReader from '$lib/components/feed/SavedReader.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import RoomAddBox from './RoomAddBox.svelte';
  import { useReaderStack } from '$lib/hooks/useReaderStack.svelte';
  import { api } from '$lib/services/api';
  import { profileService } from '$lib/services/profiles';
  import {
    fetchRoomMembers,
    fetchMyRooms,
    fetchCollectionMeta,
    resolveRoomInput,
    collectionOwnerDid,
    collectionPageLink,
    type CollectionMeta,
    type CollectionPageLink,
    type MyRoom,
  } from '$lib/services/rooms';
  import { auth } from '$lib/stores/auth.svelte';
  import { roomsStore } from '$lib/stores/rooms.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { generateTid } from '$lib/utils/tid';
  import { extractRoomArticle } from '$lib/utils/roomArticle';
  import type { BlueskyProfile, RoomInfo, RoomItem } from '$lib/types';

  const reader = useReaderStack();

  // --- room state ---
  let uri = $state<string | null>(null);
  let room = $state<RoomInfo | null>(null);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let joined = $state(false);
  let joinBusy = $state(false);
  let members = $state<BlueskyProfile[]>([]);
  let memberCount = $state(0);
  let openingUrl = $state<string | null>(null);
  let collectionLink = $state<CollectionPageLink | null>(null);

  // --- index (no uri) state ---
  let myRooms = $state<Array<MyRoom & CollectionMeta & { link: CollectionPageLink | null }>>([]);
  let myRoomsLoading = $state(false);
  let pasteInput = $state('');
  let pasteError = $state<string | null>(null);
  let pasteBusy = $state(false);

  // Dispatch a load whenever the room (?uri=) or the session (did) changes.
  // Keyed by both, as a plain signature rather than a bare `next === uri` guard:
  // that guard swallowed the initial mount of the index (both null, so a direct
  // /rooms landing never listed your rooms), and a hard load can run this
  // before auth hydrates, so the did re-dispatches once the session arrives.
  // The reader's shallow ?read= rewrites change neither, so opening an article
  // still never re-triggers a load. Leaving a room view (to the index, another
  // room, or away entirely) refreshes Home's cached copy — this page is where
  // joins, leaves and new collection articles happen, so its exit is the cheap
  // moment to re-sync the session cache.
  let dispatched: string | null = null;
  $effect(() => {
    const next = page.url.searchParams.get('uri');
    const sig = `${auth.user?.did ?? ''}|${next ?? ''}`;
    if (sig === dispatched) return;
    dispatched = sig;
    if (uri && next !== uri) void roomsStore.refresh();
    uri = next;
    if (uri) {
      void loadRoom(uri);
    } else {
      void loadMyRooms();
    }
  });

  onDestroy(() => {
    if (uri) void roomsStore.refresh();
  });

  async function loadRoom(target: string) {
    loading = true;
    loadError = null;
    room = null;
    members = [];
    memberCount = 0;
    collectionLink = null;
    const [roomResult, joinedResult] = await Promise.allSettled([
      api.getRoom(target),
      api.getRoomJoined(target),
    ]);
    if (target !== uri) return;
    if (roomResult.status === 'fulfilled') {
      room = roomResult.value;
    } else {
      loadError = 'Could not load this room.';
    }
    joined = joinedResult.status === 'fulfilled' && joinedResult.value.joined;
    loading = false;
    void loadMembers(target);
    void loadCollectionLink(target);
  }

  // The collection's own page on its provider. Building it needs the owner's
  // handle, so it lands a beat after the room and is simply absent when the
  // handle (or the provider's page) doesn't resolve.
  async function loadCollectionLink(target: string) {
    const owner = collectionOwnerDid(target);
    if (!owner) return;
    const profile = await profileService.getProfile(owner);
    if (target !== uri) return;
    collectionLink = collectionPageLink(target, profile?.handle);
  }

  async function loadMembers(target: string) {
    const dids = await fetchRoomMembers(target);
    if (target !== uri) return;
    memberCount = dids.length;
    const profiles = await profileService.getProfiles(dids.slice(0, 12));
    if (target !== uri) return;
    members = dids.slice(0, 12).flatMap((did) => {
      const p = profiles.get(did);
      return p ? [p] : [];
    });
  }

  async function join() {
    if (!uri || joinBusy) return;
    joinBusy = true;
    try {
      await api.joinRoom(uri, generateTid());
      joined = true;
      // Constellation lags a fresh write; show yourself right away.
      if (auth.user && !members.some((m) => m.did === auth.user!.did)) {
        memberCount += 1;
        members = [
          {
            did: auth.user.did,
            handle: auth.user.handle,
            displayName: auth.user.displayName,
            avatar: auth.user.avatarUrl,
          },
          ...members,
        ];
      }
    } catch {
      toastStore.update(toastStore.add('Could not join the room'), 'error');
    } finally {
      joinBusy = false;
    }
  }

  async function leave() {
    if (!uri || joinBusy) return;
    joinBusy = true;
    try {
      await api.leaveRoom(uri);
      joined = false;
      if (auth.user) {
        members = members.filter((m) => m.did !== auth.user!.did);
        memberCount = Math.max(0, memberCount - 1);
      }
    } catch {
      toastStore.update(toastStore.add('Could not leave the room'), 'error');
    } finally {
      joinBusy = false;
    }
  }

  // Open an article in the reader without saving it: extract the body and hand
  // the reader a synthetic SavedItem (rkey '' skips the store's lazy body
  // fetch). Opening does NOT count as a read — the reader's "Mark as read"
  // button (markRead below) is the user's explicit done signal.
  async function openArticle(item: RoomItem) {
    if (!uri || openingUrl) return;
    openingUrl = item.url;

    try {
      const saved = await extractRoomArticle(item);
      if (!saved) {
        window.open(item.url, '_blank', 'noopener');
        return;
      }
      reader.openReader({ type: 'saved', item: saved, key: item.url });
    } finally {
      openingUrl = null;
    }
  }

  // The room item behind the currently open reader, if the reader was opened
  // from this room (its key is the article URL).
  const openRoomItem = $derived.by(() => {
    const key = reader.readerItem?.key;
    if (!key || !room) return null;
    return room.items.find((i) => i.url === key) ?? null;
  });

  // The explicit "I'm done" signal. Optimistic; reverts on failure.
  async function markRead(item: RoomItem) {
    if (!uri || !room || item.readByMe) return;
    const apply = (readByMe: boolean, delta: number) => {
      if (!room) return;
      room = {
        ...room,
        items: room.items.map((i) =>
          i.urlNormalized === item.urlNormalized
            ? { ...i, readByMe, readCount: Math.max(0, i.readCount + delta) }
            : i
        ),
      };
    };
    apply(true, 1);
    try {
      await api.recordRoomRead(uri, item.url);
      // Keep Home's cached copy of this room honest without a refetch.
      roomsStore.noteReadElsewhere(uri, item.urlNormalized);
    } catch {
      apply(false, -1);
      toastStore.update(toastStore.add('Could not mark as read'), 'error');
    }
  }

  async function loadMyRooms() {
    if (!auth.user) return;
    myRoomsLoading = true;
    const rooms = await fetchMyRooms(auth.user.did, auth.user.pdsUrl);
    // One batched profile lookup for every owner, rather than one per row: the
    // provider page is keyed by their handle.
    const owners = await profileService.getProfiles([
      ...new Set(rooms.map((r) => collectionOwnerDid(r.subject)).filter((d) => d !== null)),
    ]);
    const named = await Promise.all(
      rooms.map(async (r) => ({
        ...r,
        ...(await fetchCollectionMeta(r.subject)),
        link: collectionPageLink(
          r.subject,
          owners.get(collectionOwnerDid(r.subject) ?? '')?.handle
        ),
      }))
    );
    if (!uri) myRooms = named;
    myRoomsLoading = false;
  }

  async function openPasted() {
    if (pasteBusy) return;
    pasteBusy = true;
    // A semble.so collection page needs a handle -> DID resolution, so this is async.
    const parsed = await resolveRoomInput(pasteInput);
    pasteBusy = false;
    if (!parsed) {
      pasteError = 'That does not look like a room link.';
      return;
    }
    pasteError = null;
    pasteInput = '';
    void goto(`/rooms?uri=${encodeURIComponent(parsed)}`);
  }

  function safeDomain(url: string): string | null {
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  }

  function readLabel(item: RoomItem): string | null {
    if (item.readByMe && item.readCount === 1) return 'You read this';
    if (item.readByMe) return `You and ${item.readCount - 1} more read this here`;
    if (item.readCount === 1) return '1 read this here';
    if (item.readCount > 1) return `${item.readCount} read this here`;
    return null;
  }

  const readingAlongLabel = $derived(
    memberCount === 1 ? '1 reading along' : `${memberCount} reading along`
  );

  // Unread first; within each group, the collection's own order (stable sort).
  // This re-sorts live when markRead flips an item, so what's left to read
  // stays at the top.
  const sortedItems = $derived(
    room ? [...room.items].sort((a, b) => Number(a.readByMe) - Number(b.readByMe)) : []
  );

  const roomKeys = $derived(new Set((room?.items ?? []).map((i) => i.urlNormalized)));

  // A fresh add is shown right away rather than waiting for a refetch: the
  // membership record lands in the adder's own repo, and the room list finds
  // other people's records through Constellation, which lags a write by seconds.
  function noteAdded(item: RoomItem) {
    if (!room || room.items.some((i) => i.urlNormalized === item.urlNormalized)) return;
    room = { ...room, items: [item, ...room.items] };
  }
</script>

{#if uri}
  <div class="room">
    <!-- Always rendered, error state included: a room reached by link is often
         the first Skyreader page a visitor sees, so the way back to their own
         rooms cannot depend on the room loading. -->
    <a class="room-back" href="/rooms">
      <Icon name="arrow-left" size={14} />
      All rooms
    </a>
    {#if loading}
      <p class="room-quiet">Loading room…</p>
    {:else if loadError}
      <p class="room-quiet" role="alert">{loadError}</p>
    {:else if room}
      <header class="room-header">
        <h1 class="room-title">{room.name ?? 'Reading room'}</h1>
        {#if room.description}
          <p class="room-description">{room.description}</p>
        {/if}

        <div class="room-presence">
          {#if members.length > 0}
            <div class="room-avatars">
              {#each members.slice(0, 8) as member (member.did)}
                <a
                  class="room-avatar"
                  href={`https://linkblogs.skyreader.app/${member.handle}/`}
                  target="_blank"
                  rel="noopener"
                  title={member.displayName || member.handle}
                >
                  {#if member.avatar}
                    <img src={member.avatar} alt={member.handle} />
                  {:else}
                    <span class="room-avatar-fallback">
                      {(member.displayName || member.handle).slice(0, 1).toUpperCase()}
                    </span>
                  {/if}
                </a>
              {/each}
            </div>
          {/if}
          {#if memberCount > 0}
            <span class="room-presence-count">{readingAlongLabel}</span>
          {/if}

          {#if joined}
            <button class="btn room-leave" onclick={leave} disabled={joinBusy}>
              {joinBusy ? 'Leaving…' : 'Leave room'}
            </button>
          {:else}
            <button class="btn btn-primary" onclick={join} disabled={joinBusy}>
              {joinBusy ? 'Joining…' : 'Join room'}
            </button>
          {/if}
        </div>
        {#if collectionLink}
          <a class="room-source" href={collectionLink.url} target="_blank" rel="noopener">
            <Icon name="external-link" size={13} />
            View collection on {collectionLink.provider}
          </a>
        {/if}
        {#if !joined}
          <p class="room-consent">
            Joining is public. Anyone can see you're reading along. What you read here shows up only
            as a count.
          </p>
        {/if}
        {#if !room.complete}
          <p class="room-quiet">Some articles could not be loaded. This list may be short.</p>
        {/if}
      </header>

      {#if room.canAdd}
        <RoomAddBox collectionUri={room.uri} existingKeys={roomKeys} onAdded={noteAdded} />
      {/if}

      {#if room.items.length === 0}
        <p class="room-quiet">Nothing here yet.</p>
      {:else}
        <ul class="room-list">
          {#each sortedItems as item (item.urlNormalized)}
            <li>
              <button
                class="room-item"
                onclick={() => openArticle(item)}
                disabled={openingUrl !== null}
              >
                <span class="room-item-main">
                  <span class="room-item-title">
                    {item.title ?? item.url}
                    {#if openingUrl === item.url}
                      <span class="room-item-opening">Opening…</span>
                    {/if}
                  </span>
                  {#if item.description}
                    <span class="room-item-description">{item.description}</span>
                  {/if}
                  <span class="room-item-meta">
                    {#if item.author}{item.author} ·
                    {/if}{safeDomain(item.url)}
                  </span>
                </span>
                {#if readLabel(item)}
                  <span class="room-item-reads" class:read-by-me={item.readByMe}>
                    {readLabel(item)}
                  </span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </div>
{:else}
  <div class="room">
    <header class="room-header">
      <h1 class="room-title">Reading rooms</h1>
      <p class="room-description">
        A room is a set of articles people read together. Rooms live on shared collections. Open one
        from a link, or paste the link here.
      </p>
    </header>

    <form
      class="room-paste"
      onsubmit={(e) => {
        e.preventDefault();
        openPasted();
      }}
    >
      <input
        class="room-paste-input"
        type="text"
        placeholder="Paste a room or collection link"
        bind:value={pasteInput}
      />
      <button class="btn btn-primary" type="submit" disabled={pasteBusy}>
        {pasteBusy ? 'Opening…' : 'Open'}
      </button>
    </form>
    {#if pasteError}
      <p class="room-error" role="alert">{pasteError}</p>
    {/if}

    {#if myRoomsLoading}
      <p class="room-quiet">Loading your rooms…</p>
    {:else if myRooms.length > 0}
      <h2 class="room-section-title">Your rooms</h2>
      <ul class="room-list">
        {#each myRooms as r (r.recordUri)}
          <li class="room-row">
            <a
              class="room-item room-item-link"
              href={`/rooms?uri=${encodeURIComponent(r.subject)}`}
            >
              <span class="room-item-main">
                <span class="room-item-title">{r.name ?? 'Untitled room'}</span>
                {#if r.description}
                  <span class="room-item-description">{r.description}</span>
                {/if}
              </span>
              <Icon name="chevron-right" size={16} />
            </a>
            {#if r.link}
              <a
                class="room-row-source"
                href={r.link.url}
                target="_blank"
                rel="noopener"
                title={`View collection on ${r.link.provider}`}
                aria-label={`View collection on ${r.link.provider}`}
              >
                <Icon name="external-link" size={14} />
              </a>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

{#if reader.readerItem}
  <SavedReader
    readerItem={reader.readerItem}
    onClose={reader.closeReader}
    onMarkRead={openRoomItem ? () => markRead(openRoomItem) : undefined}
    markedRead={openRoomItem?.readByMe ?? false}
  />
{/if}

<style>
  .room {
    max-width: 42rem;
    margin: 0 auto;
    padding: 2rem 1.25rem 4rem;
  }

  .room-back {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    margin-bottom: 1rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    text-decoration: none;
  }

  .room-back:hover {
    color: var(--color-primary);
  }

  .room-header {
    margin-bottom: 1.5rem;
  }

  .room-title {
    font-size: var(--text-3xl);
    font-weight: 600;
    line-height: var(--leading-tight, 1.25);
    letter-spacing: -0.01em;
    margin: 0 0 0.375rem;
  }

  .room-description {
    color: var(--color-text-secondary);
    margin: 0 0 1rem;
  }

  .room-presence {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .room-avatars {
    display: flex;
  }

  .room-avatar {
    display: block;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    overflow: hidden;
    border: 2px solid var(--color-bg);
    background: var(--color-bg-secondary);
    margin-left: -8px;
  }

  .room-avatar:first-child {
    margin-left: 0;
  }

  .room-avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .room-avatar-fallback {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .room-presence-count {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .room-source {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    margin-top: 0.75rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    text-decoration: none;
  }

  .room-source:hover {
    color: var(--color-primary);
  }

  .room-consent {
    margin-top: 0.75rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .room-leave {
    background: transparent;
    border: 1px solid var(--color-border);
    color: var(--color-text-secondary);
  }

  .room-paste {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
  }

  .room-paste-input {
    flex: 1;
    min-width: 0;
    padding: 0.5rem 0.75rem;
    font-size: var(--text-md);
    color: var(--color-text);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 6px;
  }

  .room-paste-input:focus {
    outline: none;
    border-color: var(--color-primary);
  }

  .room-quiet {
    color: var(--color-text-secondary);
    font-size: var(--text-md);
  }

  .room-error {
    color: var(--color-error);
    font-size: var(--text-sm);
    margin-top: 0.5rem;
  }

  .room-section-title {
    font-size: var(--text-lg);
    font-weight: 600;
    margin: 2rem 0 0.5rem;
  }

  .room-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .room-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    width: 100%;
    text-align: left;
    padding: 0.875rem 0;
    background: none;
    border: none;
    border-bottom: 1px solid var(--color-border);
    cursor: pointer;
    color: inherit;
    font: inherit;
  }

  .room-item:hover .room-item-title {
    color: var(--color-primary);
  }

  .room-item:disabled {
    cursor: default;
    opacity: 0.7;
  }

  .room-item-link {
    text-decoration: none;
  }

  /* Index rows carry a second link out to the collection's own page, so the
     row's rule moves to the <li> and spans both. */
  .room-row {
    display: flex;
    align-items: stretch;
    border-bottom: 1px solid var(--color-border);
  }

  .room-row .room-item {
    flex: 1;
    min-width: 0;
    border-bottom: none;
  }

  .room-row-source {
    display: flex;
    align-items: center;
    padding: 0 0.625rem;
    margin-left: 0.25rem;
    color: var(--color-text-secondary);
    border-radius: 6px;
  }

  .room-row-source:hover {
    color: var(--color-primary);
  }

  .room-item-main {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }

  .room-item-title {
    font-size: var(--text-base);
    font-weight: 500;
    line-height: 1.35;
  }

  .room-item-opening {
    font-size: var(--text-sm);
    font-weight: 400;
    color: var(--color-text-secondary);
    margin-left: 0.5rem;
  }

  .room-item-description {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .room-item-meta {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .room-item-reads {
    flex-shrink: 0;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    white-space: nowrap;
  }

  .room-item-reads.read-by-me {
    color: var(--color-primary);
  }
</style>
