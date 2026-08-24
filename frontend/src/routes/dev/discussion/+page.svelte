<script lang="ts">
  // Harness for the discussion surface — the merged Atmosphere stream that sits
  // under a finished article (and inside the feed card's footer). AtmospherePanel
  // is purely presentational, so every state here is plain data: no auth, no
  // backend (see ../+layout.ts).
  import AtmospherePanel from '$lib/components/feed/AtmospherePanel.svelte';
  import { hoursAgo, laneVM, splitStream, streamEntry } from '../cards/fixtures';
  import type { DiscussionFilterId } from '$lib/components/articleCardView.types';
  import Showcase from '../_harness/Showcase.svelte';
  import Case from '../_harness/Case.svelte';

  const lanes = [
    laneVM('linkblog', { count: 3, canCreate: false }),
    laneVM('bluesky', { count: 8, capped: true }),
    laneVM('margin', { count: 2 }),
    laneVM('semble', { count: 4 }),
  ];

  const filters = [
    { id: 'all' as const, label: 'All', count: 17, capped: true, icon: null },
    {
      id: 'linkblog' as const,
      label: 'Blogs',
      count: 3,
      capped: false,
      icon: 'standard-site' as const,
    },
    { id: 'bluesky' as const, label: 'Bluesky', count: 8, capped: true, icon: 'bluesky' as const },
    { id: 'margin' as const, label: 'margin.at', count: 2, capped: false, icon: 'margin' as const },
    { id: 'semble' as const, label: 'Semble', count: 4, capped: false, icon: 'semble' as const },
  ];

  // A cross-section of what the Atmosphere actually returns: real notes, a
  // bridge post that is nothing but the headline and two links, an annotation
  // with a quoted passage, a save filed into named collections, an entry with no
  // profile record at all, and one with no date.
  const entries = [
    streamEntry('bluesky', {
      did: 'did:plc:alice',
      handle: 'alice.bsky.social',
      displayName: 'Alice Mbeki',
      createdAt: hoursAgo(2),
      note: 'Best take on this I have read all year. The second half is the part worth arguing with, and I think the author knows it.',
      url: 'https://bsky.app/profile/alice.bsky.social/post/3kabc',
    }),
    streamEntry('margin', {
      did: 'did:plc:dana',
      handle: 'dana.margin.at',
      displayName: 'Dana Okafor',
      createdAt: hoursAgo(6),
      verb: 'highlighted',
      quote: 'the things you read are yours, and the place you keep them is yours too',
      note: 'This is the sentence the whole piece rests on.',
    }),
    streamEntry('linkblog', {
      did: 'did:plc:bob',
      handle: 'bob.example.com',
      displayName: 'Bob Iwu',
      createdAt: hoursAgo(20),
      note: 'Filed under things I will quote at someone this week.',
      url: 'https://bob.example.com/links/the-article',
    }),
    streamEntry('semble', {
      did: 'did:plc:erin',
      handle: 'erin.bsky.social',
      displayName: 'Erin Vasquez',
      createdAt: hoursAgo(28),
      url: 'https://semble.so/profile/erin.bsky.social',
      collections: [
        { name: 'AI & the open web', url: 'https://semble.so/profile/erin/collections/3kread' },
        { name: 'Protocol design', url: 'https://semble.so/profile/erin/collections/3kproto' },
      ],
    }),
    streamEntry('bluesky', {
      did: 'did:plc:hn',
      handle: 'betterhn20.e-work.xyz',
      createdAt: hoursAgo(31),
      note: 'The Article Title https://example.com/the-article (https://news.ycombinator.com/item?id=49396811)',
      url: 'https://bsky.app/profile/betterhn20.e-work.xyz/post/3kbot',
    }),
    streamEntry('bluesky', {
      did: 'did:plc:lobsters',
      handle: 'lobste.rs.web.brid.gy',
      createdAt: null,
      note: null,
      url: 'https://bsky.app/profile/lobste.rs.web.brid.gy/post/3knone',
    }),
    // Aggregator bots, verbatim in shape from a live article: the whole post is
    // the headline (or the publication's name) plus the link, sometimes with the
    // anchor's label left over. None of them said anything.
    streamEntry('bluesky', {
      did: 'did:plc:hnrobot',
      handle: 'hackernewsrobot.bsky.social',
      displayName: 'Hacker News Robot',
      createdAt: hoursAgo(26),
      note: 'The Article Title example.com/the-article',
      url: 'https://bsky.app/profile/hackernewsrobot.bsky.social/post/3kr1',
    }),
    streamEntry('bluesky', {
      did: 'did:plc:hn50',
      handle: 'betterhn50.e-work.xyz',
      displayName: 'Hacker News 50',
      createdAt: hoursAgo(27),
      note: 'The Article Title Discussion news.ycombinator.com/item?id=49396811',
      url: 'https://bsky.app/profile/betterhn50.e-work.xyz/post/3kr2',
    }),
    streamEntry('bluesky', {
      did: 'did:plc:blogbridge',
      handle: 'example.com.web.brid.gy',
      displayName: 'Blog [Unofficial]',
      createdAt: hoursAgo(48),
      note: 'The Publication Name example.com/the-article',
      url: 'https://bsky.app/profile/example.com.web.brid.gy/post/3kr3',
    }),
  ];

  let activeFilter = $state<DiscussionFilterId>('all');
  const filtered = $derived(
    activeFilter === 'all' ? entries : entries.filter((e) => e.lane === activeFilter)
  );
  // The panel receives the same split the hook performs: what people said, and
  // who merely relinked.
  const stream = $derived({ loading: false, ...splitStream(filtered) });
  const allStream = splitStream(entries);
</script>

<Showcase
  title="Discussion"
  description="What the Atmosphere said about one article, merged into a single chronological stream. Lanes are filters over it, not four lists to click between. The filter chips below are live."
>
  <Case
    name="Reader · the whole discussion"
    note="How it reads under a finished article: heading, total, filters, stream, then the ways to answer. Try the chips."
    width="800px"
    pad
  >
    <AtmospherePanel
      laneRow={lanes}
      {filters}
      {activeFilter}
      {stream}
      onSelectFilter={(id) => (activeFilter = id)}
    />
  </Case>

  <Case
    name="Card · no heading"
    note="Inside the feed card's sticky footer the Discussion button already names the section, so the panel drops its heading."
    width="620px"
    pad
  >
    <AtmospherePanel
      laneRow={lanes}
      {filters}
      activeFilter="all"
      stream={{ loading: false, ...allStream }}
      showHeading={false}
    />
  </Case>

  <Case
    name="Resolving"
    note="Every entry costs a PDS fetch, so the wait is real. The stream shows its own silhouette rather than a spinner."
    width="800px"
    pad
  >
    <AtmospherePanel laneRow={lanes} filters={[]} stream={{ loading: true, entries: [] }} />
  </Case>

  <Case
    name="Not asked yet"
    note="The reader hasn't reached the section, so nothing has been requested. Silhouettes would promise people who aren't coming and an empty line would claim there are none — so the panel shows only the ways to add yours until it opens."
    width="800px"
    pad
  >
    <AtmospherePanel
      laneRow={lanes}
      filters={[]}
      stream={{ idle: true, loading: false, entries: [] }}
    />
  </Case>

  <Case
    name="Nobody yet"
    note="No references anywhere. The panel says so and hands over the ways to be first."
    width="800px"
    pad
  >
    <AtmospherePanel
      laneRow={[laneVM('linkblog'), laneVM('bluesky'), laneVM('margin'), laneVM('semble')]}
      filters={[]}
      stream={{ loading: false, entries: [] }}
    />
  </Case>

  <Case
    name="Nobody said anything"
    note="The common real shape: every reference is an aggregator that posted the headline and the link. No empty rows — one line names them, and the surface stays honest about there being no conversation yet."
    width="800px"
    pad
  >
    <AtmospherePanel
      laneRow={[laneVM('bluesky', { count: 5 })]}
      filters={[]}
      stream={{ loading: false, entries: [], linkOnly: allStream.linkOnly }}
    />
  </Case>

  <Case
    name="Unreachable"
    note="Constellation or a PDS is down. Adornment never breaks the read, but it says what happened and offers the retry."
    width="800px"
    pad
  >
    <AtmospherePanel
      laneRow={lanes}
      filters={[]}
      stream={{ loading: false, failed: true, entries: [] }}
    />
  </Case>

  <Case
    name="One source only"
    note="A single populated lane needs no filter row — there is nothing to filter to."
    width="800px"
    pad
  >
    <AtmospherePanel
      laneRow={[laneVM('bluesky', { count: 2 })]}
      filters={[]}
      stream={{
        loading: false,
        ...splitStream(entries.filter((e) => e.lane === 'bluesky').slice(0, 3)),
      }}
    />
  </Case>
</Showcase>
