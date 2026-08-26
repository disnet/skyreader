import { describe, expect, it } from 'vitest';
import { planMarginHighlightImport, planMarginHighlightRekeys } from './marginHighlightImport';
import type { Highlight, MarginHighlightNote } from '$lib/types';

let counter = 0;
const makeId = () => `generated-${++counter}`;

function note(overrides: Partial<MarginHighlightNote> = {}): MarginHighlightNote {
  return {
    uri: 'at://did:plc:me/at.margin.note/rk1',
    rkey: 'rk1',
    url: 'https://example.com/post?utm_source=x',
    urlNormalized: 'https://example.com/post',
    title: 'A Post',
    selector: { type: 'TextQuoteSelector', exact: 'a quote' },
    createdAt: '2026-08-01T00:00:00.000Z',
    match: null,
    ...overrides,
  };
}

function existing(marginRkey?: string): { highlight: Highlight } {
  return {
    highlight: {
      id: 'local',
      selector: { type: 'TextQuoteSelector', exact: 'x' },
      createdAt: 1,
      ...(marginRkey ? { marginRkey } : {}),
    },
  };
}

describe('planMarginHighlightImport', () => {
  it('imports a new note, carrying its Margin identity and source metadata', () => {
    const groups = planMarginHighlightImport([note()], [], [], makeId);
    expect(groups).toHaveLength(1);
    expect(groups[0].itemKey).toBe('https://example.com/post');
    expect(groups[0].highlights[0]).toMatchObject({
      selector: { type: 'TextQuoteSelector', exact: 'a quote' },
      createdAt: Date.parse('2026-08-01T00:00:00.000Z'),
      marginUri: 'at://did:plc:me/at.margin.note/rk1',
      marginRkey: 'rk1',
      sourceUrl: 'https://example.com/post?utm_source=x',
      sourceTitle: 'A Post',
    });
  });

  it('skips notes already present locally — including ones Skyreader pushed out', () => {
    expect(planMarginHighlightImport([note()], [existing('rk1')], [], makeId)).toEqual([]);
  });

  it('imports a duplicate rkey in one poll only once', () => {
    const groups = planMarginHighlightImport([note(), note()], [], [], makeId);
    expect(groups).toHaveLength(1);
    expect(groups[0].highlights).toHaveLength(1);
  });

  it('keys a matched note by the save canonical key, not the URL', () => {
    const uri = 'at://did:plc:me/app.skyreader.feed.saved/s1';
    const groups = planMarginHighlightImport(
      [note({ match: { itemGuid: 'guid-1', uri } })],
      [],
      [{ itemGuid: 'guid-1', uri }],
      makeId
    );
    expect(groups[0].itemKey).toBe('guid-1');
  });

  it('falls back to the record uri when the save has no guid', () => {
    const uri = 'at://did:plc:me/app.skyreader.feed.saved/s1';
    const groups = planMarginHighlightImport(
      [note({ match: { itemGuid: null, uri } })],
      [],
      [{ itemGuid: undefined, uri }],
      makeId
    );
    expect(groups[0].itemKey).toBe(uri);
  });

  it('groups several notes from the same article into one write', () => {
    const groups = planMarginHighlightImport(
      [
        note({ rkey: 'a', uri: 'at://did:plc:me/at.margin.note/a' }),
        note({ rkey: 'b', uri: 'at://did:plc:me/at.margin.note/b' }),
        note({
          rkey: 'c',
          uri: 'at://did:plc:me/at.margin.note/c',
          url: 'https://other.test/x',
          urlNormalized: 'https://other.test/x',
        }),
      ],
      [],
      [],
      makeId
    );
    expect(groups).toHaveLength(2);
    expect(groups[0].highlights).toHaveLength(2);
    expect(groups[1].highlights).toHaveLength(1);
  });

  // The group's itemType decides which cache resolveHighlightSource looks in, so
  // writing every import as 'article' would file a saved document's highlight
  // under a type the document lookup never reads.
  it('types a matched group by the kind of save it landed on', () => {
    const uri = 'at://did:plc:me/app.skyreader.feed.saved/s1';
    const document = planMarginHighlightImport(
      [note({ match: { itemGuid: null, uri } })],
      [],
      [{ itemGuid: undefined, uri, source: 'document' }],
      makeId
    );
    expect(document[0].itemType).toBe('document');

    const bareUrl = planMarginHighlightImport(
      [note({ match: { itemGuid: 'guid-1', uri } })],
      [],
      [{ itemGuid: 'guid-1', uri, source: 'url' }],
      makeId
    );
    expect(bareUrl[0].itemType).toBe('saved');

    const fromFeed = planMarginHighlightImport(
      [note({ match: { itemGuid: 'guid-1', uri } })],
      [],
      [{ itemGuid: 'guid-1', uri, source: 'feed' }],
      makeId
    );
    expect(fromFeed[0].itemType).toBe('article');
  });

  it('leaves an unmatched note an article — there is no local item to take a type from', () => {
    expect(planMarginHighlightImport([note()], [], [], makeId)[0].itemType).toBe('article');
  });

  it('falls back to now when the record carries no usable createdAt', () => {
    const before = Date.now();
    const groups = planMarginHighlightImport([note({ createdAt: 'not a date' })], [], [], makeId);
    expect(groups[0].highlights[0].createdAt).toBeGreaterThanOrEqual(before);
  });

  it('omits an absent note body and title rather than writing empty fields', () => {
    const groups = planMarginHighlightImport(
      [note({ note: undefined, title: undefined })],
      [],
      [],
      makeId
    );
    expect(groups[0].highlights[0]).not.toHaveProperty('note');
    expect(groups[0].highlights[0]).not.toHaveProperty('sourceTitle');
  });
});

describe('imported highlight ids', () => {
  // Two devices can both poll before either one's label write has synced down,
  // so both see an empty `knownRkeys` and both import the same note. Ids are
  // what the union merges on, so a random id would leave two copies of the same
  // passage alive forever.
  it('derives the id from the Margin rkey, so a double import converges', () => {
    const deviceA = planMarginHighlightImport([note()], [], []);
    const deviceB = planMarginHighlightImport([note()], [], []);
    expect(deviceA[0].highlights[0].id).toBe('margin:rk1');
    expect(deviceB[0].highlights[0].id).toBe(deviceA[0].highlights[0].id);
  });

  it('gives distinct notes distinct ids', () => {
    const groups = planMarginHighlightImport(
      [note(), note({ rkey: 'rk2', uri: 'at://did:plc:me/at.margin.note/rk2' })],
      [],
      []
    );
    const ids = groups.flatMap((group) => group.highlights.map((h) => h.id));
    expect(ids).toEqual(['margin:rk1', 'margin:rk2']);
  });
});

describe('planMarginHighlightRekeys', () => {
  const uri = 'at://did:plc:me/app.skyreader.feed.saved/s1';
  const saves = [{ itemGuid: 'guid-1', uri }];

  /** A highlight already imported under the URL key, before any save existed. */
  function stranded(rkey = 'rk1', itemKey = 'https://example.com/post') {
    return {
      itemKey,
      highlight: {
        id: `margin:${rkey}`,
        selector: { type: 'TextQuoteSelector' as const, exact: 'a quote' },
        createdAt: 1,
        marginRkey: rkey,
        lastReviewedAt: 500,
      },
    };
  }

  // The import is idempotent on the rkey, so without this pass a note imported
  // before its article was saved would sit under a URL key forever: no
  // highlight on the article in the reader, and a group of its own in the list.
  it('moves a URL-keyed import onto the save that now matches it', () => {
    const rekeys = planMarginHighlightRekeys(
      [note({ match: { itemGuid: 'guid-1', uri } })],
      [stranded()],
      saves
    );
    expect(rekeys).toHaveLength(1);
    expect(rekeys[0].from).toBe('https://example.com/post');
    expect(rekeys[0].to).toBe('guid-1');
  });

  it('types the destination group by the save it is moving onto', () => {
    const rekeys = planMarginHighlightRekeys(
      [note({ match: { itemGuid: 'guid-1', uri } })],
      [stranded()],
      [{ itemGuid: 'guid-1', uri, source: 'document' }]
    );
    expect(rekeys[0].itemType).toBe('document');
  });

  it('carries the local highlight across, not a fresh one built from the note', () => {
    const rekeys = planMarginHighlightRekeys(
      [note({ match: { itemGuid: 'guid-1', uri } })],
      [stranded()],
      saves
    );
    // Review state rides the highlight, so rebuilding it here would silently
    // make an already-reviewed highlight due again.
    expect(rekeys[0].highlights[0].lastReviewedAt).toBe(500);
  });

  it('leaves a highlight that is already home alone, whichever alias it sits on', () => {
    expect(
      planMarginHighlightRekeys(
        [note({ match: { itemGuid: 'guid-1', uri } })],
        [stranded('rk1', 'guid-1')],
        saves
      )
    ).toEqual([]);
    // The save's record uri and its guid are the same item — moving between
    // them is churn, not a fix.
    expect(
      planMarginHighlightRekeys(
        [note({ match: { itemGuid: 'guid-1', uri } })],
        [stranded('rk1', uri)],
        saves
      )
    ).toEqual([]);
  });

  it('never moves a highlight off a key just because the match went away', () => {
    // The reader unsaved the article. Shuttling it back to a URL key would only
    // undo itself the next time they save it.
    expect(planMarginHighlightRekeys([note({ match: null })], [stranded()], saves)).toEqual([]);
  });

  it('ignores notes with nothing local to move', () => {
    expect(
      planMarginHighlightRekeys([note({ match: { itemGuid: 'guid-1', uri } })], [], saves)
    ).toEqual([]);
  });

  // marginRkey means "there is a record for this", not "this came from there" —
  // Skyreader stamps it on its own highlights the moment they're pushed out. A
  // native highlight's key is the article it was made on, so moving it onto a
  // later save of the same URL would tear it off that article and out of the
  // reader's view of it.
  it('never moves a highlight Skyreader made and pushed out', () => {
    const native = {
      itemKey: 'feed-article-guid',
      highlight: {
        id: 'local-abc',
        selector: { type: 'TextQuoteSelector' as const, exact: 'a quote' },
        createdAt: 1,
        marginRkey: 'rk1',
        marginUri: 'at://did:plc:me/at.margin.note/rk1',
      },
    };
    // The reader highlighted a feed article, saved that highlight to Margin,
    // then later saved the same URL — which mints a different itemGuid.
    expect(
      planMarginHighlightRekeys([note({ match: { itemGuid: 'guid-1', uri } })], [native], saves)
    ).toEqual([]);
  });

  it('groups several stranded highlights of one article into a single move', () => {
    const rekeys = planMarginHighlightRekeys(
      [
        note({ match: { itemGuid: 'guid-1', uri } }),
        note({
          rkey: 'rk2',
          uri: 'at://did:plc:me/at.margin.note/rk2',
          match: { itemGuid: 'guid-1', uri },
        }),
      ],
      [stranded('rk1'), stranded('rk2')],
      saves
    );
    expect(rekeys).toHaveLength(1);
    expect(rekeys[0].highlights).toHaveLength(2);
  });
});
