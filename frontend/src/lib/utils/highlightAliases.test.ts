import { describe, expect, it } from 'vitest';
import type { Highlight } from '$lib/types';
import {
  mutateHighlightUnion,
  resolveHighlightAliases,
  unionHighlightSources,
} from './highlightAliases';

function highlight(id: string, exact = id): Highlight {
  return {
    id,
    selector: { type: 'TextQuoteSelector', exact },
    createdAt: 1,
  };
}

describe('saved highlight aliases', () => {
  it('keeps URI highlights visible and mutable after save mappings hydrate', () => {
    const uri = 'at://did:example/app.skyreader.feed.saved/one';
    const guid = 'article-guid';
    const beforeHydration = resolveHighlightAliases(uri, []);
    expect(beforeHydration).toEqual({ canonicalKey: uri, keys: [uri] });

    const first = mutateHighlightUnion([], { type: 'add', highlight: highlight('first') });
    expect(first.highlights).toHaveLength(1);

    const afterHydration = resolveHighlightAliases(uri, [{ uri, itemGuid: guid }]);
    expect(afterHydration).toEqual({ canonicalKey: guid, keys: [guid, uri] });
    const visible = unionHighlightSources([
      { key: uri, updatedAt: 10, highlights: first.highlights },
    ]);
    expect(visible.map((entry) => entry.id)).toEqual(['first']);

    const added = mutateHighlightUnion(visible, {
      type: 'add',
      highlight: highlight('second'),
    });
    const noted = mutateHighlightUnion(added.highlights, {
      type: 'note',
      highlightId: 'first',
      note: '  remembered  ',
    });
    expect(noted.highlights.find((entry) => entry.id === 'first')?.note).toBe('remembered');

    const removed = mutateHighlightUnion(noted.highlights, {
      type: 'remove',
      highlightId: 'second',
    });
    expect(removed.highlights.map((entry) => entry.id)).toEqual(['first']);
  });

  it('deduplicates aliases by id and prefers the newest row', () => {
    const old = { ...highlight('same'), note: 'old' };
    const current = { ...highlight('same'), note: 'current' };
    const union = unionHighlightSources([
      { key: 'guid', updatedAt: 20, highlights: [current] },
      { key: 'uri', updatedAt: 10, highlights: [old, highlight('uri-only')] },
    ]);
    expect(union.map((entry) => entry.id)).toEqual(['same', 'uri-only']);
    expect(union[0].note).toBe('current');
  });
});

describe('reviewed mutation', () => {
  const base = [highlight('one'), highlight('two')];

  it('stamps only the named highlight', () => {
    const result = mutateHighlightUnion(base, { type: 'reviewed', highlightId: 'one', at: 500 });
    expect(result.changed).toBe(true);
    expect(result.highlights.find((h) => h.id === 'one')?.lastReviewedAt).toBe(500);
    expect(result.highlights.find((h) => h.id === 'two')?.lastReviewedAt).toBeUndefined();
  });

  it('moves the stamp forward but never back', () => {
    const stamped = mutateHighlightUnion(base, {
      type: 'reviewed',
      highlightId: 'one',
      at: 500,
    }).highlights;

    // A slow device flushing an older review must not make it look due again.
    const stale = mutateHighlightUnion(stamped, { type: 'reviewed', highlightId: 'one', at: 100 });
    expect(stale.changed).toBe(false);
    expect(stale.highlights.find((h) => h.id === 'one')?.lastReviewedAt).toBe(500);

    const newer = mutateHighlightUnion(stamped, { type: 'reviewed', highlightId: 'one', at: 900 });
    expect(newer.changed).toBe(true);
    expect(newer.highlights.find((h) => h.id === 'one')?.lastReviewedAt).toBe(900);
  });

  it('is a no-op for an unknown highlight', () => {
    const result = mutateHighlightUnion(base, { type: 'reviewed', highlightId: 'gone', at: 1 });
    expect(result.changed).toBe(false);
    expect(result.highlights).toBe(base);
  });

  it('leaves the note and Margin linkage alone', () => {
    const withNote = [{ ...highlight('one'), note: 'kept', marginRkey: 'rk1' }];
    const result = mutateHighlightUnion(withNote, {
      type: 'reviewed',
      highlightId: 'one',
      at: 5,
    });
    expect(result.highlights[0]).toMatchObject({ note: 'kept', marginRkey: 'rk1' });
  });
});
