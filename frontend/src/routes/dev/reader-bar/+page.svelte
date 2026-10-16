<script lang="ts">
  // Harness for the desktop reader bar: the real SavedReader over a saved
  // webpage, so the bar's save-dependent controls (Add to Shelf, which shows
  // only when it fits beside the title slot) can be seen and clicked.
  //
  // The bar follows the window (its label breakpoints are viewport media
  // queries), so resize the window to watch Add to Shelf come and go. The app's
  // CSP forbids framing, so there's no side-by-side gallery. ?actions=all crowds
  // the bar: Archive, Mark read and a signed-in user (Share, Recommend,
  // Semble/Margin); ?shelf=1 opens with the save already on the Shelf.
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import SavedReader from '$lib/components/feed/SavedReader.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { shelfStore } from '$lib/stores/shelf.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { db } from '$lib/services/db';
  import type { FeedDisplayItem } from '$lib/stores/feedView.svelte';
  import type { SavedItem } from '$lib/types';

  const allActions = page.url.searchParams.get('actions') === 'all';
  const startOnShelf = page.url.searchParams.get('shelf') === '1';

  // A fresh save per load, so two open tabs never share (or delete) one row.
  const RKEY = `devharnessreaderbar${Math.random().toString(36).slice(2, 10)}`;
  const URI = `at://did:plc:devharness/app.skyreader.feed.saved/${RKEY}`;

  const paragraphs = [
    'A reading app earns its chrome the way a room earns its furniture: by what it lets you forget. The bar along the top is the whole of it, and it should leave the words the room they need.',
    'Some saves are for now and some are for keeps. The Shelf is where the keepers go: the reference half of Saved, a view over the same pile rather than a second one.',
    'So the bar offers to keep a piece on the Shelf when there is room to say so plainly, and tucks the offer into the menu when there is not. Either way it is one tap.',
  ];
  const content = Array.from({ length: 12 }, (_, i) => `<p>${paragraphs[i % 3]}</p>`).join('');

  const save: SavedItem = {
    rkey: RKEY,
    uri: URI,
    url: `https://example.com/essays/the-reading-room?harness=${RKEY}`,
    title: 'The Reading Room',
    author: 'A. Writer',
    description: 'Generated for the reader-bar harness.',
    content,
    contentType: 'webpage',
    domain: 'example.com',
    image: null,
    wordCount: 600,
    publishedAt: '2026-09-01T12:00:00Z',
    savedAt: '2026-09-20T12:00:00Z',
    source: 'url',
  };

  const readerItem = { type: 'saved', key: URI, item: save } as FeedDisplayItem;

  let ready = $state(false);
  let markedRead = $state(false);

  onMount(async () => {
    if (allActions) {
      auth.setUser({
        did: 'did:plc:devharness',
        handle: 'reader.example.com',
        displayName: 'Harness Reader',
        pdsUrl: 'https://pds.example.com',
      });
    }
    // The reader finds its save through savesStore, which only fills from
    // IndexedDB. Seed the row, load it (the backend half fails quietly with no
    // server), then drop the row again so it never lingers in this browser's
    // real Saved list. The in-memory copy is all the reader needs.
    await db.saved.put(save);
    await savesStore.load();
    await db.saved.delete(RKEY);
    const live = savesStore.find(save.url);
    if (live && shelfStore.isOnShelf(live) !== startOnShelf) {
      await shelfStore.setOnShelf(live, startOnShelf);
    }
    ready = true;
  });
</script>

{#if ready}
  <SavedReader
    {readerItem}
    onClose={() => {}}
    onToggleSave={() => {}}
    onArchive={allActions ? () => {} : undefined}
    onMarkRead={allActions ? () => (markedRead = true) : undefined}
    {markedRead}
  />
{/if}
