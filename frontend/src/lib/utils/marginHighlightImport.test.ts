import { describe, expect, it } from 'vitest';
import {
  planMarginHighlightImport,
  planMarginHighlightRekeys,
  planMarginHighlightSync,
} from './marginHighlightImport';
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

describe('planMarginHighlightSync', () => {
  // TIDs for "long ago" and "just now", relative to the listing below.
  const LISTED_AT = Date.parse('2026-10-01T12:00:00.000Z');
  const OLD = tidAt(LISTED_AT - 60 * 60 * 1000);
  const FRESH = tidAt(LISTED_AT - 60 * 1000);

  function tidAt(ms: number): string {
    const S32 = '234567abcdefghijklmnopqrstuvwxyz';
    const value = (BigInt(ms) * 1000n) << 10n;
    let tid = '';
    for (let shift = 60n; shift >= 0n; shift -= 5n) tid += S32[Number((value >> shift) & 31n)];
    return tid;
  }

  function linked(rkey: string, overrides: Partial<Highlight> = {}) {
    return {
      itemKey: 'item',
      highlight: {
        id: `margin:${rkey}`,
        selector: { type: 'TextQuoteSelector' as const, exact: 'x' },
        createdAt: 1,
        marginRkey: rkey,
        marginUri: `at://did:plc:me/at.margin.note/${rkey}`,
        ...overrides,
      },
    };
  }

  function listing(notes: MarginHighlightNote[], rkeys?: string[], truncated = false) {
    return {
      notes,
      rkeys: rkeys ?? notes.map((n) => n.rkey),
      did: 'did:plc:me',
      truncated,
      listedAt: LISTED_AT,
    };
  }

  function asBefore(entries: { highlight: Highlight }[]) {
    return new Map(entries.map(({ highlight }) => [highlight.id, highlight]));
  }

  function plan(
    l: ReturnType<typeof listing>,
    entries: ReturnType<typeof linked>[],
    pending: Set<string> = new Set(),
    before = asBefore(entries),
    rkeys: Set<string> = new Set()
  ) {
    return planMarginHighlightSync(l, entries, { ids: pending, rkeys }, before);
  }

  it('takes a note edited on Margin', () => {
    const entries = [linked(OLD, { note: 'old thought' })];
    expect(plan(listing([note({ rkey: OLD, note: 'new thought' })]), entries)).toEqual([
      {
        kind: 'note',
        itemKey: 'item',
        highlightId: `margin:${OLD}`,
        rkey: OLD,
        note: 'new thought',
      },
    ]);
  });

  it('takes a note cleared on Margin', () => {
    const entries = [linked(OLD, { note: 'a thought' })];
    expect(plan(listing([note({ rkey: OLD })]), entries)).toEqual([
      { kind: 'note', itemKey: 'item', highlightId: `margin:${OLD}`, rkey: OLD, note: undefined },
    ]);
  });

  it('ignores whitespace-only differences in the note', () => {
    const entries = [linked(OLD, { note: 'same\n', marginNote: 'same' })];
    expect(plan(listing([note({ rkey: OLD, note: 'same' })]), entries)).toEqual([]);
  });

  it('records what Margin holds on a highlight linked before that was kept', () => {
    const entries = [linked(OLD, { note: 'same' })];
    expect(plan(listing([note({ rkey: OLD, note: 'same' })]), entries)).toEqual([
      { kind: 'synced', itemKey: 'item', highlightId: `margin:${OLD}`, rkey: OLD, note: 'same' },
    ]);
  });

  it('removes an imported highlight whose note was deleted on Margin', () => {
    expect(plan(listing([]), [linked(OLD)])).toEqual([
      { kind: 'remove', itemKey: 'item', highlightId: `margin:${OLD}` },
    ]);
  });

  it('only unpublishes a highlight made here whose note was deleted on Margin', () => {
    expect(plan(listing([]), [linked(OLD, { id: 'local-1' })])).toEqual([
      { kind: 'unlink', itemKey: 'item', highlightId: 'local-1' },
    ]);
  });

  it("doesn't read a deletion into a truncated listing", () => {
    expect(plan(listing([], [], true), [linked(OLD)])).toEqual([]);
  });

  it("doesn't read a deletion when the backend didn't list rkeys", () => {
    const l = { ...listing([]), rkeys: undefined };
    expect(
      planMarginHighlightSync(
        l,
        [linked(OLD)],
        { ids: new Set(), rkeys: new Set() },
        asBefore([linked(OLD)])
      )
    ).toEqual([]);
  });

  it('leaves a note that is still listed but no longer parses as a highlight', () => {
    expect(plan(listing([], [OLD]), [linked(OLD)])).toEqual([]);
  });

  it('gives a note made just before the listing time to show up', () => {
    expect(plan(listing([]), [linked(FRESH)])).toEqual([]);
  });

  it("doesn't date a record whose rkey isn't a TID", () => {
    expect(plan(listing([]), [linked('not-a-tid')])).toEqual([]);
  });

  it('leaves a note in some other repo alone', () => {
    const entries = [linked(OLD, { marginUri: `at://did:plc:other/at.margin.note/${OLD}` })];
    expect(plan(listing([]), entries)).toEqual([]);
  });

  it('skips a highlight with a Margin write of its own still queued', () => {
    const entries = [linked(OLD, { note: 'mine' })];
    const pending = new Set([`margin:${OLD}`]);
    expect(plan(listing([note({ rkey: OLD, note: 'theirs' })]), entries, pending)).toEqual([]);
    expect(plan(listing([]), entries, pending)).toEqual([]);
  });

  it('skips a note with a write of its own in flight or just sent', () => {
    const entries = [linked(OLD, { note: 'mine' })];
    const l = listing([note({ rkey: OLD, note: 'older' })]);
    expect(plan(l, entries, new Set(), asBefore(entries), new Set([OLD]))).toEqual([]);
    expect(plan(listing([]), entries, new Set(), asBefore(entries), new Set([OLD]))).toEqual([]);
  });

  it('skips a highlight whose note changed here while the listing was out', () => {
    const entries = [linked(OLD, { note: 'edited just now' })];
    const before = asBefore([linked(OLD, { note: 'before' })]);
    expect(
      plan(listing([note({ rkey: OLD, note: 'before' })]), entries, new Set(), before)
    ).toEqual([]);
  });

  it('skips a highlight that was linked only after the listing was asked for', () => {
    const entries = [linked(OLD, { id: 'local-1' })];
    const before = asBefore([{ highlight: { ...entries[0].highlight, marginRkey: undefined } }]);
    expect(plan(listing([]), entries, new Set(), before)).toEqual([]);
  });

  it('acts once on a highlight that shows up twice', () => {
    const entry = linked(OLD);
    expect(plan(listing([]), [entry, entry])).toHaveLength(1);
  });

  it("sends an edit made here that never reached Margin, rather than reading Margin's over it", () => {
    // Edited on another device, whose Margin write is queued there or was lost:
    // this device sees the edit, but nothing of it on its way.
    const entries = [linked(OLD, { note: 'new here', marginNote: 'old' })];
    expect(plan(listing([note({ rkey: OLD, note: 'old' })]), entries)).toEqual([
      {
        kind: 'push',
        itemKey: 'item',
        highlightId: `margin:${OLD}`,
        source: 'https://example.com/post?utm_source=x',
        title: 'A Post',
      },
    ]);
  });

  it('takes an edit made on Margin when the note here is still what Margin last had', () => {
    const entries = [linked(OLD, { note: 'old', marginNote: 'old' })];
    expect(plan(listing([note({ rkey: OLD, note: 'theirs' })]), entries)).toEqual([
      { kind: 'note', itemKey: 'item', highlightId: `margin:${OLD}`, rkey: OLD, note: 'theirs' },
    ]);
  });

  it('keeps the edit made here when a note was edited on both sides', () => {
    const entries = [linked(OLD, { note: 'mine', marginNote: 'old' })];
    expect(plan(listing([note({ rkey: OLD, note: 'theirs' })]), entries)).toEqual([
      {
        kind: 'push',
        itemKey: 'item',
        highlightId: `margin:${OLD}`,
        source: 'https://example.com/post?utm_source=x',
        title: 'A Post',
      },
    ]);
  });

  it('records that Margin caught up when both sides already agree', () => {
    const entries = [linked(OLD, { note: 'new', marginNote: 'old' })];
    expect(plan(listing([note({ rkey: OLD, note: 'new' })]), entries)).toEqual([
      { kind: 'synced', itemKey: 'item', highlightId: `margin:${OLD}`, rkey: OLD, note: 'new' },
    ]);
  });

  it('keeps an imported highlight with an unsent edit when its note is deleted on Margin', () => {
    const entries = [linked(OLD, { note: 'mine', marginNote: '' })];
    expect(plan(listing([]), entries)).toEqual([
      { kind: 'unlink', itemKey: 'item', highlightId: `margin:${OLD}` },
    ]);
  });

  it('leaves unlinked highlights alone', () => {
    const entries = [linked(OLD, { marginRkey: undefined, marginUri: undefined, id: 'plain' })];
    expect(plan(listing([]), entries)).toEqual([]);
  });
});
