import { describe, it, expect } from 'vitest';
import { withLocalConnections } from './localSembleConnections';
import type { SavedConnectionDetail, SembleContext } from '$lib/types';

const detail: SavedConnectionDetail = {
  uri: 'at://did:plc:alice/network.cosmik.connection/3kabc',
  curatorDid: 'did:plc:alice',
  direction: 'in',
  otherUrl: 'https://www.elsewhere.net/a-response/',
  type: 'LEADS_TO',
  note: 'Picks it up.',
  indexedAt: Date.UTC(2026, 9, 19),
};

const context: SembleContext = {
  stats: null,
  notes: [],
  collections: [],
  connections: [],
  similar: [],
  truncated: { savers: false, notes: false, collections: false, connections: false },
  incomplete: false,
  source: 'semble-api',
  cardUrl: 'https://semble.so/url/x',
};

describe('withLocalConnections', () => {
  it('adds an edge Semble has not indexed yet', () => {
    const merged = withLocalConnections(context, [detail]);
    expect(merged?.cardUrl).toBe('https://semble.so/url/x');
    expect(merged?.connections).toHaveLength(1);
    expect(merged?.connections[0]).toMatchObject({
      id: detail.uri,
      direction: 'in',
      type: 'leads to',
      note: 'Picks it up.',
      curator: { did: 'did:plc:alice' },
      createdAt: '2026-10-19T00:00:00.000Z',
      other: { url: detail.otherUrl },
    });
  });

  it('works when Semble returned nothing at all', () => {
    expect(withLocalConnections(undefined, [detail])?.connections).toHaveLength(1);
  });

  function semble(over: Partial<SembleContext['connections'][number]> = {}) {
    return {
      id: 'semble-id',
      direction: 'in' as const,
      type: 'leads to',
      note: null,
      curator: { did: 'did:plc:alice', handle: 'alice.test', name: null, avatarUrl: null },
      createdAt: '2026-10-20T00:00:00.000Z',
      other: {
        url: 'https://www.elsewhere.net/a-response?utm_source=x',
        title: 'A response',
        description: null,
        siteName: null,
        imageUrl: null,
      },
      ...over,
    };
  }

  it('skips an edge Semble already has, by its uri or by the edge itself', () => {
    const byEdge: SembleContext = { ...context, connections: [semble()] };
    expect(withLocalConnections(byEdge, [detail])).toBe(byEdge);
    const byUri: SembleContext = {
      ...context,
      connections: [
        semble({ id: detail.uri, other: { ...semble().other, url: 'https://x.test' } }),
      ],
    };
    expect(withLocalConnections(byUri, [detail])).toBe(byUri);
  });

  it('keeps an edge to a different page, or of a different type', () => {
    const other: SembleContext = {
      ...context,
      connections: [
        semble({ other: { ...semble().other, url: 'https://www.elsewhere.net/a-response?p=2' } }),
        semble({ id: 'b', type: 'supports' }),
      ],
    };
    expect(withLocalConnections(other, [detail])?.connections).toHaveLength(3);
  });

  it("dates Semble's copy by when the poller saw it, when that's later", () => {
    const late: SembleContext = {
      ...context,
      connections: [semble({ createdAt: '2026-01-01T00:00:00.000Z' })],
    };
    const merged = withLocalConnections(late, [detail]);
    expect(merged?.connections).toHaveLength(1);
    expect(merged?.connections[0]).toMatchObject({
      id: 'semble-id',
      createdAt: '2026-10-19T00:00:00.000Z',
    });
    expect(late.connections[0].createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('leaves the context alone with nothing to add', () => {
    expect(withLocalConnections(context, [])).toBe(context);
  });
});
