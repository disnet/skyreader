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

  it("keeps a link save's rkey highlights once the save gains a uri", () => {
    const rkey = '3linksave00001';
    expect(resolveHighlightAliases(rkey, [{ rkey, uri: null as unknown as string }])).toEqual({
      canonicalKey: rkey,
      keys: [rkey],
    });
    const uri = 'at://did:example/network.cosmik.card/one';
    expect(resolveHighlightAliases(uri, [{ rkey, uri }])).toEqual({
      canonicalKey: uri,
      keys: [uri, rkey],
    });
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

describe('selector mutation', () => {
  it('re-bounds only the named highlight and preserves its metadata', () => {
    const base = [
      {
        ...highlight('one', 'old quote'),
        note: 'kept',
        marginRkey: 'margin-key',
        lastReviewedAt: 42,
      },
      highlight('two'),
    ];
    const selector = { type: 'TextQuoteSelector' as const, exact: 'new quote', prefix: 'before' };
    const result = mutateHighlightUnion(base, { type: 'selector', highlightId: 'one', selector });

    expect(result.changed).toBe(true);
    expect(result.highlights[0]).toEqual({ ...base[0], selector });
    expect(result.highlights[1]).toBe(base[1]);
  });

  it('reports no change when the bounds are identical', () => {
    // The touch adjust flow commits on selection collapse, so tapping away
    // without dragging re-sends the highlight's own selector. That must not
    // queue a write (and a Margin round-trip) for a no-op.
    const base = [{ ...highlight('one', 'same quote'), note: 'kept' }];
    const result = mutateHighlightUnion(base, {
      type: 'selector',
      highlightId: 'one',
      selector: { type: 'TextQuoteSelector', exact: 'same quote' },
    });

    expect(result.changed).toBe(false);
    expect(result.highlights).toBe(base);
  });

  it('treats a changed prefix as a re-bound even when the quote is the same', () => {
    const base = [highlight('one', 'same quote')];
    const result = mutateHighlightUnion(base, {
      type: 'selector',
      highlightId: 'one',
      selector: { type: 'TextQuoteSelector', exact: 'same quote', suffix: ' and on' },
    });

    expect(result.changed).toBe(true);
    expect(result.highlights[0].selector.suffix).toBe(' and on');
  });
});

describe('pin and tag mutations', () => {
  it('pins and unpins, and treats unpinning an unpinned highlight as a no-op', () => {
    const pinned = mutateHighlightUnion([highlight('a')], {
      type: 'pin',
      highlightId: 'a',
      pinnedAt: 5,
    });
    expect(pinned.highlights[0].pinnedAt).toBe(5);

    const unpinned = mutateHighlightUnion(pinned.highlights, {
      type: 'pin',
      highlightId: 'a',
      pinnedAt: null,
    });
    expect(unpinned.changed).toBe(true);
    expect('pinnedAt' in unpinned.highlights[0]).toBe(false);

    expect(
      mutateHighlightUnion(unpinned.highlights, { type: 'pin', highlightId: 'a', pinnedAt: null })
        .changed
    ).toBe(false);
  });

  it('normalizes tags and drops the field when they are cleared', () => {
    const tagged = mutateHighlightUnion([highlight('a')], {
      type: 'tags',
      highlightId: 'a',
      tags: [' essay ', 'Essay', '', 'attention'],
    });
    expect(tagged.highlights[0].tags).toEqual(['essay', 'attention']);

    expect(
      mutateHighlightUnion(tagged.highlights, {
        type: 'tags',
        highlightId: 'a',
        tags: ['essay', 'attention'],
      }).changed
    ).toBe(false);

    const cleared = mutateHighlightUnion(tagged.highlights, {
      type: 'tags',
      highlightId: 'a',
      tags: [],
    });
    expect('tags' in cleared.highlights[0]).toBe(false);
  });
});

describe('Margin sync state on a highlight', () => {
  const base = {
    id: 'h',
    selector: { type: 'TextQuoteSelector' as const, exact: 'x' },
    createdAt: 1,
    note: 'here',
  };

  it('records the note a new Margin record was written with, and clears it on unlink', () => {
    const linked = mutateHighlightUnion([base], {
      type: 'margin',
      highlightId: 'h',
      margin: { uri: 'at://did/at.margin.note/r', rkey: 'r' },
      syncedNote: ' here ',
    }).highlights[0];
    expect(linked).toMatchObject({ marginRkey: 'r', marginNote: 'here' });

    const unlinked = mutateHighlightUnion([linked], {
      type: 'margin',
      highlightId: 'h',
      margin: null,
    }).highlights[0];
    expect(unlinked.marginRkey).toBeUndefined();
    expect(unlinked.marginNote).toBeUndefined();
    expect(unlinked.note).toBe('here');
  });

  it("takes Margin's note with applyNote, and only records it without", () => {
    const taken = mutateHighlightUnion([base], {
      type: 'marginSynced',
      highlightId: 'h',
      note: 'theirs',
      applyNote: true,
    }).highlights[0];
    expect(taken).toMatchObject({ note: 'theirs', marginNote: 'theirs' });

    const cleared = mutateHighlightUnion([base], {
      type: 'marginSynced',
      highlightId: 'h',
      note: undefined,
      applyNote: true,
    }).highlights[0];
    expect(cleared.note).toBeUndefined();
    expect(cleared.marginNote).toBe('');

    const recorded = mutateHighlightUnion([base], {
      type: 'marginSynced',
      highlightId: 'h',
      note: 'sent',
      applyNote: false,
    }).highlights[0];
    expect(recorded).toMatchObject({ note: 'here', marginNote: 'sent' });
  });

  it('is a no-op when nothing would change', () => {
    const synced = { ...base, marginNote: 'here' };
    expect(
      mutateHighlightUnion([synced], {
        type: 'marginSynced',
        highlightId: 'h',
        note: 'here',
        applyNote: true,
      }).changed
    ).toBe(false);
  });
});
