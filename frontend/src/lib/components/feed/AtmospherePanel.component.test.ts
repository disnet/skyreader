// Mounted component test (jsdom) — see the "component" project in vitest.config.ts.
//
// A typed Semble connection is a directed claim, so the row has to read in the
// direction the edge actually points: the arrow is the sentence. An incoming
// "A refutes this" rendered as "refutes → A → this" reverses the claim for
// anyone reading the line rather than the aria-label.
import { describe, it, expect, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import AtmospherePanel from './AtmospherePanel.svelte';
import type { LaneRowVM, SembleContextVM } from '../articleCardView.types';

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
  stream?: { loading: boolean; failed?: boolean; entries: [] };
  onSaveConnection?: (url: string) => void | Promise<void>;
  isConnectionSaved?: (url: string) => boolean;
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

  it('keeps the retry when a lane failed and only Semble context came back', () => {
    const target = render({
      sembleContext: { ...emptyContext, connections: [connection('out')] },
      stream: { loading: false, failed: true, entries: [] },
    });
    expect(target.querySelector('.discussion-retry')).not.toBeNull();
    expect(target.querySelector('.semble-context')).not.toBeNull();
  });
});
