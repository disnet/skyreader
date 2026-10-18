import { env } from 'cloudflare:test';
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

// Expected bytes and CIDs below are pinned, so a library upgrade that changed
// either would fail here rather than churn every record.
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

  it('refuses a lone surrogate rather than hashing it as U+FFFD', () => {
    expect(() => encodeDagCbor({ a: 'cut \ud83d' })).toThrow(/surrogate/);
    expect(() => encodeDagCbor({ ['\udc00']: 1 })).toThrow(/surrogate/);
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
  doi: null,
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
        doi: '10.1145/3290605.3300233',
      },
      { ...file, filename: null },
    ],
    [
      'values the record cannot carry natively',
      {
        ...baseSave,
        word_count: 12.5,
        published_at: -62167219200001,
        saved_at: 9e15,
        title: 42 as unknown as string,
      },
      { ...file, size: 1.5, created_at: -1 },
    ],
    ['dates before 1970', { ...baseSave, published_at: -86400000 }, null],
    ['non-ASCII text', { ...baseSave, title: 'Ünïcødé — 日本語 🐦', content: '\u0000￿' }, null],
    ['a lone surrogate', { ...baseSave, title: 'cut mid-emoji \ud83d' }, null],
  ];

  for (const [name, row, savedFile] of cases) {
    it(`round-trips losslessly: ${name}`, async () => {
      const { rkey, record } = saveToRecord(row, savedFile);
      // What a space would hand back: the record after a DAG-CBOR-safe JSON trip.
      const stored = JSON.parse(JSON.stringify(record));
      await recordCid(stored);
      expect(saveFromRecord(rkey, stored)).toEqual({ row, file: savedFile });
      // Decoding is the exact inverse, so the record (and its CID) is stable.
      const again = saveFromRecord(rkey, stored);
      expect(saveToRecord(again.row, again.file).record).toEqual(stored);
    });
  }

  it('carries a pre-1970 date natively, down to year 0000', () => {
    expect(saveToRecord({ ...baseSave, published_at: -86400000 }).record.publishedAt).toBe(
      '1969-12-31T00:00:00.000Z'
    );
    expect(saveToRecord({ ...baseSave, published_at: -62167219200000 }).record.publishedAt).toBe(
      '0000-01-01T00:00:00.000Z'
    );
  });

  it('refuses a non-finite number, which has no JSON form to carry it in', () => {
    expect(() => saveToRecord({ ...baseSave, word_count: Infinity })).toThrow(/no JSON form/);
  });

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

  it('accepts only the datetime form it writes', () => {
    const { rkey, record } = saveToRecord(baseSave);
    for (const savedAt of [
      'Jan 2 2026',
      '2026-01-02T00:00:00',
      '2026-01-02T00:00:00Z',
      '+275760-09-13T00:00:00.000Z',
    ]) {
      expect(() => saveFromRecord(rkey, { ...record, savedAt })).toThrow(/datetime/);
    }
  });

  it('keeps extra to columns it could not carry natively, and the rkey to the one given', () => {
    const { rkey, record } = saveToRecord(baseSave);
    const withExtra = (extra: object) => ({ ...record, extra: JSON.stringify(extra) });
    expect(() => saveFromRecord(rkey, withExtra({ rkey: '../x' }))).toThrow(/unknown column rkey/);
    expect(() => saveFromRecord(rkey, withExtra({ user_did: 'did:plc:other' }))).toThrow(
      /unknown column/
    );
    expect(() => saveFromRecord(rkey, withExtra({ id: 1 }))).toThrow(/unknown column/);
    expect(() =>
      saveFromRecord(
        rkey,
        JSON.parse('{"$type":"' + SAVE_COLLECTION + '","extra":"{\\"__proto__\\":1}"}')
      )
    ).toThrow(/unknown column __proto__/);
    // A column already in the record, or one its field could carry, isn't extra.
    expect(() => saveFromRecord(rkey, withExtra({ url: 'https://other.example' }))).toThrow(
      /belongs in url/
    );
    const { url: _url, ...noUrl } = record;
    expect(() =>
      saveFromRecord(rkey, { ...noUrl, extra: JSON.stringify({ url: 'https://other.example' }) })
    ).toThrow(/belongs in url/);
    expect(() => saveFromRecord(rkey, withExtra({ title: null }))).toThrow(/belongs in title/);
    expect(() => saveFromRecord(rkey, withExtra({}))).toThrow(/empty/);
    expect(() =>
      saveFromRecord(rkey, { ...record, title: undefined, extra: '{ "title": 42 }' })
    ).toThrow(/canonical/);
  });

  it('rejects a record missing a NOT NULL column', () => {
    const { rkey, record } = saveToRecord(baseSave, file);
    for (const field of ['url', 'savedAt', 'createdAt', 'source']) {
      const { [field]: _dropped, ...rest } = record;
      expect(() => saveFromRecord(rkey, rest)).toThrow(new RegExp(`${field} is missing`));
    }
    const { sha256: _sha, ...fileRest } = record.file as Record<string, unknown>;
    expect(() => saveFromRecord(rkey, { ...record, file: fileRest as never })).toThrow(
      /sha256 is missing/
    );
  });

  it('rejects a field it does not know, as highlights do', () => {
    const { rkey, record } = saveToRecord(baseSave, file);
    expect(() => saveFromRecord(rkey, { ...record, readingProgress: 3 })).toThrow(/unknown save/);
    expect(() =>
      saveFromRecord(rkey, { ...record, file: { ...(record.file as object), pages: 3 } })
    ).toThrow(/unknown file/);
  });

  it('refuses a row missing a column, rather than reading it as NULL', () => {
    const { url_normalized: _omitted, ...partial } = baseSave;
    expect(() => saveToRecord(partial as SaveRow)).toThrow(/missing column url_normalized/);
    expect(() => saveToRecord({ ...baseSave, source: null as never })).toThrow(/source is null/);
  });

  // The contract covers every column D1 has: a column added to saved_articles
  // but not to the record would be silently dropped by a space sync.
  it('carries every saved_articles column', async () => {
    const columns = (
      await env.DB.prepare('SELECT name FROM pragma_table_info(?)').bind('saved_articles').all<{
        name: string;
      }>()
    ).results.map((c) => c.name);
    const own = ['id', 'user_did'];
    const row = Object.fromEntries(
      columns.filter((c) => !own.includes(c)).map((c) => [c, c.endsWith('_at') ? 1 : 'x'])
    ) as unknown as SaveRow;
    row.rkey = '3mwhuiodre72s';
    const { rkey, record } = saveToRecord(row);
    expect(saveFromRecord(rkey, record).row).toEqual(row);
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

  it('derives different keys for ids that differ only in a lone surrogate', async () => {
    expect(await highlightRkey('a\ud800')).not.toBe(await highlightRkey('a\ud801'));
    expect(await highlightRkey('a\ud800')).not.toBe(await highlightRkey('a\ufffd'));
  });

  it('encodes the same highlight to the same record whatever its key order', async () => {
    const a = await highlightToRecord({
      itemKey: 'k',
      itemType: 'article',
      highlight: { id: 'x1', color: 'yellow', weights: [1, 2.5], meta: { b: 1, a: 2 } },
    });
    const b = await highlightToRecord({
      itemKey: 'k',
      itemType: 'article',
      highlight: { meta: { a: 2, b: 1 }, weights: [1, 2.5], color: 'yellow', id: 'x1' },
    });
    expect(a.record.extra).toBe(b.record.extra);
    expect(await recordCid(a.record)).toBe(await recordCid(b.record));
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
    ['a lone surrogate', { ...highlight, note: 'cut \ud83d' }],
    ['a __proto__ key', JSON.parse('{"id":"p1","createdAt":0,"__proto__":{"id":"x"}}')],
  ];
  const subjects: [string, string, string][] = [
    ['an item key cut mid-emoji', 'guid-\ud83d', 'article'],
  ];
  for (const [name, itemKey, itemType] of subjects) {
    it(`round-trips losslessly: ${name}`, async () => {
      const entry = { itemKey, itemType, highlight };
      const { rkey, record } = await highlightToRecord(entry);
      const stored = JSON.parse(JSON.stringify(record));
      await recordCid(stored);
      expect(await highlightFromRecord(rkey, stored)).toEqual(entry);
    });
  }

  for (const [name, value] of cases) {
    it(`round-trips losslessly: ${name}`, async () => {
      const entry = {
        itemKey: 'at://did:plc:me/app.skyreader.feed.saved/3k',
        itemType: 'saved',
        highlight: value as never,
      };
      const { rkey, record } = await highlightToRecord(entry);
      const stored = JSON.parse(JSON.stringify(record));
      await recordCid(stored);
      const decoded = await highlightFromRecord(rkey, stored);
      expect(decoded).toEqual(entry);
      expect(Object.getPrototypeOf(decoded.highlight)).toBe(Object.prototype);
      expect((await highlightToRecord(decoded)).record).toEqual(stored);
    });
  }

  it('reads every highlight out of a label row', () => {
    const entries = highlightEntriesFromLabel({
      item_key: 'guid-1',
      item_type: 'article',
      props: JSON.stringify({ highlights: [highlight, { ...highlight, id: 'two' }] }),
      deleted_at: null,
    });
    expect(entries.map((entry) => entry.highlight.id)).toEqual(['mkx1q2w3e4r5t6', 'two']);
    expect(
      highlightEntriesFromLabel({
        item_key: 'k',
        item_type: 'article',
        props: null,
        deleted_at: null,
      })
    ).toEqual([]);
  });

  it('reads nothing out of a soft-deleted label row, though its props remain', () => {
    const row = {
      item_key: 'guid-1',
      item_type: 'article',
      props: JSON.stringify({ highlights: [highlight] }),
    };
    expect(highlightEntriesFromLabel({ ...row, deleted_at: 1767312000 })).toEqual([]);
    expect(() => highlightEntriesFromLabel(row as never)).toThrow(/deleted_at/);
  });

  it('treats prototype keys as unknown fields', async () => {
    const { rkey, record } = await highlightToRecord({
      itemKey: 'k',
      itemType: 'article',
      highlight,
    });
    await expect(highlightFromRecord(rkey, { ...record, constructor: 'x' })).rejects.toThrow(
      /unknown highlight field constructor/
    );
    const { record: withToString } = await highlightToRecord({
      itemKey: 'k',
      itemType: 'article',
      highlight: { ...highlight, toString: 'x' },
    });
    expect(Object.hasOwn(withToString, 'toString')).toBe(false);
    expect(JSON.parse(withToString.extra as string)).toEqual({ toString: 'x' });
  });

  it('rejects extra that shadows or could be a native field', async () => {
    const { rkey, record } = await highlightToRecord({
      itemKey: 'k',
      itemType: 'article',
      highlight,
    });
    await expect(
      highlightFromRecord(rkey, { ...record, extra: JSON.stringify({ id: 'other' }) })
    ).rejects.toThrow(/extra.id/);
    await expect(
      highlightFromRecord(rkey, { ...record, extra: JSON.stringify({ color: 'yellow' }) })
    ).resolves.toBeTruthy();
  });

  it('rejects a record stored under a key its id does not derive', async () => {
    const { record } = await highlightToRecord({ itemKey: 'k', itemType: 'article', highlight });
    await expect(highlightFromRecord('abc', record)).rejects.toThrow(/not keyed abc/);
  });

  it('refuses a highlight without an id', async () => {
    await expect(
      highlightToRecord({ itemKey: 'k', itemType: 'article', highlight: { selector: null } })
    ).rejects.toThrow(/id/);
  });
});
