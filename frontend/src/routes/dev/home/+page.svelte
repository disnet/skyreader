<script lang="ts">
  // Visual harness for the Home view's lanes — no auth, no backend. Iterate on the
  // lane + tile design here; it flows to the real /home through the same components.
  import HomeLane from '$lib/components/feed/HomeLane.svelte';
  import DailyMagazineEntry from '$lib/components/feed/DailyMagazineEntry.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import type { LaneCardVM } from '$lib/components/feed/homeLane';
  import type { Magazine, SavedItem } from '$lib/types';
  import Showcase from '../_harness/Showcase.svelte';
  import Case from '../_harness/Case.svelte';

  let width = $state(880);

  function save(partial: Partial<SavedItem>): SavedItem {
    return {
      rkey: partial.rkey ?? Math.random().toString(36).slice(2),
      uri: partial.uri ?? `at://demo/${partial.rkey}`,
      url: partial.url ?? 'https://example.com/article',
      title: partial.title ?? 'Untitled',
      author: null,
      description: null,
      content: null,
      contentType: null,
      domain: partial.domain ?? null,
      image: partial.image ?? null,
      wordCount: partial.wordCount ?? null,
      publishedAt: null,
      savedAt: new Date().toISOString(),
      source: 'url',
      itemGuid: partial.rkey,
    };
  }

  function vm(partial: Partial<SavedItem>, extra: Partial<LaneCardVM> = {}): LaneCardVM {
    const s = save(partial);
    return {
      key: s.uri,
      displayItem: { type: 'saved', item: s, key: s.uri },
      title: s.title || s.url,
      domain: s.domain,
      image: s.image,
      faviconUrl: s.url
        ? `https://www.google.com/s2/favicons?domain=${new URL(s.url).hostname}&sz=64`
        : '',
      metaLabel:
        extra.metaLabel ?? (s.wordCount ? `${Math.round(s.wordCount / 200)} min read` : null),
      progress: extra.progress ?? null,
    };
  }

  const img = (seed: string) => `https://picsum.photos/seed/${seed}/240/240`;

  const continueItems: LaneCardVM[] = [
    vm(
      {
        rkey: 'c1',
        title: 'The quiet architecture of attention in long-form reading',
        domain: 'newyorker.com',
        url: 'https://newyorker.com/x',
        image: img('attn'),
        wordCount: 2400,
      },
      { progress: 0.32, metaLabel: '8 min left' }
    ),
    vm(
      {
        rkey: 'c2',
        title: 'Notes on building calm software',
        domain: 'craigmod.com',
        url: 'https://craigmod.com/x',
        wordCount: 1600,
      },
      { progress: 0.7, metaLabel: '3 min left' }
    ),
    vm(
      {
        rkey: 'c3',
        title: 'A field guide to the open social web and what comes after the feed',
        domain: 'theverge.com',
        url: 'https://theverge.com/x',
        image: img('web'),
        wordCount: 3000,
      },
      { progress: 0.12, metaLabel: '13 min left' }
    ),
    vm(
      {
        rkey: 'c4',
        title: 'Short one',
        domain: 'example.com',
        url: 'https://example.com/y',
        wordCount: 400,
      },
      { progress: 0.9, metaLabel: '1 min left' }
    ),
  ];

  const savedItems: LaneCardVM[] = [
    vm({
      rkey: 's1',
      title: 'Why we read',
      domain: 'aeon.co',
      url: 'https://aeon.co/a',
      image: img('read'),
      wordCount: 1800,
    }),
    vm({
      rkey: 's2',
      title: 'The forgotten history of margin notes',
      domain: 'publicdomainreview.org',
      url: 'https://publicdomainreview.org/b',
      wordCount: 2200,
    }),
    vm({
      rkey: 's3',
      title: 'On keeping a commonplace book in 2026',
      domain: 'subpixel.space',
      url: 'https://subpixel.space/c',
      image: img('book'),
      wordCount: 900,
    }),
    vm({
      rkey: 's4',
      title: 'No image here, just a favicon and a long enough title to wrap onto two lines',
      domain: 'example.org',
      url: 'https://example.org/d',
      wordCount: 1200,
    }),
    vm({
      rkey: 's5',
      title: 'Slow media',
      domain: 'slowmedia.net',
      url: 'https://slowmedia.net/e',
      image: img('slow'),
      wordCount: 600,
    }),
  ];

  const recentItems: LaneCardVM[] = [
    vm({
      rkey: 'r1',
      title: 'Just saved this morning',
      domain: 'stratechery.com',
      url: 'https://stratechery.com/r1',
      image: img('r1'),
      wordCount: 1500,
    }),
    vm({
      rkey: 'r2',
      title: 'A note on protocols',
      domain: 'atproto.com',
      url: 'https://atproto.com/r2',
      wordCount: 800,
    }),
    vm({
      rkey: 'r3',
      title: 'The reading room',
      domain: 'skyreader.app',
      url: 'https://skyreader.app/r3',
      image: img('r3'),
      wordCount: 1100,
    }),
  ];

  const fewItems = continueItems.slice(0, 1);

  const magazineStamp = Math.floor(new Date(2026, 6, 13).getTime() / 1000);
  const magazineMock: Magazine = {
    rkey: 'devmagazine00001',
    params: { order: 'shuffle', targetMinutes: 20, totalMinutes: 18 },
    items: savedItems.slice(0, 3).map((entry, index) => {
      const s = entry.displayItem.item as SavedItem;
      return {
        key: s.rkey,
        displayKey: s.uri || s.rkey,
        rkey: s.rkey,
        title: s.title,
        author: s.author,
        url: s.url,
        domain: s.domain,
        image: s.image,
        wordCount: s.wordCount,
        minutes: [9, 5, 4][index],
        savedAt: s.savedAt,
      };
    }),
    position: null,
    title: null,
    createdAt: magazineStamp,
    updatedAt: magazineStamp,
    deletedAt: null,
  };

  function noop() {}
</script>

<Showcase
  title="Home lanes"
  description="The Home view's horizontal lanes + tiles. Narrow the width to test overflow, edge fades, and the mobile bottom-bar padding. Hover a lane to reveal the scroll chevrons."
>
  {#snippet controls()}
    <label class="control">
      Width: {width}px
      <input type="range" min="320" max="980" step="10" bind:value={width} />
    </label>
  {/snippet}

  <Case name="Daily magazine entry" width="{width}px">
    <DailyMagazineEntry magazine={magazineMock} generating={false} onGenerate={noop} />
  </Case>

  <Case name="Continue reading — progress spines" width="{width}px">
    <HomeLane title="Continue reading" icon="clock" items={continueItems} onOpen={noop} />
  </Case>

  <Case name="From your saved — shuffle action, mixed thumbnails" width="{width}px">
    <HomeLane
      title="From your saved"
      icon="layers"
      items={savedItems}
      action={{ kind: 'button', label: 'Shuffle', icon: 'refresh-cw', onClick: noop }}
      onOpen={noop}
    />
  </Case>

  <Case name="Recently saved — view-all link" width="{width}px">
    <HomeLane
      title="Recently saved"
      icon="bookmark"
      items={recentItems}
      action={{ kind: 'link', label: 'View all', href: '/saved' }}
      onOpen={noop}
    />
  </Case>

  <Case name="Saved channel lane — filter icon, /saved?view= link" width="{width}px">
    <HomeLane
      title="Saved Long Reads"
      icon="filter"
      items={recentItems}
      action={{ kind: 'link', label: 'View all', href: '/saved?view=demo-uuid' }}
      onOpen={noop}
    />
  </Case>

  <Case name="Few items — no overflow, no chevrons" width="{width}px">
    <HomeLane title="Continue reading" icon="clock" items={fewItems} onOpen={noop} />
  </Case>

  <Case name="Loading skeleton" width="{width}px">
    <HomeLane title="Continue reading" icon="clock" items={[]} loading onOpen={noop} />
  </Case>

  <Case name="Empty state (no saves yet)" width="{width}px">
    <EmptyState
      title="Nothing to read here yet"
      description="Save an article and it collects here: your recent reads, a few to pick back up, and a rotating handful from your pile."
      actionHref="/feeds"
      actionText="Browse your feeds"
      icon="📚"
    />
  </Case>
</Showcase>

<style>
  .control {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }
</style>
