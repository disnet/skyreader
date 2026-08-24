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
  savers: [],
  notes: [],
  collections: [],
  connections: [],
  truncated: { savers: false, notes: false, collections: false, connections: false },
  incomplete: false,
  source: 'semble-api',
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
    },
  });
  flushSync();
  mounted.push(component);
  return target;
}

function connectionLine(direction: 'in' | 'out'): string {
  const target = render({
    sembleContext: { ...emptyContext, connections: [connection(direction)] },
  });
  const line = target.querySelector('.connection-line');
  return (line?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('AtmospherePanel Semble connections', () => {
  afterEach(() => {
    for (const component of mounted.splice(0)) unmount(component);
    document.body.innerHTML = '';
  });

  it('reads this → type → other for an outgoing edge', () => {
    expect(connectionLine('out')).toBe('this → supports → The other piece');
  });

  it('reads other → type → this for an incoming edge', () => {
    expect(connectionLine('in')).toBe('The other piece → supports → this');
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
