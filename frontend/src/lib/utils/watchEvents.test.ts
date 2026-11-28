import { describe, it, expect } from 'vitest';
import { watchEventLine } from './watchEvents';
import type { WatchEvent } from '$lib/types';

function event(partial: Partial<WatchEvent>): WatchEvent {
  return { kind: 'mentions', lane: 'bluesky', count: 1, detail: [], at: 0, ...partial };
}

describe('watchEventLine', () => {
  it('names the newest person and counts the rest', () => {
    expect(
      watchEventLine(
        event({
          count: 3,
          detail: [{ handle: 'a.test', displayName: 'Ana', url: 'https://bsky.app/profile/a' }],
        })
      )
    ).toEqual([
      { text: 'Ana', href: 'https://bsky.app/profile/a' },
      { text: ' and 2 others posted it on Bluesky' },
    ]);
  });

  it('falls back to a count when nobody is named', () => {
    expect(watchEventLine(event({ lane: 'margin', count: 2 }))).toEqual([
      { text: '2 more people annotated it on margin.at' },
    ]);
  });

  it('cites the newest paper and drops an unsafe link', () => {
    expect(
      watchEventLine(
        event({
          kind: 'citations',
          lane: null,
          count: 1,
          detail: [{ title: 'A paper', url: 'javascript:alert(1)' }],
        })
      )
    ).toEqual([{ text: 'Cited by ' }, { text: 'A paper', href: undefined }]);
    expect(watchEventLine(event({ kind: 'citations', lane: null, count: 4 }))).toEqual([
      { text: '4 new citations' },
    ]);
  });
});
