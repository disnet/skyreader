import { describe, expect, it } from 'vitest';
import {
  HOME_SNAPSHOT_MAX_AGE_MS,
  parseHomeSnapshot,
  snapshotImageUrls,
  toSnapshotCard,
  type HomeSnapshot,
} from './homeSnapshot';
import type { LaneCardVM } from '$lib/components/feed/homeLane';

const NOW = 1_800_000_000_000;

function card(key: string, image: string | null = null): LaneCardVM {
  return {
    key,
    title: `Title ${key}`,
    domain: 'example.com',
    image,
    faviconUrl: `https://www.google.com/s2/favicons?domain=${key}.com&sz=32`,
    metaLabel: '5 min read',
    progress: null,
  };
}

function snapshot(overrides: Partial<HomeSnapshot> = {}): HomeSnapshot {
  return {
    v: 1,
    savedAt: NOW - 1000,
    sections: [
      { id: 'highlights' },
      {
        id: 'recent',
        lane: {
          title: 'Recently saved',
          icon: 'bookmark',
          action: { kind: 'link', label: 'View all in Queue', href: '/saved' },
          items: [
            toSnapshotCard(card('a', 'https://img.example.com/a.jpg')),
            toSnapshotCard(card('b')),
          ],
        },
      },
      {
        id: 'random',
        lane: { title: 'Random picks', icon: 'layers', action: { kind: 'shuffle' }, items: [] },
      },
    ],
    sample: ['rk1', 'rk2'],
    ...overrides,
  };
}

describe('parseHomeSnapshot', () => {
  it('round-trips a stored snapshot', () => {
    const snap = snapshot();
    expect(parseHomeSnapshot(JSON.stringify(snap), NOW)).toEqual(snap);
  });

  it('drops the reader-only displayItem from a card', () => {
    const vm = { ...card('a'), displayItem: { type: 'saved' } } as unknown as LaneCardVM;
    expect('displayItem' in toSnapshotCard(vm)).toBe(false);
  });

  it('reads nothing, malformed, another version or too old as none', () => {
    expect(parseHomeSnapshot(null, NOW)).toBeNull();
    expect(parseHomeSnapshot('{not json', NOW)).toBeNull();
    expect(parseHomeSnapshot(JSON.stringify({ ...snapshot(), v: 2 }), NOW)).toBeNull();
    expect(
      parseHomeSnapshot(
        JSON.stringify(snapshot({ savedAt: NOW - HOME_SNAPSHOT_MAX_AGE_MS - 1 })),
        NOW
      )
    ).toBeNull();
    const badCard = snapshot();
    (badCard.sections[1].lane!.items[0] as unknown as Record<string, unknown>).title = 7;
    expect(parseHomeSnapshot(JSON.stringify(badCard), NOW)).toBeNull();
    expect(parseHomeSnapshot(JSON.stringify({ ...snapshot(), sample: [1] }), NOW)).toBeNull();
  });

  it('reads a snapshot with no lanes as none, since it would paint nothing', () => {
    expect(
      parseHomeSnapshot(JSON.stringify(snapshot({ sections: [{ id: 'highlights' }] })), NOW)
    ).toBeNull();
  });
});

describe('snapshotImageUrls', () => {
  it('lists each tile’s cover, or its favicon when it has none', () => {
    expect(snapshotImageUrls(snapshot())).toEqual([
      'https://img.example.com/a.jpg',
      'https://www.google.com/s2/favicons?domain=b.com&sz=32',
    ]);
  });
});
