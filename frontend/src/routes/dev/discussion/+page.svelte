<script lang="ts">
  // Harness for the discussion surface — the merged Atmosphere stream that sits
  // under a finished article (and inside the feed card's footer). AtmospherePanel
  // is purely presentational, so every state here is plain data: no auth, no
  // backend (see ../+layout.ts).
  import AtmospherePanel from '$lib/components/feed/AtmospherePanel.svelte';
  import { hoursAgo, laneVM, splitStream, streamEntry } from '../cards/fixtures';
  import type { DiscussionFilterId, SembleContextVM } from '$lib/components/articleCardView.types';
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

  // What Semble knows about the URL beyond the people already in the stream:
  // aggregate counts, collection placements, standalone notes, and the typed
  // edges in both directions. Savers arrive as ordinary stream entries (Erin,
  // above), so they are deliberately absent here — the block never repeats them.
  const sembleAuthor = (handle: string, name: string) => ({
    did: `did:plc:${handle.split('.')[0]}`,
    handle,
    name,
    avatarUrl: null,
  });
  const emptyContext: SembleContextVM = {
    stats: null,
    savers: [],
    notes: [],
    collections: [],
    connections: [],
    truncated: { savers: false, notes: false, collections: false, connections: false },
    incomplete: false,
    source: 'semble-api',
  };
  const outgoing = {
    id: 'conn-out',
    direction: 'out' as const,
    type: 'supports',
    note: 'The measurement here is the evidence the argument in the article leans on.',
    curator: sembleAuthor('erin.bsky.social', 'Erin Vasquez'),
    createdAt: hoursAgo(9),
    other: {
      url: 'https://example.org/measuring-the-open-web',
      title: 'Measuring the open web',
      description: null,
      siteName: 'example.org',
      imageUrl: null,
    },
  };
  const incoming = {
    id: 'conn-in',
    direction: 'in' as const,
    type: 'refutes',
    note: null,
    curator: sembleAuthor('dana.margin.at', 'Dana Okafor'),
    createdAt: hoursAgo(30),
    other: {
      url: 'https://another.example/the-counterargument',
      title: 'The counterargument, at length',
      description: null,
      siteName: 'another.example',
      imageUrl: null,
    },
  };
  // Direction is carried by the row's order as well as its label: an outgoing
  // edge reads this → type → other, an incoming one other → type → this.
  const untypedIncoming = {
    ...incoming,
    id: 'conn-in-untyped',
    type: null,
    createdAt: hoursAgo(40),
    other: { ...incoming.other, title: null, siteName: null },
  };
  const sembleContext: SembleContextVM = {
    ...emptyContext,
    stats: {
      saves: 4,
      notes: 2,
      collections: 2,
      connections: { total: 3, incoming: 2, outgoing: 1 },
    },
    notes: [
      {
        id: 'note-1',
        text: 'Pairs badly with the piece it cites in the third section — that study says the opposite.',
        author: sembleAuthor('gia.bsky.social', 'Gia Ferrante'),
        createdAt: hoursAgo(12),
      },
    ],
    collections: [
      {
        id: 'col-1',
        name: 'AI & the open web',
        url: 'https://semble.so/profile/erin.bsky.social/collections/3kread',
        author: { did: 'did:plc:erin', handle: 'erin.bsky.social' },
      },
      {
        id: 'col-2',
        name: 'Protocol design',
        url: null,
        author: { did: 'did:plc:erin', handle: 'erin.bsky.social' },
      },
    ],
    connections: [outgoing, incoming, untypedIncoming],
  };

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
      {sembleContext}
      onSelectFilter={(id) => (activeFilter = id)}
    />
  </Case>

  <Case
    name="Semble · everything it knows"
    note="What Semble holds about this URL that isn't a person in the stream: the counts, where it's filed, notes nobody attached to a save, and the typed edges. Outbound reads this → type → other; inbound reads other → type → this, so the arrow never lies about which way the claim points. Shown under All and Semble only — switch the chips above to watch it leave."
    width="800px"
    pad
  >
    <AtmospherePanel
      laneRow={lanes}
      filters={[]}
      {sembleContext}
      stream={{ loading: false, ...splitStream(entries.filter((e) => e.lane === 'semble')) }}
    />
  </Case>

  <Case
    name="Semble · connections only"
    note="Nobody said anything and nobody saved it — the URL exists in Semble purely as the endpoint of other people's edges. That still counts as readable content, so the panel must not claim nothing came back."
    width="800px"
    pad
  >
    <AtmospherePanel
      laneRow={[laneVM('semble', { count: 2 })]}
      filters={[]}
      sembleContext={{
        ...emptyContext,
        stats: {
          saves: 0,
          notes: 0,
          collections: 0,
          connections: { total: 2, incoming: 1, outgoing: 1 },
        },
        connections: [outgoing, incoming],
      }}
      stream={{ loading: false, entries: [] }}
    />
  </Case>

  <Case
    name="Semble · partial and truncated"
    note="One category timed out and another had more than one page. Both are disclosed in a line rather than silently rounded off — what returned still renders."
    width="800px"
    pad
  >
    <AtmospherePanel
      laneRow={lanes}
      filters={[]}
      sembleContext={{
        ...sembleContext,
        notes: [],
        truncated: { savers: false, notes: false, collections: false, connections: true },
        incomplete: true,
      }}
      stream={{ loading: false, ...splitStream(entries.filter((e) => e.lane === 'semble')) }}
    />
  </Case>

  <Case
    name="Semble · saver fallback"
    note="The API was unreachable and the Constellation/PDS resolver answered instead: the people it found still read normally, and no aggregate is invented to fill the space."
    width="800px"
    pad
  >
    <AtmospherePanel
      laneRow={[laneVM('semble', { count: 1 })]}
      filters={[]}
      sembleContext={{ ...emptyContext, incomplete: true, source: 'constellation-fallback' }}
      stream={{ loading: false, ...splitStream(entries.filter((e) => e.lane === 'semble')) }}
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
