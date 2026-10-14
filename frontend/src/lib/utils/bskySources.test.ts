import { describe, it, expect } from 'vitest';
import { bskySourceKind, isBskySourceSubscription, keptPostLinkCard } from './bskySources';
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

describe('keptPostLinkCard', () => {
  const lead =
    '<blockquote><p>So @attie.ai is pretty neat.<br>Ten seconds later got: attie.ai/@disnetdev.c&hellip;</p></blockquote>' +
    '<p>— Tim (@disnetdev.com) <a href="https://bsky.app/x">on Bluesky</a></p>';

  it("draws the post's embed card: title, blurb, site and thumbnail", () => {
    expect(
      keptPostLinkCard({
        url: 'https://www.example.com/dark-mode',
        title: 'The Dark Mode Toggle Discourse',
        summary: 'Everyone has opinions.',
        imageUrl: 'https://cdn.example/thumb.jpg',
        leadHtml: lead,
      })
    ).toEqual({
      title: 'The Dark Mode Toggle Discourse',
      description: 'Everyone has opinions.',
      thumb: 'https://cdn.example/thumb.jpg',
      domain: 'example.com',
    });
  });

  it("doesn't repeat the post's words when the post had no embed card", () => {
    const card = keptPostLinkCard({
      url: 'https://attie.ai/@disnetdev.com/thing',
      title: 'So @attie.ai is pretty neat.',
      summary: 'So @attie.ai is pretty neat.\nTen seconds later got: attie.ai/@disnetdev.c…',
      leadHtml: lead,
    });
    expect(card.title).toBe('attie.ai/@disnetdev.com/thing');
    expect(card.description).toBeNull();
    expect(card.thumb).toBeNull();
  });

  it('names the link when the title is only its host', () => {
    const card = keptPostLinkCard({ url: 'https://example.com/', title: 'example.com' });
    expect(card.title).toBe('example.com');
    expect(card.domain).toBe('example.com');
  });
});
