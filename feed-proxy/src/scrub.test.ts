import { describe, expect, test } from 'bun:test';
import { scrubEvent, scrubUrl } from './scrub';

// The two credentials that pass through this process: the Worker's shared secret
// on every authenticated call, and tokenised feed URLs.

describe('scrubUrl', () => {
  test('redacts a token in a feed URL but keeps the URL readable', () => {
    expect(scrubUrl('https://example.com/feed.xml?token=abc123&format=rss')).toBe(
      'https://example.com/feed.xml?token=%5Bredacted%5D&format=rss'
    );
  });

  test('leaves an ordinary URL alone', () => {
    expect(scrubUrl('https://example.com/feed.xml?format=rss')).toBe(
      'https://example.com/feed.xml?format=rss'
    );
    expect(scrubUrl('https://example.com/feed.xml')).toBe('https://example.com/feed.xml');
  });
});

describe('scrubEvent', () => {
  test('redacts the shared secret the Worker sends on every call', () => {
    const event = {
      request: {
        url: 'http://proxy/fetch',
        headers: { 'X-Proxy-Secret': 'super-secret', 'User-Agent': 'skyreader' },
      },
    };

    expect(scrubEvent(event).request.headers).toEqual({
      'X-Proxy-Secret': '[redacted]',
      'User-Agent': 'skyreader',
    });
  });

  test('drops cookies and bodies entirely', () => {
    const event = {
      request: { cookies: { session: 'x' }, data: { apiKey: 'y' } },
    };

    const scrubbed = scrubEvent(event);
    expect(scrubbed.request?.cookies).toBeUndefined();
    expect(scrubbed.request?.data).toBeUndefined();
  });

  test('passes an event with no request through untouched', () => {
    const event = { message: 'warmer failed' };
    expect(scrubEvent(event)).toEqual({ message: 'warmer failed' });
  });
});
