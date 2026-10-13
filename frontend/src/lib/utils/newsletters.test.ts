import { describe, expect, it } from 'vitest';
import { archiveTypeFilter, typeFilterShowsArchive } from './newsletters';

const feed = { sourceType: 'rss' as const, feedUrl: 'https://example.com/feed.xml' };
const legacyFeed = { sourceType: undefined, feedUrl: 'https://example.com/rss' };
const mail = { sourceType: 'email.newsletter' as const, feedUrl: 'newsletter:abc/a@b.com' };

describe('archiveTypeFilter', () => {
  it('keeps everything with no type filter or both archive types', () => {
    expect(archiveTypeFilter([])).toBeNull();
    expect(archiveTypeFilter(['rss', 'email.newsletter'])).toBeNull();
  });

  it("'rss' keeps feeds and drops newsletters", () => {
    const keep = archiveTypeFilter(['rss'])!;
    expect(keep(feed)).toBe(true);
    expect(keep(legacyFeed)).toBe(true);
    expect(keep(mail)).toBe(false);
    expect(keep(undefined)).toBe(true);
  });

  it("'email.newsletter' keeps only newsletters", () => {
    const keep = archiveTypeFilter(['email.newsletter', 'atproto.documents'])!;
    expect(keep(mail)).toBe(true);
    expect(keep({ feedUrl: 'newsletter:abc/x@y.com' })).toBe(true);
    expect(keep(feed)).toBe(false);
  });
});

describe('typeFilterShowsArchive', () => {
  it('is true unless the filter names only non-archive types', () => {
    expect(typeFilterShowsArchive([])).toBe(true);
    expect(typeFilterShowsArchive(['rss'])).toBe(true);
    expect(typeFilterShowsArchive(['email.newsletter'])).toBe(true);
    expect(typeFilterShowsArchive(['atproto.documents'])).toBe(false);
  });
});
