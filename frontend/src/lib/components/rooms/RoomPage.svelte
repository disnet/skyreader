<script lang="ts">
  // Reading Rooms (spike). A room IS a Semble/Margin collection: this page shows
  // the collection's articles (backend backing read path), who's reading along
  // (Constellation backlinks, client-side), and anonymous per-article read
  // counts scoped to reads made through this surface. Join writes one public
  // readAlong record to the joiner's own repo; that record is the consent
  // boundary that licenses showing their avatar here.
  //
  // Every list on this page is stale-while-revalidate: the room's articles, your
  // rooms, the featured rows and their presence counts all paint from the local
  // cache (services/roomCache.ts) and refresh behind the paint, so reopening a
  // room shows it immediately instead of spinning on a foreign collection read.
  // See docs/plans/READING_ROOMS_SPIKE.md.
  import { onDestroy } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import SavedReader from '$lib/components/feed/SavedReader.svelte';
  import StaticPageChrome from '$lib/components/feed/StaticPageChrome.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import RoomAddBox from './RoomAddBox.svelte';
  import RoomCover from './RoomCover.svelte';
  import RoomOpenBox from './RoomOpenBox.svelte';
  import { useReaderStack } from '$lib/hooks/useReaderStack.svelte';
  import { api } from '$lib/services/api';
  import { profileService } from '$lib/services/profiles';
  import {
    fetchRoomMembers,
    fetchRoomMemberCount,
    fetchMyRooms,
    fetchCollectionMeta,
    collectionOwnerDid,
    collectionPageLink,
    FEATURED_ROOM_URIS,
    type CollectionPageLink,
    type RoomListing,
  } from '$lib/services/rooms';
  import {
    roomCacheDid,
    readRoomSnapshot,
    readRoomSnapshots,
    writeRoomSnapshot,
    readMyRoomsCache,
    writeMyRoomsCache,
    readFeaturedCache,
    writeFeaturedCache,
    readPresenceCache,
    readRoomPresence,
    writeRoomPresence,
    PRESENCE_READER_CAP,
    type MyRoomListing,
  } from '$lib/services/roomCache';
  import type { FollowLite } from '$lib/services/socialGraph';
  import { auth } from '$lib/stores/auth.svelte';
  import { followingRoomsStore } from '$lib/stores/followingRooms.svelte';
  import { roomsStore } from '$lib/stores/rooms.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { generateTid } from '$lib/utils/tid';
  import { extractRoomArticle, sortRoomItems } from '$lib/utils/roomArticle';
  import { getFaviconUrl } from '$lib/utils/favicon';
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
  // What the local snapshot already holds for this room — see the persist
  // effect below.
  let written: { room: RoomInfo; joined: boolean } | null = null;

  // --- index (no uri) state ---
  let myRooms = $state<MyRoomListing[]>([]);
  let myRoomsLoading = $state(false);
  let featuredRooms = $state<RoomListing[]>([]);
  // Rooms found on the people you follow, described one by one as the scan
  // turns them up (subject -> listing; the store owns the subjects).
  let followRoomMeta = $state<Record<string, RoomListing>>({});
  // subject -> how many are reading along; null when the lookup failed. Filled
  // after the rows render, so a slow Constellation never holds up the list.
  let memberCounts = $state<Record<string, number | null>>({});

  // What a room is, said once. The chrome already names the page, so the only
  // thing the top of the index owes a first-time visitor is the explanation —
  // and once it has been read it is pure chrome over the lists, so it goes
  // away for good. Same idiom as GuestModeBanner; local by nature (a view
  // preference, not something worth a server round trip), and reading it can
  // throw outright in a locked-down private window.
  const INTRO_DISMISS_KEY = 'skyreader-rooms-intro-dismissed';

  function readIntroDismissed(): boolean {
    try {
      return localStorage.getItem(INTRO_DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  }

  let introDismissed = $state(readIntroDismissed());

  function dismissIntro() {
    introDismissed = true;
    try {
      localStorage.setItem(INTRO_DISMISS_KEY, '1');
    } catch {
      // Fine: it stays dismissed for this session and returns next time.
    }
  }

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
      void loadCachedPresence();
      void loadMyRooms();
      void loadFeatured();
      void followingRoomsStore.load();
    }
  });

  // Describe each room the follow scan turns up. The scan streams results in
  // over its lifetime, so this runs per batch rather than once; a subject is
  // always written back (even as an empty listing) so a room whose collection
  // record won't load is asked about once, not forever.
  const describing = new Set<string>();
  $effect(() => {
    if (uri) return;
    const missing = followingRoomsStore.rooms
      .map((r) => r.subject)
      .filter((s) => !(s in followRoomMeta) && !describing.has(s));
    if (missing.length === 0) return;
    missing.forEach((s) => describing.add(s));
    void describeFollowRooms(missing);
  });

  async function describeFollowRooms(subjects: string[]) {
    try {
      const listings = await describeRooms(subjects);
      if (uri) return;
      followRoomMeta = {
        ...followRoomMeta,
        ...Object.fromEntries(listings.map((l) => [l.subject, l])),
      };
      // No Constellation count for these rows: the people you follow ARE the
      // presence signal here, and a count per row would be one request each.
    } finally {
      subjects.forEach((s) => describing.delete(s));
    }
  }

  onDestroy(() => {
    if (uri) void roomsStore.refresh();
  });

  async function loadRoom(target: string) {
    loading = true;
    loadError = null;
    room = null;
    written = null;
    members = [];
    memberCount = 0;
    collectionLink = null;

    // The last copy of this room and of who was in it, painted before anything
    // is requested — together, in one tick, so the page arrives whole rather
    // than growing a presence line under the reader a moment later. Two disk
    // reads stand between the click and that; the refreshes below replace it
    // all in place.
    const [cached, presence] = await Promise.all([
      readRoomSnapshot(target, roomCacheDid(auth.user?.did)),
      readRoomPresence(target),
    ]);
    if (target !== uri) return;
    if (cached) {
      room = cached.room;
      joined = cached.joined;
      written = { room: cached.room, joined: cached.joined };
      loading = false;
    }
    if (presence) {
      memberCount = presence.total;
      members = presence.readers ?? [];
    }

    // Who's here and where the collection lives are their own lookups, not the
    // room's: start them now rather than behind the room read, which is the
    // slowest thing on the page and used to gate them both.
    void loadMembers(target);
    void loadCollectionLink(target);

    const [roomResult, joinedResult] = await Promise.allSettled([
      api.getRoom(target),
      api.getRoomJoined(target),
    ]);
    if (target !== uri) return;
    if (roomResult.status === 'fulfilled') {
      room = roomResult.value;
    } else if (!room) {
      // With a cached copy on screen there is nothing to tell the reader: the
      // room they asked for is right there, and the next visit tries again.
      loadError = 'Could not load this room.';
    }
    if (joinedResult.status === 'fulfilled') joined = joinedResult.value.joined;
    loading = false;
  }

  // Keep the snapshot in step with what's on screen — the refresh, a join or
  // leave, a mark-as-read, an article added here. Writing from an effect rather
  // than at each call site means no path can update the room and forget the
  // cache. Guests are cached too (under the anonymous owner): a room reached by
  // link is often a visitor's first page, and it should open fast the second
  // time as well. `written` is what the cache already holds, so opening a room
  // doesn't write its own snapshot straight back.
  $effect(() => {
    const current = room;
    const target = uri;
    const isJoined = joined;
    if (!current || !target || loading) return;
    if (written && written.room === current && written.joined === isJoined) return;
    written = { room: current, joined: isJoined };
    void writeRoomSnapshot(target, roomCacheDid(auth.user?.did), current, isJoined);
  });

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

  // Who's reading along, refreshed. loadRoom has already painted the last
  // reading; this replaces it once Constellation answers and the profiles for
  // the avatar row land.
  let membersPass = 0;
  async function loadMembers(target: string) {
    const pass = ++membersPass;
    const dids = await fetchRoomMembers(target);
    if (target !== uri || pass !== membersPass) return;
    // Null is an unreachable index, not an empty room — leave the cached row
    // and count as they were rather than emptying the room out.
    if (dids === null) return;
    memberCount = dids.length;

    const shown = dids.slice(0, PRESENCE_READER_CAP);
    const profiles = await profileService.getProfiles(shown);
    if (target !== uri || pass !== membersPass) return;
    const readers = shown.flatMap((did) => {
      const p = profiles.get(did);
      return p ? [p] : [];
    });
    // Nobody resolving in a room that has readers is an appview blip, not an
    // empty room: keep the row that's up and record the count alone.
    if (readers.length === 0 && dids.length > 0) {
      void writeRoomPresence({ [target]: { total: dids.length } });
      return;
    }
    members = readers;
    void writeRoomPresence({ [target]: { total: dids.length, readers } });
  }

  async function join() {
    if (!uri || joinBusy) return;
    joinBusy = true;
    try {
      await api.joinRoom(uri, generateTid());
      joined = true;
      // Constellation lags a fresh write; show yourself right away — and cache
      // that, so coming back before it catches up doesn't drop you again.
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
        void writeRoomPresence({ [uri]: { total: memberCount, readers: members } });
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
        void writeRoomPresence({ [uri]: { total: memberCount, readers: members } });
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

  // Display rows for a list of collection uris: name/description from each
  // collection's own record, plus the provider page link. One batched profile
  // lookup for every owner, rather than one per row: the provider page is keyed
  // by their handle.
  async function describeRooms(subjects: string[]): Promise<RoomListing[]> {
    const owners = await profileService.getProfiles([
      ...new Set(subjects.map(collectionOwnerDid).filter((d) => d !== null)),
    ]);
    return Promise.all(
      subjects.map(async (subject) => ({
        subject,
        ...(await fetchCollectionMeta(subject)),
        link: collectionPageLink(subject, owners.get(collectionOwnerDid(subject) ?? '')?.handle),
      }))
    );
  }

  // Your rooms: the cached list first, then the live one. Describing a room
  // costs a record fetch per collection plus a profile lookup, which is why the
  // described rows are what's cached, not just the subjects.
  async function loadMyRooms() {
    const user = auth.user;
    if (!user) return;
    myRoomsLoading = true;
    const cached = await readMyRoomsCache(user.did);
    if (uri) return;
    if (cached) {
      myRooms = cached;
      myRoomsLoading = false;
      void loadMemberCounts(cached.map((r) => r.subject));
    }

    const rooms = await fetchMyRooms(user.did, user.pdsUrl);
    // Null is a PDS that didn't answer, not an empty shelf — keep the cached
    // list rather than telling the reader they're in no rooms.
    if (rooms === null) {
      myRoomsLoading = false;
      return;
    }
    const listings = await describeRooms(rooms.map((r) => r.subject));
    const rows = rooms.map((r, i) => ({ ...r, ...listings[i] }));
    if (!uri) myRooms = rows;
    myRoomsLoading = false;
    void writeMyRoomsCache(user.did, rows);
    void loadMemberCounts(rooms.map((r) => r.subject));
  }

  async function loadFeatured() {
    const cached = await readFeaturedCache();
    if (!uri && cached?.length) {
      featuredRooms = cached;
      void loadMemberCounts(cached.map((l) => l.subject));
    }

    const listings = await describeRooms(FEATURED_ROOM_URIS);
    // A featured collection whose record can't be fetched has no name to show
    // and nothing behind its link; drop the row rather than render a husk.
    const shown = listings.filter((l) => l.name !== null);
    if (!uri) featuredRooms = shown;
    if (shown.length > 0) void writeFeaturedCache(shown);
    void loadMemberCounts(shown.map((l) => l.subject));
  }

  // One count per room, in parallel — the same presence signal the room page
  // shows, brought up to the index so a room reads as busy or quiet before you
  // open it. Deliberately not the DID list: nothing here draws avatars.
  //
  // Asked at most once per room per visit, tracked separately from the answers
  // so a count seeded from cache is still re-checked.
  const countAsked = new Set<string>();
  async function loadMemberCounts(subjects: string[]) {
    const wanted = subjects.filter((s) => !countAsked.has(s));
    if (wanted.length === 0) return;
    wanted.forEach((s) => countAsked.add(s));
    const readings: Record<string, { total: number | null }> = {};
    await Promise.all(
      wanted.map(async (subject) => {
        const count = await fetchRoomMemberCount(subject);
        readings[subject] = { total: count };
        // A failed lookup never overwrites a count we already have: an outage
        // should leave the marker as it was, not blank it.
        if (!uri && (count !== null || memberCounts[subject] === undefined)) {
          memberCounts[subject] = count;
        }
      })
    );
    if (!uri) void writeRoomPresence(readings);
  }

  // Seed the presence markers from cache before any of them are asked for, so
  // the rows don't pop a beat after they render.
  async function loadCachedPresence() {
    const cached = await readPresenceCache();
    if (uri) return;
    for (const [subject, presence] of Object.entries(cached)) {
      if (memberCounts[subject] === undefined) memberCounts[subject] = presence.total;
    }
  }

  // Rooms the people you follow are in: the store's subjects, joined to the
  // descriptions as they land. A room you're already in belongs under "Your
  // rooms", and one whose collection record won't load has no name to show, so
  // neither is listed here. Gated on the my-rooms load to avoid a
  // flash-then-vanish.
  const followRooms = $derived.by<Array<RoomListing & { readers: FollowLite[] }>>(() => {
    if (myRoomsLoading) return [];
    return followingRoomsStore.rooms.flatMap((r) => {
      if (myRooms.some((m) => m.subject === r.subject)) return [];
      const listing = followRoomMeta[r.subject];
      if (!listing?.name) return [];
      return [{ ...listing, readers: r.readers }];
    });
  });

  // The collections already listed above, so the open box can mark one it offers
  // as a room you're in rather than pretending it's somewhere new.
  const myRoomSubjects = $derived(new Set(myRooms.map((r) => r.subject)));

  // Featured is a suggestion list, so rooms you're already in don't repeat
  // here, and neither do rooms your own follows are already in: that section
  // says the same thing with better evidence. Gated on the my-rooms load
  // finishing to avoid a flash-then-vanish.
  const suggestedRooms = $derived(
    myRoomsLoading
      ? []
      : featuredRooms.filter(
          (f) =>
            !myRooms.some((r) => r.subject === f.subject) &&
            !followRooms.some((r) => r.subject === f.subject)
        )
  );

  // Cover art for the index rows: the first few article images of each room,
  // tiled into its thumbnail so a room row shows what's in it rather than only
  // what it's called. Read straight off the local snapshots and nowhere else —
  // the index deliberately describes rooms from their collection records
  // (fetchCollectionMeta) instead of walking their contents, and decoration is
  // not a reason to start. A room we hold no snapshot for shows its letter mark,
  // and picks up covers the first time it's opened.
  let roomCovers = $state<Record<string, string[]>>({});

  const indexSubjects = $derived([
    ...myRooms.map((r) => r.subject),
    ...followRooms.map((r) => r.subject),
    ...suggestedRooms.map((r) => r.subject),
  ]);

  // The follow scan streams its rooms in over its lifetime, so the subject list
  // is rebuilt many times on the way to settling; only a list that actually
  // gained a room is worth another pass over the snapshots.
  let coveredFor: string | null = null;
  $effect(() => {
    if (uri) return;
    const subjects = indexSubjects;
    const sig = subjects.join('\n');
    if (subjects.length === 0 || sig === coveredFor) return;
    coveredFor = sig;
    void loadRoomCovers(subjects, roomCacheDid(auth.user?.did));
  });

  async function loadRoomCovers(subjects: string[], did: string): Promise<void> {
    const snapshots = await readRoomSnapshots(subjects, did);
    if (uri) return;
    const next: Record<string, string[]> = {};
    for (const subject of subjects) {
      const items = snapshots.get(subject)?.room.items;
      if (!items) continue;
      // The room page's own order, so a row's mosaic is the top of the list you
      // land on rather than an unrelated four.
      const covers = sortRoomItems(items)
        .map((i) => i.image)
        .filter((src): src is string => Boolean(src))
        .slice(0, 4);
      if (covers.length > 0) next[subject] = covers;
    }
    roomCovers = next;
  }

  /** Who you follow is in this room, as a name list: at most two, then a count.
   *  The avatars carry the rest. */
  function readersLabel(readers: FollowLite[]): string {
    const name = (r: FollowLite) => r.displayName?.trim() || r.handle || 'Someone';
    if (readers.length === 1) return `${name(readers[0])} is reading along`;
    if (readers.length === 2) {
      return `${name(readers[0])} and ${name(readers[1])} are reading along`;
    }
    return `${name(readers[0])} and ${readers.length - 1} others are reading along`;
  }

  function openRoom(target: string) {
    void goto(`/rooms?uri=${encodeURIComponent(target)}`);
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
    if (item.readByMe) return `You and ${item.readCount - 1} more read this`;
    if (item.readCount === 1) return '1 read this';
    if (item.readCount > 1) return `${item.readCount} read this`;
    return null;
  }

  function presenceLabel(count: number): string {
    return count === 1 ? '1 reading along' : `${count} reading along`;
  }

  const readingAlongLabel = $derived(presenceLabel(memberCount));

  // The index row's presence marker. Absent until the count lands, absent on a
  // failed lookup, and absent for an empty room — a row that says nothing reads
  // better than one that says "0". A room you've joined counts at least you,
  // even while Constellation still lags your own join record.
  function rowPresence(subject: string, mine: boolean): string | null {
    const count = memberCounts[subject];
    if (count === undefined || count === null) return null;
    const shown = mine ? Math.max(count, 1) : count;
    return shown > 0 ? presenceLabel(shown) : null;
  }

  // Unread first, oldest addition first within each group (see sortRoomItems).
  // This re-sorts live when markRead flips an item, so what's left to read
  // stays at the top.
  const sortedItems = $derived(room ? sortRoomItems(room.items) : []);

  const roomKeys = $derived(new Set((room?.items ?? []).map((i) => i.urlNormalized)));

  // A fresh add is shown right away rather than waiting for a refetch: the
  // membership record lands in the adder's own repo, and the room list finds
  // other people's records through Constellation, which lags a write by seconds.
  // It goes to the END of the unread pile, where its addedAt puts it — the list
  // is the order the room was built in, and the newest addition is the newest
  // addition even when it's yours. RoomAddBox says so with a toast, since the
  // row itself may land below the fold.
  function noteAdded(item: RoomItem) {
    if (!room || room.items.some((i) => i.urlNormalized === item.urlNormalized)) return;
    room = { ...room, items: [...room.items, item] };
  }
</script>

<!-- On mobile the bottom bar's switcher is the only in-app way off a page (an
     installed PWA has no back button), and Rooms is one of its destinations, so
     this page has to carry the chrome or it's a trap. A signed-out visitor
     arriving on a shared room link gets no app chrome — same stance as
     /supporter — and the room's own "All rooms" link is rendered outside the
     load branches for exactly that reader. -->
{#if auth.isInApp}
  <StaticPageChrome title="Rooms" readerOpen={reader.readerItem !== null} />
{/if}

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
                <RoomCover images={[item.image]} faviconUrl={getFaviconUrl(item.url)} />
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </div>
{:else}
  <div class="room">
    {#if !introDismissed}
      <aside class="room-intro">
        <button
          class="room-intro-dismiss"
          onclick={dismissIntro}
          title="Dismiss"
          aria-label="Dismiss"
        >
          <Icon name="x" size={14} />
        </button>
        <h2>Public Reading Rooms</h2>
        <p>
          A room is a set of articles people read together in public.
          Rooms live on shared semble collections. Open
          one of your own collections, paste a link, or start with a featured room.
          The rooms you join and articles you read in a room is public.
        </p>
      </aside>
    {/if}

    <RoomOpenBox joinedSubjects={myRoomSubjects} onOpen={openRoom} />

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
              <RoomCover images={roomCovers[r.subject] ?? []} label={r.name} />
              <span class="room-item-main">
                <span class="room-item-title">{r.name ?? 'Untitled room'}</span>
                {#if r.description}
                  <span class="room-item-description">{r.description}</span>
                {/if}
              </span>
              {#if rowPresence(r.subject, true)}
                <span class="room-row-presence">{rowPresence(r.subject, true)}</span>
              {/if}
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

    {#if followRooms.length > 0}
      <h2 class="room-section-title">Where people you follow are reading</h2>
      <ul class="room-list">
        {#each followRooms as r (r.subject)}
          <li class="room-row">
            <a
              class="room-item room-item-link"
              href={`/rooms?uri=${encodeURIComponent(r.subject)}`}
            >
              <RoomCover images={roomCovers[r.subject] ?? []} label={r.name} />
              <span class="room-item-main">
                <span class="room-item-title">{r.name}</span>
                {#if r.description}
                  <span class="room-item-description">{r.description}</span>
                {/if}
                <span class="room-row-readers">
                  <span class="room-avatars">
                    {#each r.readers.slice(0, 5) as reader (reader.did)}
                      <span class="room-avatar room-avatar-sm" title={reader.handle ?? reader.did}>
                        {#if reader.avatar}
                          <img src={reader.avatar} alt="" />
                        {:else}
                          <span class="room-avatar-fallback">
                            {(reader.displayName || reader.handle || '?').slice(0, 1).toUpperCase()}
                          </span>
                        {/if}
                      </span>
                    {/each}
                  </span>
                  {readersLabel(r.readers)}
                </span>
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
    {:else if followingRoomsStore.scanning && auth.user}
      <h2 class="room-section-title">Where people you follow are reading</h2>
      <p class="room-quiet">Looking through the people you follow.</p>
    {/if}

    {#if suggestedRooms.length > 0}
      <h2 class="room-section-title">Featured rooms</h2>
      <ul class="room-list">
        {#each suggestedRooms as r (r.subject)}
          <li class="room-row">
            <a
              class="room-item room-item-link"
              href={`/rooms?uri=${encodeURIComponent(r.subject)}`}
            >
              <RoomCover images={roomCovers[r.subject] ?? []} label={r.name} />
              <span class="room-item-main">
                <span class="room-item-title">{r.name}</span>
                {#if r.description}
                  <span class="room-item-description">{r.description}</span>
                {/if}
              </span>
              {#if rowPresence(r.subject, false)}
                <span class="room-row-presence">{rowPresence(r.subject, false)}</span>
              {/if}
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

  /* Clear the mobile bottom bar, which this page now carries. */
  @media (max-width: 1000px) {
    .room {
      padding-top: 1rem;
      padding-bottom: calc(var(--bottom-bar-height) + var(--safe-area-bottom) + 4rem);
    }
  }

  @media (max-width: 640px) {
    .room-item {
      gap: 0.75rem;
      --room-cover: 3.25rem;
    }
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

  /* The index's explainer, in place of a page title the chrome already carries.
     Flat by default (DESIGN.md): a bordered block in the flow, not floating,
     so it earns no shadow. */
  .room-intro {
    position: relative;
    margin-bottom: 1.25rem;
    padding: 0.875rem 1rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }

  .room-intro h2 {
    margin: 0 0 0.375rem;
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    line-height: var(--leading-snug);
  }

  .room-intro p {
    /* Keep the last line clear of the dismiss control. */
    padding-right: 1.5rem;
    margin: 0;
    font-size: var(--text-md);
    line-height: 1.5;
    color: var(--color-text-secondary);
  }

  .room-intro-dismiss {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.25rem;
    border: none;
    background: none;
    border-radius: 4px;
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  /* The box already sits on Sunken, so the hover fill steps one further in
     rather than washing the same tone again. */
  .room-intro-dismiss:hover {
    background: var(--color-border);
    color: var(--color-text);
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

  .room-quiet {
    color: var(--color-text-secondary);
    font-size: var(--text-md);
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
    /* Article rows read top-down: the title, its marker and its cover all start
       on the same line, so a row with a two-line description doesn't float its
       thumbnail in the middle of nowhere. Index rows override this below. */
    align-items: flex-start;
    /* The text takes the slack; the marker and the cover ride the right edge. */
    gap: 0.875rem;
    width: 100%;
    text-align: left;
    padding: 0.875rem 0;
    background: none;
    border: none;
    border-bottom: 1px solid var(--color-border);
    cursor: pointer;
    color: inherit;
    font: inherit;
    /* Bigger than a Home lane tile's thumb: a lane tile is one of a scrolling
       row of many, where these are the only picture on a full-width row — and a
       room's mosaic needs the room to read four covers at once. */
    --room-cover: 4rem;
  }

  .room-item:hover .room-item-title {
    color: var(--color-primary);
  }

  .room-item:disabled {
    cursor: default;
    opacity: 0.7;
  }

  /* Index rows put the cover first and centre it: the room's mosaic is the row's
     leading mark, not an illustration hung off the end of its title. Must stay
     after the .room-item block — same specificity, source order decides. */
  .room-item-link {
    text-decoration: none;
    align-items: center;
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

  /* Pulled to the right so it sits with the chevron rather than floating in the
     middle of the row (the row is space-between). */
  .room-row-presence {
    flex-shrink: 0;
    margin-left: auto;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    white-space: nowrap;
  }

  /* Who you follow is in this room: small stacked avatars, then the names. */
  .room-row-readers {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.125rem;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .room-avatar-sm {
    width: 20px;
    height: 20px;
    border-width: 1.5px;
    margin-left: -6px;
  }

  .room-item-main {
    display: flex;
    flex: 1;
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
    margin-left: auto;
    /* Nudged down to sit on the title's first line rather than flush with the
       top of its box — the label is several points smaller than the title. */
    padding: 0.2rem 0 0 0.5rem;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    white-space: nowrap;
  }

  .room-item-reads.read-by-me {
    color: var(--color-primary);
  }
</style>
