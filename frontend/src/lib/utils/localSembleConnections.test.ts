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

  it('skips an edge Semble already has', () => {
    const withIt: SembleContext = {
      ...context,
      connections: [
        {
          id: 'semble-id',
          direction: 'in',
          type: 'leads to',
          note: null,
          curator: { did: 'did:plc:alice', handle: 'alice.test', name: null, avatarUrl: null },
          createdAt: null,
          other: {
            url: 'https://elsewhere.net/a-response',
            title: 'A response',
            description: null,
            siteName: null,
            imageUrl: null,
          },
        },
      ],
    };
    expect(withLocalConnections(withIt, [detail])).toBe(withIt);
  });

  it('leaves the context alone with nothing to add', () => {
    expect(withLocalConnections(context, [])).toBe(context);
  });
});
