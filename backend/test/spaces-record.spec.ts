import { describe, it, expect } from 'vitest';
import {
  diffSavedRecords,
  savedRowToSpaceRecord,
  type SavedRowForSpace,
} from '../src/services/spaces/record';
import {
  formatSpaceRef,
  parseSpaceRef,
  savedSpaceRef,
  spaceRecordUri,
  SAVED_COLLECTION,
} from '../src/services/spaces/refs';

// Phase 1 of the atproto Spaces saves spike: the pure D1-row -> space-record
// mapping and the drift diff behind the dev read-back route.

const DID = 'did:plc:spacerecord';

function row(overrides: Partial<SavedRowForSpace> = {}): SavedRowForSpace {
  return {
    rkey: '3laaaaaaaaaaa',
    url: 'https://example.com/article',
    title: 'An article',
    author: 'A. Writer',
    description: 'A short summary.',
    content_type: 'webpage',
    domain: 'example.com',
    image: 'https://example.com/hero.png',
    word_count: 1234,
    published_at: Date.UTC(2026, 0, 2, 3, 4, 5),
    saved_at: Date.UTC(2026, 1, 3, 4, 5, 6),
    source: 'url',
    item_guid: null,
    ...overrides,
  };
}

describe('savedRowToSpaceRecord', () => {
  it('maps a full row, converting epoch ms to ISO datetimes', () => {
    const record = savedRowToSpaceRecord(row());

    expect(record).toEqual({
      $type: SAVED_COLLECTION,
      url: 'https://example.com/article',
      title: 'An article',
      author: 'A. Writer',
      description: 'A short summary.',
      contentType: 'webpage',
      domain: 'example.com',
      image: 'https://example.com/hero.png',
      wordCount: 1234,
      publishedAt: '2026-01-02T03:04:05.000Z',
      savedAt: '2026-02-03T04:05:06.000Z',
      source: 'url',
    });
  });

  it('omits null and empty fields entirely rather than emitting nulls', () => {
    const record = savedRowToSpaceRecord(
      row({
        title: null,
        author: '',
        description: '   ',
        image: null,
        word_count: null,
        published_at: null,
        item_guid: null,
      })
    );

    expect(Object.keys(record).sort()).toEqual(
      ['$type', 'contentType', 'domain', 'savedAt', 'source', 'url'].sort()
    );
    expect('title' in record).toBe(false);
    expect('publishedAt' in record).toBe(false);
  });

  it('never carries the article body — content is not even an input', () => {
    // The row type has no `content`, so a body cannot reach the record by
    // accident. Belt and braces: an extra property on the row is ignored.
    const withBody = { ...row(), content: '<p>The whole article</p>' } as SavedRowForSpace;
    const record = savedRowToSpaceRecord(withBody) as Record<string, unknown>;

    expect(record.content).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain('The whole article');
  });

  it('drops junk timestamps instead of emitting an invalid datetime', () => {
    const record = savedRowToSpaceRecord(row({ published_at: Number.NaN }));
    expect('publishedAt' in record).toBe(false);
  });

  it('falls back to now when saved_at is unusable, since savedAt is required', () => {
    const record = savedRowToSpaceRecord(row({ saved_at: Number.POSITIVE_INFINITY }));
    expect(() => new Date(record.savedAt).toISOString()).not.toThrow();
    expect(Number.isNaN(new Date(record.savedAt).getTime())).toBe(false);
  });

  it('keeps a share save with no URL valid', () => {
    const record = savedRowToSpaceRecord(row({ url: '', source: 'share', content_type: 'share' }));
    expect('url' in record).toBe(false);
    expect(record.source).toBe('share');
    expect(record.savedAt).toBeTruthy();
  });

  it('rounds a fractional word count and drops a negative one', () => {
    expect(savedRowToSpaceRecord(row({ word_count: 10.6 })).wordCount).toBe(11);
    expect('wordCount' in savedRowToSpaceRecord(row({ word_count: -1 }))).toBe(false);
  });
});

describe('space refs', () => {
  it('formats and parses the alpha space-ref shape', () => {
    const ref = savedSpaceRef(DID);
    expect(ref).toBe(`at://${DID}/space/app.skyreader.space.saved/self`);

    const parsed = parseSpaceRef(ref);
    expect(parsed).toEqual({
      authority: DID,
      type: 'app.skyreader.space.saved',
      skey: 'self',
      uri: ref,
    });
  });

  it('rejects a plain record at-uri', () => {
    expect(parseSpaceRef(`at://${DID}/app.skyreader.feed.saved/3laaaaaaaaaaa`)).toBeNull();
    expect(parseSpaceRef('not-a-uri')).toBeNull();
  });

  it('addresses a record inside a space', () => {
    expect(spaceRecordUri(formatSpaceRef(DID, 'x.y.z', 'self'), DID, SAVED_COLLECTION, 'r1')).toBe(
      `at://${DID}/space/x.y.z/self/${DID}/${SAVED_COLLECTION}/r1`
    );
  });
});

describe('diffSavedRecords', () => {
  it('reports nothing when the mirror matches D1', () => {
    const rows = [row({ rkey: 'a' }), row({ rkey: 'b', url: 'https://example.com/b' })];
    const records = rows.map((r) => ({
      rkey: r.rkey,
      value: savedRowToSpaceRecord(r) as unknown as Record<string, unknown>,
    }));

    expect(diffSavedRecords(rows, records)).toEqual({
      onlyInD1: [],
      onlyInSpace: [],
      mismatched: [],
    });
  });

  it('reports a save the mirror never got', () => {
    const rows = [row({ rkey: 'a' }), row({ rkey: 'b' })];
    const records = [
      { rkey: 'a', value: savedRowToSpaceRecord(rows[0]) as unknown as Record<string, unknown> },
    ];

    const diff = diffSavedRecords(rows, records);
    expect(diff.onlyInD1).toEqual(['b']);
    expect(diff.onlyInSpace).toEqual([]);
  });

  it('reports a record left behind by a delete that never propagated', () => {
    const diff = diffSavedRecords([], [{ rkey: 'ghost', value: { $type: SAVED_COLLECTION } }]);
    expect(diff.onlyInSpace).toEqual(['ghost']);
  });

  it('reports the field that drifted — e.g. a content upgrade the mirror skipped', () => {
    const r = row({ rkey: 'a', word_count: 900 });
    const stale = savedRowToSpaceRecord(row({ rkey: 'a', word_count: 100 }));

    const diff = diffSavedRecords(
      [r],
      [{ rkey: 'a', value: stale as unknown as Record<string, unknown> }]
    );

    expect(diff.mismatched).toEqual([{ rkey: 'a', field: 'wordCount', d1: 900, space: 100 }]);
  });
});
