import { describe, expect, it } from 'vitest';
import { planMarginHighlightImport } from './marginHighlightImport';
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
