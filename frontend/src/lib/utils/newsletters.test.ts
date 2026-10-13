import { describe, expect, it } from 'vitest';
import { archiveTypeFilter, typeFilterShowsArchive } from './newsletters';

const feed = { sourceType: 'rss' as const, feedUrl: 'https://example.com/feed.xml' };
const legacyFeed = { sourceType: undefined, feedUrl: 'https://example.com/rss' };
const mail = { sourceType: 'email.newsletter' as const, feedUrl: 'newsletter:abc/a@b.com' };
const likes = { sourceType: 'bsky.likes' as const, feedUrl: 'bsky-likes:did:plc:me' };
const bookmarks = { sourceType: 'bsky.bookmarks' as const, feedUrl: 'bsky-bookmarks:did:plc:me' };

describe('archiveTypeFilter', () => {
  it('keeps everything with no type filter or both archive types', () => {
    expect(archiveTypeFilter([])).toBeNull();
    expect(
      archiveTypeFilter(['rss', 'email.newsletter', 'bsky.likes', 'bsky.bookmarks'])
    ).toBeNull();
  });

  it("'rss' leaves Bluesky likes and bookmarks out", () => {
    const keep = archiveTypeFilter(['rss', 'email.newsletter'])!;
    expect(keep(feed)).toBe(true);
    expect(keep(mail)).toBe(true);
    expect(keep(likes)).toBe(false);
    expect(keep(bookmarks)).toBe(false);
  });

  it('a Bluesky type keeps only that source', () => {
    const keep = archiveTypeFilter(['bsky.likes'])!;
    expect(keep(likes)).toBe(true);
    expect(keep({ feedUrl: 'bsky-likes:did:plc:me' })).toBe(true);
    expect(keep(bookmarks)).toBe(false);
    expect(keep(feed)).toBe(false);
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
    expect(typeFilterShowsArchive(['bsky.bookmarks'])).toBe(true);
    expect(typeFilterShowsArchive(['atproto.documents'])).toBe(false);
  });
});
