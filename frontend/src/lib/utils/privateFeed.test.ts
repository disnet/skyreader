import { describe, it, expect } from 'vitest';
import { privateFeedSignal } from './privateFeed';

describe('privateFeedSignal', () => {
  it.each([
    ['https://user:hunter2@example.com/feed.xml', 'credentials'],
    ['https://example.com/feed.xml?token=abc123', 'token'],
    ['https://example.com/rss?access_token=abc', 'token'],
    ['https://example.com/rss?feed_key=abc', 'token'],
    ['https://example.com/rss?apiKey=abc', 'token'],
    ['https://steadyhq.com/rss/show?auth=abc', 'token'],
    ['https://github.com/me.private.atom?token=AAAA', 'token'],
    ['https://www.patreon.com/rss/creator?auth=x', 'token'],
    ['https://www.patreon.com/rss/creator', 'member-host'],
    ['https://show.supercast.com/feeds/abcdef123456', 'member-host'],
    ['https://example.memberful.com/rss/abc', 'member-host'],
    ['https://kill-the-newsletter.com/feeds/abc123.xml', 'member-host'],
    ['https://api.substack.com/feed/podcast/123/private/0f1e2d3c.rss', 'private-path'],
    ['https://feeds.pinboard.in/rss/secret:abc/u:me/', 'private-path'],
  ])('flags %s as %s', (url, signal) => {
    expect(privateFeedSignal(url)).toBe(signal);
  });

  it.each([
    'https://example.com/feed.xml',
    'https://blog.example.com/feed?author=jane',
    'https://www.youtube.com/feeds/videos.xml?channel_id=UC1234567890',
    'https://example.substack.com/feed',
    'https://feeds.simplecast.com/54nAGcIl',
    'https://example.com/rss?key=',
    'https://example.com/privatefeeds-explained/feed',
    'https://notpatreon.com/rss',
    'not a url',
  ])('leaves %s alone', (url) => {
    expect(privateFeedSignal(url)).toBeNull();
  });
});
