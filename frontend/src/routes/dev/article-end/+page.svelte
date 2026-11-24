<script lang="ts">
  // Harness for the end of an article: everything the reader adds below the
  // text, in the order SavedReader stacks it. The pieces are the real ones
  // (SavedFromHere reads its links off the body; ConnectToPrevious and
  // AtmospherePanel are presentational) on the real band (ReaderAfterword),
  // over fixtures: no auth, no backend. ?theme=dark pins dark; ?links=0 drops
  // the article's links, ?connect=0 the recent reads.
  import { page } from '$app/state';
  import SavedFromHere from '$lib/components/feed/SavedFromHere.svelte';
  import ConnectToPrevious from '$lib/components/feed/ConnectToPrevious.svelte';
  import AtmospherePanel from '$lib/components/feed/AtmospherePanel.svelte';
  import ReaderAfterword from '$lib/components/feed/ReaderAfterword.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { hoursAgo, laneVM, splitStream, streamEntry } from '../cards/fixtures';
  import type { DiscussionFilterId, SembleContextVM } from '$lib/components/articleCardView.types';

  const showLinks = $derived(page.url.searchParams.get('links') !== '0');
  const showConnect = $derived(page.url.searchParams.get('connect') !== '0');
  $effect(() => {
    const theme = page.url.searchParams.get('theme');
    if (!theme) return;
    const root = document.documentElement;
    const before = root.dataset.theme;
    root.dataset.theme = theme;
    return () => {
      if (before) root.dataset.theme = before;
      else delete root.dataset.theme;
    };
  });

  const ARTICLE_URL = 'https://example.com/2026/the-dragon';
  const links = [
    ['https://www.youtube.com/watch?v=abc', 'a bunch of talks'],
    ['https://example.org/slides.pdf', 'slides'],
    ['https://www.youtube.com/watch?v=def', 'video'],
    ['https://www.ihp.fr/en/events', 'the IHP'],
    ['https://arxiv.org/abs/2601.00001', 'the paper'],
    ['https://terrytao.wordpress.com/2026/01/01/formal', 'Terence Tao’s note'],
    ['https://leanprover-community.github.io/', 'Lean'],
    ['https://en.wikipedia.org/wiki/Mathlib', 'Mathlib'],
    // A long host and a long unbroken title: neither may widen the list.
    [
      'https://formal-mathematics-reading-group.department-of-mathematics.university.example.ac.uk/notes',
      'the_reading_group_notes_on_formalising_the_whole_of_undergraduate_mathematics',
    ],
  ];
  const a = (i: number) => `<a href="${links[i][0]}">${links[i][1]}</a>`;
  const html = `
    <p>Formal proof assistants will change how ${a(6)} and ${a(7)} (${a(8)}) are written, and ${a(4)} lays out how.</p>
    <p>See ${a(5)} and ${a(3)}.</p>
    <p>* I have given ${a(0)} defending this vision in the past months, the most recent one at the IHP (${a(1)}, ${a(2)}).</p>`;

  const reads = [
    {
      key: 'r1',
      url: 'https://www.newyorker.com/buddhist-ai',
      title: 'The Buddhist A.I. Sect That Wants to Take Over Silicon Valley',
      at: Date.now() - 21 * 3600e3,
    },
    {
      key: 'r2',
      url: 'https://kevinmunger.substack.com/stafford-beer',
      title: 'The Tragedy of Stafford Beer',
      at: Date.now() - 3 * 86400e3,
    },
    {
      key: 'r3',
      url: 'https://sentiers.media/grief',
      title: 'A Season of Grief',
      at: Date.now() - 4 * 86400e3,
    },
  ];
  const suggestion = { reads, onConnect: () => {}, onPickOther: () => {} };

  const lanes = [
    laneVM('linkblog', { count: 3, canCreate: false }),
    laneVM('bluesky', { count: 21 }),
    laneVM('margin', { count: 2 }),
    laneVM('semble', { count: 4 }),
  ];
  const filters = [
    { id: 'all' as const, label: 'All', count: 27, capped: false, icon: null },
    {
      id: 'bluesky' as const,
      label: 'Bluesky',
      count: 21,
      capped: false,
      icon: 'bluesky' as const,
    },
    { id: 'margin' as const, label: 'margin.at', count: 2, capped: false, icon: 'margin' as const },
    { id: 'semble' as const, label: 'Semble', count: 4, capped: false, icon: 'semble' as const },
  ];
  const entries = [
    streamEntry('bluesky', {
      did: 'did:plc:frank',
      handle: 'frank.bsky.social',
      displayName: 'Maria Antoniak',
      createdAt: hoursAgo(2),
      likeCount: 12,
      note: 'The argument in the second half is the one worth having, and almost nobody quoting this has got to it yet.',
      url: 'https://bsky.app/profile/frank.bsky.social/post/3kfrank',
    }),
    streamEntry('margin', {
      did: 'did:plc:dana',
      handle: 'dana.margin.at',
      displayName: 'Dana Okafor',
      createdAt: hoursAgo(6),
      verb: 'highlighted',
      quote: 'ride the dragon to take part in them, for the honor of the human mind',
      note: 'This is the sentence the whole piece rests on.',
    }),
    streamEntry('bluesky', {
      did: 'did:plc:alice',
      handle: 'alice.bsky.social',
      displayName: 'Alice Mbeki',
      createdAt: hoursAgo(9),
      likeCount: 4,
      note: 'Best take on this I have read all year.',
      url: 'https://bsky.app/profile/alice.bsky.social/post/3kabc',
    }),
  ];
  const sembleContext: SembleContextVM = {
    stats: {
      saves: 4,
      notes: 0,
      collections: 1,
      connections: { total: 1, incoming: 0, outgoing: 1 },
    },
    notes: [],
    collections: [],
    connections: [],
    similar: [
      {
        url: 'https://reading.example/slow-web',
        title: 'A slower web',
        siteName: 'Reading Notes',
        saveCount: 12,
      },
    ],
    truncated: { savers: false, notes: false, collections: false, connections: false },
    incomplete: false,
    source: 'semble-api',
    cardUrl: 'https://semble.so/url/x',
  };
  let activeFilter = $state<DiscussionFilterId>('all');
  const stream = $derived({ loading: false, ...splitStream(entries) });
</script>

{#snippet shareControl()}
  <button type="button" class="share-cta">
    <Icon name="share" size={14} />
    <span>Your linkblog</span>
  </button>
{/snippet}

<div class="column">
  <div class="body">
    <p>
      can remain bitter spectators of these great achievements, or ride the dragon to take part in
      them, for the honor of the human mind.
    </p>
    <aside class="note">
      <a href="#x">*</a> I have given <a href="#x">a bunch of talks</a> defending this vision in the
      past months, the most recent one at the IHP (<a href="#x">slides</a>,
      <a href="#x">video</a>).
    </aside>
  </div>

  <p class="capture">
    Captured on November 20, 2026 at 7:54 PM, fetched by Skyreader.
    <span class="hash">SHA-256 64583bbd203c…</span>
  </p>

  <ReaderAfterword>
    <SavedFromHere url={ARTICLE_URL} title="Riding the dragon" html={showLinks ? html : ''} />
    {#if showConnect}
      <ConnectToPrevious {suggestion} />
    {/if}
    <section class="reader-discussion" aria-label="Discussion">
      <AtmospherePanel
        laneRow={lanes}
        {filters}
        {activeFilter}
        {stream}
        {sembleContext}
        lanesOpen={true}
        framed={false}
        panelId="harness-discussion"
        itemUrl={ARTICLE_URL}
        onSelectFilter={(id) => (activeFilter = id)}
        onCreateInLane={() => {}}
        onCreateConnection={() => {}}
        composeLead={shareControl}
      />
    </section>
  </ReaderAfterword>
</div>

<style>
  :global(body) {
    background: var(--color-bg);
  }

  .column {
    box-sizing: border-box;
    max-width: 720px;
    margin: 0 auto;
    padding: 1rem 1rem 6rem;
    color: var(--color-text);
  }

  .body {
    font-family: Charter, Georgia, serif;
    font-size: 1.125rem;
    line-height: 1.8;
  }

  .note {
    margin: 1.5rem -0.5rem 0;
    padding: 0.25rem 0.5rem;
    border-radius: 6px;
    background: var(--color-bg-secondary);
  }

  .body a {
    color: var(--color-primary);
  }

  /* As SavedReader sets it. */
  .capture {
    margin: 2rem 0 0;
    padding-top: 0.75rem;
    border-top: 1px solid var(--color-border);
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .hash {
    font-family: ui-monospace, monospace;
    white-space: nowrap;
  }

  .share-cta {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.3125rem 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: none;
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    line-height: var(--leading-none);
    color: var(--color-text);
  }
</style>
