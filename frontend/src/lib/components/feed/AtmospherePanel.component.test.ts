// Mounted component test (jsdom) — see the "component" project in vitest.config.ts.
//
// A typed Semble connection is a directed claim, so the row has to read in the
// direction the edge actually points: the arrow is the sentence. An incoming
// "A refutes this" rendered as "refutes → A → this" reverses the claim for
// anyone reading the line rather than the aria-label.
import { describe, it, expect, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import AtmospherePanel from './AtmospherePanel.svelte';
import type { DiscussionEntryVM, LaneRowVM, SembleContextVM } from '../articleCardView.types';

const mounted: Record<string, any>[] = [];

const sembleLane: LaneRowVM = {
  id: 'semble',
  count: 1,
  capped: false,
  canCreate: false,
  icon: 'semble',
  label: 'Semble',
  verb: 'referenced',
  title: 'Referenced on Semble',
  isMine: false,
  createLabel: 'Save to Semble',
  createIsEdit: false,
};

const emptyContext: SembleContextVM = {
  stats: null,
  notes: [],
  collections: [],
  connections: [],
  truncated: { savers: false, notes: false, collections: false, connections: false },
  incomplete: false,
  source: 'semble-api',
  cardUrl: 'https://semble.so/url/https%3A%2F%2Fexample.com%2Fthe-article',
};

function connection(direction: 'in' | 'out'): SembleContextVM['connections'][number] {
  return {
    id: `connection-${direction}`,
    direction,
    type: 'supports',
    note: null,
    curator: { did: 'did:plc:curator', handle: 'curator.test', name: null, avatarUrl: null },
    createdAt: null,
    other: {
      url: 'https://other.example/piece',
      title: 'The other piece',
      description: null,
      siteName: null,
      imageUrl: null,
    },
  };
}

function render(props: {
  sembleContext?: SembleContextVM;
  stream?: { loading: boolean; failed?: boolean; entries: DiscussionEntryVM[] };
  onSaveConnection?: (url: string) => void | Promise<void>;
  isConnectionSaved?: (url: string) => boolean;
  onCreateConnection?: () => void;
}): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(AtmospherePanel, {
    target,
    props: {
      laneRow: [sembleLane],
      filters: [],
      activeFilter: 'all',
      stream: props.stream ?? { loading: false, entries: [] },
      sembleContext: props.sembleContext,
      onSaveConnection: props.onSaveConnection,
      isConnectionSaved: props.isConnectionSaved,
      onCreateConnection: props.onCreateConnection,
    },
  });
  flushSync();
  mounted.push(component);
  return target;
}

function relationLine(direction: 'in' | 'out'): string {
  const target = render({
    sembleContext: { ...emptyContext, connections: [connection(direction)] },
  });
  const line = target.querySelector('.relation');
  return (line?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('AtmospherePanel Semble connections', () => {
  afterEach(() => {
    for (const component of mounted.splice(0)) unmount(component);
    document.body.innerHTML = '';
  });

  it('reads this → type for an outgoing edge, with the target beneath', () => {
    expect(relationLine('out')).toBe('this → supports');
  });

  it('reads type → this for an incoming edge, so the claim never reverses', () => {
    expect(relationLine('in')).toBe('supports → this');
  });

  it('folds many same-shaped edges into one row and holds the rest back', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      ...connection('out'),
      id: `connection-${i}`,
      other: { ...connection('out').other, title: `Piece ${i}` },
    }));
    const target = render({ sembleContext: { ...emptyContext, connections: many } });
    // One curator, one relation, one direction: one row, one sentence.
    expect(target.querySelectorAll('.relation').length).toBe(1);
    expect(target.querySelector('.relation-count')?.textContent).toBe('12');
    expect(target.querySelectorAll('.connection-target').length).toBe(3);
    expect(target.querySelector('.semble-disclose')?.textContent?.trim()).toBe('Show 9 more');
  });

  it('keeps a differing curator, relation, or direction in its own row', () => {
    const other = {
      ...connection('out'),
      id: 'connection-other-curator',
      curator: { did: 'did:plc:second', handle: 'second.test', name: null, avatarUrl: null },
    };
    const target = render({
      sembleContext: { ...emptyContext, connections: [connection('out'), connection('in'), other] },
    });
    expect(target.querySelectorAll('.relation').length).toBe(3);
  });

  it('says what Semble held back rather than passing a page off as the whole', () => {
    const target = render({
      sembleContext: {
        ...emptyContext,
        stats: {
          saves: 0,
          notes: 0,
          collections: 0,
          connections: { total: 27, incoming: 0, outgoing: 27 },
        },
        connections: [connection('out')],
      },
    });
    expect(target.querySelector('.semble-foot')?.textContent).toContain('1 of 27 connections');
  });

  it('offers no keep control when the reader cannot save', () => {
    const target = render({ sembleContext: { ...emptyContext, connections: [connection('out')] } });
    expect(target.querySelector('.connection-save')).toBeNull();
  });

  it('gives every connected article its own keep control, reading saved state', () => {
    const target = render({
      sembleContext: { ...emptyContext, connections: [connection('out'), connection('in')] },
      onSaveConnection: () => {},
      isConnectionSaved: (url: string) => url === 'https://other.example/piece',
    });
    const controls = target.querySelectorAll('.connection-save');
    expect(controls.length).toBe(2);
    // Saved state is never carried by colour alone.
    expect([...controls].every((c) => c.getAttribute('aria-pressed') === 'true')).toBe(true);
    expect(controls[0].getAttribute('aria-label')).toContain('Remove');
  });

  it('hands the connected article\u2019s url to the save handler', () => {
    const saved: string[] = [];
    const target = render({
      sembleContext: { ...emptyContext, connections: [connection('out')] },
      onSaveConnection: (url: string) => void saved.push(url),
    });
    (target.querySelector('.connection-save') as HTMLButtonElement).click();
    expect(saved).toEqual(['https://other.example/piece']);
  });

  it('treats connections as content, so a connections-only article claims no emptiness', () => {
    const target = render({
      sembleContext: { ...emptyContext, connections: [connection('in')] },
    });
    expect(target.querySelector('.discussion-empty')).toBeNull();
    expect(target.querySelector('.semble-context')).not.toBeNull();
  });

  it('still says nobody wrote when the context came back with nothing in it', () => {
    const target = render({ sembleContext: emptyContext });
    expect(target.querySelector('.semble-context')).toBeNull();
    expect(target.querySelector('.discussion-empty')?.textContent).toContain('Nothing readable');
  });

  // Drawing an edge is the one thing a reader can add to an article nobody has
  // written about — so it can't be the affordance that disappears with the
  // Semble block it normally lives in.
  it('offers a connection on an article Semble has never seen', () => {
    const clicks: number[] = [];
    const target = render({ onCreateConnection: () => clicks.push(1) });
    expect(target.querySelector('.semble-context')).toBeNull();
    const cta = target.querySelector('.semble-connect') as HTMLButtonElement;
    expect(cta).not.toBeNull();
    expect(cta.textContent?.trim()).toBe('Draw the first connection');
    cta.click();
    expect(clicks.length).toBe(1);
  });

  it('offers it too when the context came back with nothing in it', () => {
    const target = render({ sembleContext: emptyContext, onCreateConnection: () => {} });
    expect(target.querySelector('.semble-context')).toBeNull();
    expect(target.querySelector('.semble-connect')).not.toBeNull();
  });

  // One invitation per panel: standing on its own it is already where the
  // compose row is, and the row's chip would repeat it a few pixels away.
  it('does not say it twice', () => {
    const empty = render({ onCreateConnection: () => {} });
    expect(empty.querySelectorAll('.semble-connect, .compose-connect').length).toBe(1);
    expect(empty.querySelector('.compose-connect')).toBeNull();

    const held = render({
      sembleContext: { ...emptyContext, connections: [connection('out')] },
      onCreateConnection: () => {},
    });
    // With a block to live in, the invitation is up there and the row's chip is
    // the quick way back to it.
    expect(held.querySelector('.semble-context .semble-connect')).not.toBeNull();
    expect(held.querySelector('.compose-connect')).not.toBeNull();
  });

  it('keeps the retry when a lane failed and only Semble context came back', () => {
    const target = render({
      sembleContext: { ...emptyContext, connections: [connection('out')] },
      stream: { loading: false, failed: true, entries: [] },
    });
    expect(target.querySelector('.discussion-retry')).not.toBeNull();
    expect(target.querySelector('.semble-context')).not.toBeNull();
  });
});

// A well-mapped URL sits in dozens of collections. Unfolded, the strip is a wall
// of pills standing between the reader and the discussion it introduces.
describe('AtmospherePanel Semble collections', () => {
  afterEach(() => {
    for (const component of mounted.splice(0)) unmount(component);
    document.body.innerHTML = '';
  });

  const collections = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `collection-${i}`,
      name: `Collection ${i}`,
      url: `https://semble.so/profile/erin.test/collections/${i}`,
      author: { did: 'did:plc:erin', handle: 'erin.test' },
    }));

  it('shows the first handful and holds the rest behind a disclosure', () => {
    const target = render({ sembleContext: { ...emptyContext, collections: collections(20) } });
    expect(target.querySelectorAll('.semble-collection').length).toBe(6);
    expect(target.querySelector('.semble-disclose-inline')?.textContent?.trim()).toBe('14 more');
  });

  it('opens the whole strip on request', () => {
    const target = render({ sembleContext: { ...emptyContext, collections: collections(20) } });
    (target.querySelector('.semble-disclose-inline') as HTMLButtonElement).click();
    flushSync();
    expect(target.querySelectorAll('.semble-collection').length).toBe(20);
    expect(target.querySelector('.semble-disclose-inline')).toBeNull();
  });

  it('leaves a short strip alone', () => {
    const target = render({ sembleContext: { ...emptyContext, collections: collections(3) } });
    expect(target.querySelectorAll('.semble-collection').length).toBe(3);
    expect(target.querySelector('.semble-disclose-inline')).toBeNull();
  });

  it('says how many collections Semble holds beyond the page it sent', () => {
    const target = render({
      sembleContext: {
        ...emptyContext,
        collections: collections(20),
        stats: {
          saves: 30,
          notes: 0,
          collections: 47,
          connections: { total: 0, incoming: 0, outgoing: 0 },
        },
        truncated: { savers: false, notes: false, collections: true, connections: false },
      },
    });
    expect(target.querySelector('.semble-foot')?.textContent).toContain(
      'Showing 20 of 47 collections.'
    );
  });

  it('still admits the page is partial when Semble sent no count to quote', () => {
    const target = render({
      sembleContext: {
        ...emptyContext,
        collections: collections(20),
        truncated: { savers: false, notes: false, collections: true, connections: false },
      },
    });
    expect(target.querySelector('.semble-foot')?.textContent).toContain('Semble holds more than');
  });
});

// The stream leads with the most-liked references, and an invisible sort key
// reads as random order — so the number that decided the rank is on the row.
describe('AtmospherePanel entry engagement', () => {
  afterEach(() => {
    for (const component of mounted.splice(0)) unmount(component);
    document.body.innerHTML = '';
  });

  function entry(did: string, likeCount: number | null): DiscussionEntryVM {
    return {
      did,
      handle: `${did}.test`,
      displayName: null,
      avatar: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      note: 'said something',
      url: null,
      collections: [],
      verb: null,
      quote: null,
      likeCount,
      key: `bluesky|${did}|`,
      lane: 'bluesky',
      laneLabel: 'Bluesky',
      laneIcon: 'bluesky',
      headVerb: 'posted',
      relativeTime: '2d ago',
      isoTime: '2026-01-01T00:00:00.000Z',
      cleanNote: 'said something',
    };
  }

  function likeLines(entries: DiscussionEntryVM[]): (string | null)[] {
    const target = render({ stream: { loading: false, entries } });
    return [...target.querySelectorAll('.entry')].map(
      (row) => row.querySelector('.entry-likes')?.textContent ?? null
    );
  }

  it('names the count that ranked the entry, singular and plural', () => {
    expect(likeLines([entry('did:plc:many', 12), entry('did:plc:one', 1)])).toEqual([
      '12 likes',
      '1 like',
    ]);
  });

  it('scores nothing when there is nothing to score', () => {
    // Zero likes and a lane with no metric at all read the same: no meta.
    expect(likeLines([entry('did:plc:zero', 0), entry('did:plc:none', null)])).toEqual([
      null,
      null,
    ]);
  });

  it('renders the entries in the order it was handed them', () => {
    const target = render({
      stream: { loading: false, entries: [entry('did:plc:top', 40), entry('did:plc:next', 2)] },
    });
    expect([...target.querySelectorAll('.entry-likes')].map((n) => n.textContent)).toEqual([
      '40 likes',
      '2 likes',
    ]);
  });
});
