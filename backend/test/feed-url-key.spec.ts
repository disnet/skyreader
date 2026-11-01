import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { feedUrlKey, feedUrlKeySql } from '../src/services/feed-url-key';

describe('feedUrlKey', () => {
  it('ignores the scheme and the host case', () => {
    expect(feedUrlKey('http://Example.com/feed.xml')).toBe(
      feedUrlKey(' HTTPS://example.com/feed.xml ')
    );
  });

  it('keeps the case of the path and query', () => {
    expect(feedUrlKey('https://example.com/Tech.xml')).not.toBe(
      feedUrlKey('https://example.com/tech.xml')
    );
    expect(feedUrlKey('https://example.com/f?key=AbC')).not.toBe(
      feedUrlKey('https://example.com/f?key=abc')
    );
  });

  it('agrees with its SQL form', async () => {
    for (const url of [
      'http://Example.com/Feed.xml',
      'HTTPS://EXAMPLE.COM/a/B?c=D',
      'https://example.com',
      'example.com/Path',
      ' http://x.org/y ',
    ]) {
      const row = await env.DB.prepare(`SELECT ${feedUrlKeySql('?1')} AS k`)
        .bind(url)
        .first<{ k: string }>();
      expect(row?.k).toBe(feedUrlKey(url));
    }
  });
});
