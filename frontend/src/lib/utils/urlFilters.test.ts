import { describe, it, expect } from 'vitest';
import { sameUrlFilters, type UrlFilters } from './urlFilters';

const base: UrlFilters = {
  feed: null,
  saved: 'true',
  sharer: null,
  following: null,
  feeds: null,
  contentType: null,
  view: null,
  category: null,
};

describe('sameUrlFilters', () => {
  it('sees an added ?read= as no view change (the reader must not reset the list)', () => {
    // The reader adds `read` to the URL; setFilters gets the same filter set back.
    expect(sameUrlFilters(base, { ...base })).toBe(true);
  });

  it('treats an absent optional field as null', () => {
    const withoutOptionals: UrlFilters = {
      feed: null,
      saved: 'true',
      sharer: null,
      following: null,
      feeds: null,
    };
    expect(sameUrlFilters(withoutOptionals, base)).toBe(true);
    expect(sameUrlFilters(base, withoutOptionals)).toBe(true);
  });

  it('detects every filter that does move the view', () => {
    const changes: Partial<UrlFilters>[] = [
      { feed: '12' },
      { saved: null },
      { sharer: 'did:plc:someone' },
      { following: 'true' },
      { feeds: '1,2' },
      { contentType: 'documents' },
      { view: 'channel-uuid' },
      { category: 'News' },
    ];
    for (const change of changes) {
      expect(sameUrlFilters({ ...base, ...change }, base)).toBe(false);
    }
  });
});
