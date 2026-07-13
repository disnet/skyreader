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
