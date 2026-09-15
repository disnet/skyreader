<script lang="ts">
  // Harness for RoomCover — the square that fronts every rooms row.
  //
  // What's worth looking at here is the degradation, because cover art is the
  // least reliable thing on the rooms surfaces: a room is a foreign collection,
  // so its articles carry whatever metadata some other app wrote, and a cover URL
  // that resolved last month can 404 today. The cases below walk every rung of
  // covers → favicon → letter mark → icon, including an image that fails after
  // the row has already painted.
  //
  // Covers are inline SVG data URIs so the canvas is deterministic and works
  // offline; the real thing is loading remote article images.
  import RoomCover from '$lib/components/rooms/RoomCover.svelte';
  import RoomCombo, { type ComboRow } from '$lib/components/rooms/RoomCombo.svelte';
  import Showcase from '../_harness/Showcase.svelte';
  import Case from '../_harness/Case.svelte';

  const swatch = (bg: string, fg: string, glyph: string) =>
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120">` +
        `<rect width="120" height="120" fill="${bg}"/>` +
        `<text x="60" y="78" font-family="Georgia,serif" font-size="56" fill="${fg}" text-anchor="middle">${glyph}</text>` +
        `</svg>`
    );

  const COVERS = [
    swatch('#1f2933', '#f5f7fa', '¶'),
    swatch('#7b341e', '#fff5f0', '§'),
    swatch('#2c5282', '#ebf4ff', '†'),
    swatch('#276749', '#f0fff4', '‡'),
  ];

  const BROKEN = 'https://example.invalid/cover-that-will-not-load.jpg';
  const FAVICON = swatch('#e2e8f0', '#4a5568', '◆');

  // --- RoomCombo -----------------------------------------------------------
  // Both rooms fields are one component now; these two cases are the only two
  // shapes it takes, side by side, which is the point. Click into a field to
  // raise its panel.
  const OPEN_ROWS: ComboRow[] = [
    {
      key: 'a',
      icon: 'semble',
      title: 'Tools for Thought',
      meta: 'Semble · Notation, memory, and the machines that hold them',
    },
    { key: 'b', icon: 'semble', title: 'The Open Web', meta: 'Semble', note: 'Joined' },
    { key: 'c', icon: 'margin', title: 'Close reading', meta: 'Margin' },
  ];

  const ADD_ROWS: ComboRow[] = [
    { key: 'x', icon: 'link', title: 'Add this link', meta: 'example.com/an-essay' },
    { key: 'y', icon: 'bookmark', title: 'The Garden and the Stream', meta: 'hapgood.us' },
    {
      key: 'z',
      icon: 'bookmark',
      title: 'As We May Think',
      meta: 'theatlantic.com',
      note: 'Already here',
      disabled: true,
    },
  ];

  let openQuery = $state('');
  let addQuery = $state('');
</script>

<Showcase
  title="Rooms"
  description="The two pieces the rooms surfaces are built from: the search-and-pick field both of them use, and the thumbnail on every row — trailing and top-aligned on an article, leading and centred on a room. Article rows pass one cover and a favicon; room rows pass up to four covers and the room's name."
>
  <Case name="Article row — cover" note="One image fills the square.">
    <div class="row"><RoomCover images={[COVERS[0]]} faviconUrl={FAVICON} /></div>
  </Case>

  <Case name="Article row — no cover" note="Falls back to the site's own mark.">
    <div class="row"><RoomCover images={[]} faviconUrl={FAVICON} /></div>
  </Case>

  <Case
    name="Article row — cover 404s"
    note="Should settle on the favicon, not a broken-image box."
  >
    <div class="row"><RoomCover images={[BROKEN]} faviconUrl={FAVICON} /></div>
  </Case>

  <Case name="Article row — nothing at all" note="No cover, no favicon: the generic mark.">
    <div class="row"><RoomCover images={[]} /></div>
  </Case>

  <Case name="Room row — one, two, three, four covers" note="The mosaic holds one fixed square.">
    <div class="row">
      {#each [1, 2, 3, 4] as n (n)}
        <RoomCover images={COVERS.slice(0, n)} label="Tools for Thought" />
      {/each}
    </div>
  </Case>

  <Case
    name="Room row — duplicate covers"
    note="A collection can carry the same image on several articles; four copies of one picture is worse than one."
  >
    <div class="row">
      <RoomCover images={[COVERS[0], COVERS[0], COVERS[0]]} label="The Craft" />
    </div>
  </Case>

  <Case
    name="Room row — no covers yet"
    note="A room we hold no snapshot for shows its letter until it's opened once."
  >
    <div class="row">
      <RoomCover images={[]} label="How We Read Now" />
      <RoomCover images={[]} label="The Open Web" />
      <RoomCover images={[]} label="Untitled room" />
    </div>
  </Case>

  <Case
    name="Combo — the room opener"
    note="Trailing action button. Click the field to raise the panel."
    minHeight="20rem"
    pad
  >
    <RoomCombo
      bind:value={openQuery}
      placeholder="Paste a Semble or Margin collection link, or pick one of your collections"
      icon="search"
      idPrefix="harness-open"
      rows={OPEN_ROWS}
      hint="2 more. Keep typing to narrow."
      action={{ label: 'Open', busyLabel: 'Opening…' }}
      onChoose={() => {}}
    />
  </Case>

  <Case
    name="Combo — the article adder"
    note="Same field and panel, no action button: choosing a row IS the action."
    minHeight="20rem"
    pad
  >
    <RoomCombo
      bind:value={addQuery}
      placeholder="Add an article: paste a link, or search your library"
      icon="plus"
      idPrefix="harness-add"
      rows={ADD_ROWS}
      busyLabel="Adding…"
      onChoose={() => {}}
    />
  </Case>

  <Case name="Phone size" note="The rows drop to 3.25rem under 640px.">
    <div class="row small">
      <RoomCover images={[COVERS[0]]} faviconUrl={FAVICON} />
      <RoomCover images={COVERS} label="Tools for Thought" />
      <RoomCover images={[]} label="The Open Web" />
    </div>
  </Case>
</Showcase>

<style>
  /* The rooms rows set --room-cover themselves; mirror that here rather than
     letting the cases show the component's standalone default. */
  .row {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.875rem;
    --room-cover: 4rem;
  }

  .row.small {
    --room-cover: 3.25rem;
  }
</style>
