import { describe, it, expect } from 'vitest';
import { encodeDagCbor, recordCid } from '../src/services/archive/dag-cbor';
import {
  HIGHLIGHT_COLLECTION,
  SAVE_COLLECTION,
  highlightEntriesFromLabel,
  highlightFromRecord,
  highlightRkey,
  highlightToRecord,
  isRecordKey,
  saveFromRecord,
  saveToRecord,
  type SaveRow,
  type SavedFileRow,
} from '../src/services/archive/records';

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

// Expected bytes and CIDs below were produced by @ipld/dag-cbor + multiformats
// (the reference implementation) from the same values.
describe('DAG-CBOR + CID', () => {
  it('matches the reference encoding: key order, integer widths, UTF-8, nesting', async () => {
    const value = {
      $type: 'app.skyreader.archive.save',
      url: 'https://example.com/é',
      wordCount: 4294967296,
      savedAt: '2026-01-02T03:04:05.678Z',
      neg: -500,
      z: [true, false, null, ''],
      aa: { b: 1, a: 300 },
    };
    expect(hex(encodeDagCbor(value))).toBe(
      'a7617a84f5f4f660626161a2616119012c616201636e65673901f36375726c7668747470733a2f2f6578616d706c652e636f6d2fc3a9652474797065781a6170702e736b797265616465722e617263686976652e7361766567736176656441747818323032362d30312d30325430333a30343a30352e3637385a69776f7264436f756e741b0000000100000000'
    );
    expect(await recordCid(value)).toBe(
      'bafyreig3aoqh6apw7utognxr533q7ow4bybyfjyxws35jle3ig42lfsstu'
    );
    expect(await recordCid({})).toBe('bafyreigbtj4x7ip5legnfznufuopl4sg4knzc2cof6duas4b3q2fy6swua');
  });

  it('drops undefined fields, like an absent field', () => {
    expect(hex(encodeDagCbor({ a: undefined, b: 1 }))).toBe(hex(encodeDagCbor({ b: 1 })));
  });

  it('refuses floats, which the atproto data model does not have', () => {
    expect(() => encodeDagCbor({ a: 1.5 })).toThrow(/safe integer/);
  });
});

const baseSave: SaveRow = {
  rkey: '3mwhuiodre72s',
  record_uri: 'at://did:plc:me/app.skyreader.feed.saved/3mwhuiodre72s',
  url: 'https://example.com/post',
  url_normalized: null,
  title: 'A post',
  author: null,
  description: '',
  content: '<p>Body</p>',
  content_type: 'webpage',
  domain: 'example.com',
  image: null,
  word_count: 1,
  published_at: 1767225600000,
  saved_at: 1767312000123,
  created_at: 1767312000123,
  updated_at: null,
  source: 'url',
  item_guid: null,
};

const file: SavedFileRow = {
  r2_key: 'did:plc:me/3mwhuiodre72s.pdf',
  filename: 'paper.pdf',
  mime_type: 'application/pdf',
  size: 12345,
  sha256: 'ab'.repeat(32),
  created_at: 1767312000999,
};

describe('saves', () => {
  it('maps a row to a record shaped like the lexicon, keyed by its rkey', async () => {
    const { rkey, record } = saveToRecord(baseSave);
    expect(rkey).toBe('3mwhuiodre72s');
    expect(record).toEqual({
      $type: SAVE_COLLECTION,
      legacyUri: 'at://did:plc:me/app.skyreader.feed.saved/3mwhuiodre72s',
      url: 'https://example.com/post',
      title: 'A post',
      description: '',
      content: '<p>Body</p>',
      contentType: 'webpage',
      domain: 'example.com',
      wordCount: 1,
      publishedAt: '2026-01-01T00:00:00.000Z',
      savedAt: '2026-01-02T00:00:00.123Z',
      createdAt: '2026-01-02T00:00:00.123Z',
      source: 'url',
    });
    expect(await recordCid(record)).toBe(
      'bafyreiecopxhoeqt2z4bvp2ubv3gr2ucz44ykrim4yadikisr5tqelj5fy'
    );
  });

  const cases: [string, SaveRow, SavedFileRow | null][] = [
    ['an ordinary save', baseSave, null],
    [
      'an upload: no URL, a kept file',
      { ...baseSave, url: '', source: 'upload', content_type: 'pdf', record_uri: null },
      file,
    ],
    [
      'every nullable column null',
      {
        ...baseSave,
        record_uri: null,
        title: null,
        description: null,
        content: null,
        content_type: null,
        domain: null,
        word_count: null,
        published_at: null,
      },
      null,
    ],
    [
      'every column set',
      {
        ...baseSave,
        url_normalized: 'example.com/post',
        author: 'Ada',
        image: 'https://example.com/i.png',
        updated_at: 1767312999000,
        source: 'feed',
        item_guid: 'guid-1',
      },
      { ...file, filename: null },
    ],
    [
      'values the record cannot carry natively',
      {
        ...baseSave,
        word_count: 12.5,
        published_at: -86400000,
        saved_at: 9e15,
        title: 42 as unknown as string,
      },
      { ...file, size: 1.5, created_at: -1 },
    ],
    ['non-ASCII text', { ...baseSave, title: 'Ünïcødé — 日本語 🐦', content: '\u0000￿' }, null],
  ];

  for (const [name, row, savedFile] of cases) {
    it(`round-trips losslessly: ${name}`, async () => {
      const { rkey, record } = saveToRecord(row, savedFile);
      // What a space would hand back: the record after a DAG-CBOR-safe JSON trip.
      const stored = JSON.parse(JSON.stringify(record));
      await recordCid(stored);
      expect(saveFromRecord(rkey, stored)).toEqual({ row, file: savedFile });
    });
  }

  it('carries what it cannot represent in extra, not in the native field', () => {
    const { record } = saveToRecord({ ...baseSave, word_count: 12.5 });
    expect(record.wordCount).toBeUndefined();
    expect(JSON.parse(record.extra as string)).toEqual({ word_count: 12.5 });
  });

  it('rejects a record of another type or a malformed field', () => {
    const { rkey, record } = saveToRecord(baseSave);
    expect(() => saveFromRecord(rkey, { ...record, $type: HIGHLIGHT_COLLECTION })).toThrow();
    expect(() => saveFromRecord(rkey, { ...record, savedAt: 'yesterday' })).toThrow(/datetime/);
    expect(() => saveFromRecord(rkey, { ...record, wordCount: '1' })).toThrow(/integer/);
  });
});

const highlight = {
  id: 'mkx1q2w3e4r5t6',
  selector: { type: 'TextQuoteSelector', exact: 'quoted', prefix: 'the ', suffix: ' text' },
  createdAt: 1767312000123,
  note: 'A margin note',
  marginUri: 'at://did:plc:me/at.margin.note/3abc',
  marginRkey: '3abc',
  lastReviewedAt: 1767398400000,
  reviewIntent: 'soon',
  sourceUrl: 'https://example.com/post',
  sourceTitle: 'A post',
};

describe('highlights and their notes', () => {
  it('maps a highlight to a record keyed by its id, carrying its item and note', async () => {
    const { rkey, record } = await highlightToRecord({
      itemKey: 'guid-1',
      itemType: 'article',
      highlight,
    });
    expect(rkey).toBe('mkx1q2w3e4r5t6');
    expect(record).toEqual({
      $type: HIGHLIGHT_COLLECTION,
      subject: { itemKey: 'guid-1', itemType: 'article' },
      ...highlight,
      createdAt: '2026-01-02T00:00:00.123Z',
      lastReviewedAt: '2026-01-03T00:00:00.000Z',
    });
    expect(record.extra).toBeUndefined();
    expect(await recordCid(record)).toBe(
      'bafyreia6yxccnhjgbtpd674pmmtqhovq5b4mtbj67yktio5kjhc2slvime'
    );
  });

  it('uses a Margin import id as its key as-is', async () => {
    expect(await highlightRkey('margin:3abc')).toBe('margin:3abc');
  });

  it('derives a stable key for an id that is not a record key', async () => {
    const key = await highlightRkey('has spaces/and slashes');
    expect(isRecordKey(key)).toBe(true);
    expect(key).toMatch(/^h-[0-9a-f]{32}$/);
    expect(await highlightRkey('has spaces/and slashes')).toBe(key);
  });

  const cases: [string, Record<string, unknown>][] = [
    ['a full highlight', highlight],
    [
      'a bare highlight',
      { id: 'abc123', selector: { type: 'TextQuoteSelector', exact: 'x' }, createdAt: 0 },
    ],
    ['an unknown field from a newer client', { ...highlight, color: 'yellow', weights: [1, 2.5] }],
    ['a null where a string belongs', { ...highlight, note: null }],
    ['a float timestamp', { ...highlight, createdAt: 1767312000123.5 }],
    ['a selector with extra keys', { ...highlight, selector: { type: 'X', exact: 'y', start: 3 } }],
  ];

  for (const [name, value] of cases) {
    it(`round-trips losslessly: ${name}`, async () => {
      const entry = {
        itemKey: 'at://did:plc:me/app.skyreader.feed.saved/3k',
        itemType: 'saved',
        highlight: value as never,
      };
      const { record } = await highlightToRecord(entry);
      const stored = JSON.parse(JSON.stringify(record));
      await recordCid(stored);
      expect(highlightFromRecord(stored)).toEqual(entry);
    });
  }

  it('reads every highlight out of a label row', () => {
    const entries = highlightEntriesFromLabel({
      item_key: 'guid-1',
      item_type: 'article',
      props: JSON.stringify({ highlights: [highlight, { ...highlight, id: 'two' }] }),
    });
    expect(entries.map((entry) => entry.highlight.id)).toEqual(['mkx1q2w3e4r5t6', 'two']);
    expect(highlightEntriesFromLabel({ item_key: 'k', item_type: 'article', props: null })).toEqual(
      []
    );
  });

  it('refuses a highlight without an id', async () => {
    await expect(
      highlightToRecord({ itemKey: 'k', itemType: 'article', highlight: { selector: null } })
    ).rejects.toThrow(/id/);
  });
});
