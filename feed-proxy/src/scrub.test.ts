import { describe, expect, test } from 'bun:test';
import { scrubEvent, scrubText, scrubUrl } from './scrub';

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

  test('scrubs tokenised URLs from free-text channels without request data', () => {
    const event = {
      message: 'warmer failed for https://example.com/feed?token=message-secret',
      breadcrumbs: [{ message: '[Proxy] https://example.com/feed?token=crumb-secret: HTTP 404' }],
      exception: { values: [{ value: 'api_key=exception-secret' }] },
      extra: { feedUrl: 'https://example.com/feed?auth=extra-secret' },
    };

    expect(JSON.stringify(scrubEvent(event))).not.toContain('secret');
    expect(event.message).toContain('token=%5Bredacted%5D');
  });

  test('scrubs a breadcrumb or extra that is a bare string or array', () => {
    // Neither shape can be redacted in place, so a scrub that ignored the return
    // value would pass both through while reading as if it had worked.
    const event = {
      breadcrumbs: [{ data: 'fetched https://example.com/feed?token=crumb-secret' }],
      extra: ['warmed https://example.com/feed?token=extra-secret'],
    };

    expect(JSON.stringify(scrubEvent(event))).not.toContain('secret');
  });
});

describe('scrubText', () => {
  test('redacts authorization values embedded in prose', () => {
    expect(scrubText('upstream returned Authorization: Bearer abcdefghijklmnop')).not.toContain(
      'abcdefghijklmnop'
    );
  });
});
