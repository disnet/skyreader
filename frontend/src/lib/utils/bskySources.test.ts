import { describe, it, expect } from 'vitest';
import { bskySourceKind, isBskySourceSubscription } from './bskySources';
import { isArchiveFeedSource } from './newsletters';

describe('Bluesky likes / bookmarks sources', () => {
  it('are archive feeds, so the timeline, unread counts and channels read them', () => {
    expect(isArchiveFeedSource('bsky.likes')).toBe(true);
    expect(isArchiveFeedSource('bsky.bookmarks')).toBe(true);
    expect(isArchiveFeedSource('atproto.documents')).toBe(false);
  });

  it('are recognized by source type or by feed URL', () => {
    expect(isBskySourceSubscription({ sourceType: 'bsky.likes', feedUrl: undefined })).toBe(true);
    expect(isBskySourceSubscription({ feedUrl: 'bsky-bookmarks:did:plc:a' })).toBe(true);
    expect(isBskySourceSubscription({ feedUrl: 'https://example.com/feed' })).toBe(false);
  });

  it('name their kind', () => {
    expect(bskySourceKind({ feedUrl: 'bsky-likes:did:plc:a' })).toBe('likes');
    expect(bskySourceKind({ sourceType: 'bsky.bookmarks' })).toBe('bookmarks');
    expect(bskySourceKind({ sourceType: 'rss', feedUrl: 'https://x.example' })).toBeNull();
  });
});
