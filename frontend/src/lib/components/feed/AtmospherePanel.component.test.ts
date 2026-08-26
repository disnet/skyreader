// Mounted component test (jsdom) — see the "component" project in vitest.config.ts.
//
// A typed Semble connection is a directed claim, so the row has to read in the
// direction the edge actually points: the arrow is the sentence. An incoming
// "A refutes this" rendered as "refutes → A → this" reverses the claim for
// anyone reading the line rather than the aria-label.
import { describe, it, expect, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import AtmospherePanel from './AtmospherePanel.svelte';
import type {
  DiscussionEntryVM,
  DiscussionFilterVM,
  LaneRowVM,
  SembleContextVM,
} from '../articleCardView.types';

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
  similar: [],
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

/**
 * Mount the panel and, optionally, open one of its kind-tabs — through the real
 * control, so a test that reaches for Semble's graph also proves the tab that
 * now holds it is reachable.
 */
function render(
  props: {
    sembleContext?: SembleContextVM;
    stream?: { loading: boolean; failed?: boolean; entries: DiscussionEntryVM[] };
    filters?: DiscussionFilterVM[];
    onSaveConnection?: (url: string) => void | Promise<void>;
    isConnectionSaved?: (url: string) => boolean;
    onCreateConnection?: () => void;
  },
  tab?: 'connections' | 'related'
): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(AtmospherePanel, {
    target,
    props: {
      laneRow: [sembleLane],
      filters: props.filters ?? [],
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
  if (tab) {
    const control = target.querySelector<HTMLButtonElement>(`[role="tab"][id$="-tab-${tab}"]`);
    if (!control) throw new Error(`no ${tab} tab rendered`);
    control.click();
    flushSync();
  }
  return target;
}

/** The panel's currently-open tabpanel, whichever kind it is. */
function panel(target: HTMLElement): HTMLElement | null {
  return target.querySelector('.discussion-panel');
}

function relationLine(direction: 'in' | 'out'): string {
  const target = render(
    { sembleContext: { ...emptyContext, connections: [connection(direction)] } },
    'connections'
  );
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
    const target = render({ sembleContext: { ...emptyContext, connections: many } }, 'connections');
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
    const target = render(
      {
        sembleContext: {
          ...emptyContext,
          connections: [connection('out'), connection('in'), other],
        },
      },
      'connections'
    );
    expect(target.querySelectorAll('.relation').length).toBe(3);
  });

  it('says what Semble held back rather than passing a page off as the whole', () => {
    const target = render(
      {
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
      },
      'connections'
    );
    expect(target.querySelector('.semble-foot')?.textContent).toContain('1 of 27 connections');
    // And the tab count is honest about it too: what it renders, plus a `+`.
    const tab = target.querySelector('[role="tab"][id$="-tab-connections"]');
    expect(tab?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Connections 1+');
  });

  it('offers no keep control when the reader cannot save', () => {
    const target = render(
      { sembleContext: { ...emptyContext, connections: [connection('out')] } },
      'connections'
    );
    expect(target.querySelector('.connection-save')).toBeNull();
  });

  it('gives every connected article its own keep control, reading saved state', () => {
    const target = render(
      {
        sembleContext: { ...emptyContext, connections: [connection('out'), connection('in')] },
        onSaveConnection: () => {},
        isConnectionSaved: (url: string) => url === 'https://other.example/piece',
      },
      'connections'
    );
    const controls = target.querySelectorAll('.connection-save');
    expect(controls.length).toBe(2);
    // Saved state is never carried by colour alone.
    expect([...controls].every((c) => c.getAttribute('aria-pressed') === 'true')).toBe(true);
    expect(controls[0].getAttribute('aria-label')).toContain('Remove');
  });

  it('hands the connected article\u2019s url to the save handler', () => {
    const saved: string[] = [];
    const target = render(
      {
        sembleContext: { ...emptyContext, connections: [connection('out')] },
        onSaveConnection: (url: string) => void saved.push(url),
      },
      'connections'
    );
    (target.querySelector('.connection-save') as HTMLButtonElement).click();
    expect(saved).toEqual(['https://other.example/piece']);
  });

  // Emptiness is a fact about one tab now. An article nobody wrote about but
  // somebody connected says so plainly in Conversation — and the Connections tab
  // standing beside it, carrying a count, is what says where the rest of it went.
  it('gives an edges-only article its own tab rather than burying it', () => {
    const target = render({
      sembleContext: { ...emptyContext, connections: [connection('in')] },
    });
    expect(target.querySelector('.discussion-empty')?.textContent).toContain('Nothing readable');
    const tab = target.querySelector('[role="tab"][id$="-tab-connections"]');
    expect(tab?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Connections 1');
    expect(target.querySelector('.relation')).toBeNull();
    expect(panel(target)?.id).toMatch(/-panel-conversation$/);
  });

  it('raises no tab strip when Semble holds nothing to put beside the conversation', () => {
    const target = render({ sembleContext: emptyContext });
    expect(target.querySelector('[role="tablist"]')).toBeNull();
    expect(target.querySelector('.discussion-empty')?.textContent).toContain('Nothing readable');
  });

  // Drawing an edge is the one thing a reader can add to an article nobody has
  // written about — so it can't be the affordance that disappears with the
  // Semble block it normally lives in.
  it('offers a connection on an article Semble has never seen', () => {
    const clicks: number[] = [];
    const target = render({ onCreateConnection: () => clicks.push(1) });
    expect(target.querySelector('[role="tablist"]')).toBeNull();
    const cta = target.querySelector('.semble-connect') as HTMLButtonElement;
    expect(cta).not.toBeNull();
    expect(cta.textContent?.trim()).toBe('Draw the first connection');
    cta.click();
    expect(clicks.length).toBe(1);
  });

  it('offers it too when the context came back with nothing in it', () => {
    const target = render({ sembleContext: emptyContext, onCreateConnection: () => {} });
    expect(target.querySelector('[role="tablist"]')).toBeNull();
    expect(target.querySelector('.semble-connect')).not.toBeNull();
  });

  // One invitation per panel, and it lives beside the edges it adds to. With a
  // Connections tab there is exactly one, in there; with no such tab it stands
  // at the end of the conversation instead.
  it('does not say it twice', () => {
    const empty = render({ onCreateConnection: () => {} });
    expect(empty.querySelectorAll('.semble-connect').length).toBe(1);

    const held = render(
      {
        sembleContext: { ...emptyContext, connections: [connection('out')] },
        onCreateConnection: () => {},
      },
      'connections'
    );
    expect(held.querySelectorAll('.semble-connect').length).toBe(1);
    expect(held.querySelector('.discussion-panel.graph .semble-connect')).not.toBeNull();

    // ...and it is not also sitting at the end of the conversation.
    const conversation = held.querySelector<HTMLButtonElement>(
      '[role="tab"][id$="-tab-conversation"]'
    );
    conversation?.click();
    flushSync();
    expect(held.querySelector('.semble-connect')).toBeNull();
  });

  it('keeps the retry when a lane failed and only Semble context came back', () => {
    const target = render({
      sembleContext: { ...emptyContext, connections: [connection('out')] },
      stream: { loading: false, failed: true, entries: [] },
    });
    expect(target.querySelector('.discussion-retry')).not.toBeNull();
    // The conversation failed; the graph that did answer is one tab away and
    // says so, rather than being lost behind the error.
    expect(target.querySelector('[role="tab"][id$="-tab-connections"]')).not.toBeNull();
    expect(target.querySelector('.discussion-empty')?.textContent).toContain(
      "Some of the Atmosphere didn't answer"
    );
  });
});

describe('AtmospherePanel Semble similar articles', () => {
  afterEach(() => {
    for (const component of mounted.splice(0)) unmount(component);
    document.body.innerHTML = '';
  });

  const similar = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      url: `https://similar${i}.example/story`,
      title: i === 1 ? null : `Similar article ${i}`,
      siteName: i === 1 ? null : 'Example Review',
      saveCount: i + 1,
    }));

  it('renders links, metadata, hostname fallback, and a Semble foot link', () => {
    const target = render({ sembleContext: { ...emptyContext, similar: similar(2) } }, 'related');
    const links = target.querySelectorAll('.similar-list .connection-target');
    expect(links.length).toBe(2);
    expect(links[0].getAttribute('href')).toBe('https://similar0.example/story');
    expect(links[1].textContent).toBe('similar1.example');
    expect(target.querySelector('.similar-meta')?.textContent).toContain('Example Review');
    expect(target.querySelector('.semble-foot')?.textContent).toContain('See all on Semble');
  });

  it('uses the connection save affordance and saved state', () => {
    const saved: string[] = [];
    const target = render(
      {
        sembleContext: { ...emptyContext, similar: similar(1) },
        onSaveConnection: (url) => void saved.push(url),
        isConnectionSaved: () => true,
      },
      'related'
    );
    const button = target.querySelector('.semble-similar .connection-save') as HTMLButtonElement;
    expect(button.getAttribute('aria-pressed')).toBe('true');
    button.click();
    expect(saved).toEqual(['https://similar0.example/story']);
  });

  it('raises no Related tab when there is nothing to recommend', () => {
    const empty = render({ sembleContext: emptyContext });
    expect(empty.querySelector('[role="tab"][id$="-tab-related"]')).toBeNull();
    expect(empty.querySelector('.semble-similar')).toBeNull();
    const { similar: _similar, ...oldContext } = emptyContext;
    const absent = render({ sembleContext: oldContext });
    expect(absent.querySelector('[role="tab"][id$="-tab-related"]')).toBeNull();
  });

  it('previews four recommendations and reveals the rest', () => {
    const target = render({ sembleContext: { ...emptyContext, similar: similar(7) } }, 'related');
    expect(target.querySelectorAll('.similar-list li').length).toBe(4);
    const disclose = target.querySelector('.semble-similar .semble-disclose') as HTMLButtonElement;
    expect(disclose.textContent?.trim()).toBe('3 more');
    disclose.click();
    flushSync();
    expect(target.querySelectorAll('.similar-list li').length).toBe(7);
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
    const target = render(
      { sembleContext: { ...emptyContext, collections: collections(20) } },
      'connections'
    );
    expect(target.querySelectorAll('.semble-collection').length).toBe(6);
    expect(target.querySelector('.semble-disclose-inline')?.textContent?.trim()).toBe('14 more');
  });

  it('opens the whole strip on request', () => {
    const target = render(
      { sembleContext: { ...emptyContext, collections: collections(20) } },
      'connections'
    );
    (target.querySelector('.semble-disclose-inline') as HTMLButtonElement).click();
    flushSync();
    expect(target.querySelectorAll('.semble-collection').length).toBe(20);
    expect(target.querySelector('.semble-disclose-inline')).toBeNull();
  });

  it('leaves a short strip alone', () => {
    const target = render(
      { sembleContext: { ...emptyContext, collections: collections(3) } },
      'connections'
    );
    expect(target.querySelectorAll('.semble-collection').length).toBe(3);
    expect(target.querySelector('.semble-disclose-inline')).toBeNull();
  });

  it('says how many collections Semble holds beyond the page it sent', () => {
    const target = render(
      {
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
      },
      'connections'
    );
    expect(target.querySelector('.semble-foot')?.textContent).toContain(
      'Showing 20 of 47 collections.'
    );
  });

  it('still admits the page is partial when Semble sent no count to quote', () => {
    const target = render(
      {
        sembleContext: {
          ...emptyContext,
          collections: collections(20),
          truncated: { savers: false, notes: false, collections: true, connections: false },
        },
      },
      'connections'
    );
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

// Three different kinds of thing had piled up in one column with no boundary
// between them, and a source filter that cut across all three at once. The tab
// strip is the boundary: what people SAID, how this is CONNECTED, what to READ
// NEXT — and the network goes back to being a property of a row.
describe('AtmospherePanel kind tabs', () => {
  afterEach(() => {
    for (const component of mounted.splice(0)) unmount(component);
    document.body.innerHTML = '';
  });

  const recommendation = (i: number) => ({
    url: `https://similar${i}.example/story`,
    title: `Similar ${i}`,
    siteName: 'Example Review',
    saveCount: 2,
  });
  const everything: SembleContextVM = {
    ...emptyContext,
    notes: [
      {
        id: 'note-1',
        text: 'Pairs badly with the piece it cites.',
        author: { did: 'did:plc:gia', handle: 'gia.test', name: 'Gia', avatarUrl: null },
        createdAt: null,
      },
    ],
    collections: [
      {
        id: 'collection-1',
        name: 'Protocols',
        url: null,
        author: { did: 'did:plc:erin', handle: 'erin.test' },
      },
    ],
    connections: [connection('out')],
    similar: [recommendation(0), recommendation(1)],
  };

  const labels = (target: HTMLElement) =>
    [...target.querySelectorAll('[role="tab"]')].map((t) =>
      (t.textContent ?? '').replace(/\s+/g, ' ').trim()
    );

  it('names the three kinds and counts what each of them holds', () => {
    const target = render({ sembleContext: everything });
    // Conversation: the lane reference count, plus the standalone note that now
    // reads in the stream. Connections: a shelf and an edge are both edges.
    expect(labels(target)).toEqual(['Conversation 2', 'Connections 2', 'Related 2']);
    expect(target.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(
      'Conversation'
    );
  });

  it('drops the heading total, which the Conversation tab is already carrying', () => {
    expect(render({ sembleContext: everything }).querySelector('.discussion-total')).toBeNull();
    // With one kind there is no strip, so the heading keeps the count it had.
    expect(
      render({}).querySelector('.discussion-total')?.textContent?.replace(/\s+/g, ' ')
    ).toContain('1 reference across the Atmosphere');
  });

  it('reads a Semble note in the conversation, not in the graph', () => {
    const target = render({ sembleContext: everything });
    expect(target.querySelector('.entry-note')?.textContent).toContain('Pairs badly');
    target.querySelector<HTMLButtonElement>('[role="tab"][id$="-tab-connections"]')?.click();
    flushSync();
    expect(target.querySelector('.entry-note')).toBeNull();
    expect(target.querySelector('.relation')).not.toBeNull();
  });

  it('keeps the source filter inside the one tab made of rows', () => {
    const filters: DiscussionFilterVM[] = [
      { id: 'all', label: 'All', count: 3, capped: false, icon: null },
      { id: 'bluesky', label: 'Bluesky', count: 2, capped: false, icon: 'bluesky' },
      { id: 'semble', label: 'Semble', count: 1, capped: false, icon: 'semble' },
    ];
    const target = render({ sembleContext: everything, filters });
    expect(target.querySelectorAll('.filter-chip').length).toBe(3);
    // `All` shows no count: it is the tab's number by definition.
    expect(target.querySelector('.filter-chip')?.querySelector('.filter-count')).toBeNull();

    target.querySelector<HTMLButtonElement>('[role="tab"][id$="-tab-related"]')?.click();
    flushSync();
    expect(target.querySelector('.filter-chip')).toBeNull();
  });

  it('points every tab at the panel it opens, and labels that panel back', () => {
    const target = render({ sembleContext: everything });
    const tab = target.querySelector('[role="tab"][aria-selected="true"]')!;
    const panelEl = target.querySelector('[role="tabpanel"]')!;
    expect(tab.getAttribute('aria-controls')).toBe(panelEl.id);
    expect(panelEl.getAttribute('aria-labelledby')).toBe(tab.id);
    // Only the selected tab is a tab stop; the arrows reach the rest.
    expect(
      [...target.querySelectorAll('[role="tab"]')].map((t) => t.getAttribute('tabindex'))
    ).toEqual(['0', '-1', '-1']);
  });

  it('moves and selects with the arrow keys, wrapping at both ends', () => {
    const target = render({ sembleContext: everything });
    const press = (key: string) =>
      target
        .querySelector('[role="tab"][aria-selected="true"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    const selected = () =>
      target.querySelector('[role="tab"][aria-selected="true"]')!.id.split('-tab-')[1];

    press('ArrowRight');
    flushSync();
    expect(selected()).toBe('connections');
    press('End');
    flushSync();
    expect(selected()).toBe('related');
    press('ArrowRight');
    flushSync();
    expect(selected()).toBe('conversation');
    press('ArrowLeft');
    flushSync();
    expect(selected()).toBe('related');
    press('Home');
    flushSync();
    expect(selected()).toBe('conversation');
  });

  it('leaves other keys to the surface underneath', () => {
    const target = render({ sembleContext: everything });
    const event = new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true });
    target.querySelector('[role="tab"][aria-selected="true"]')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
