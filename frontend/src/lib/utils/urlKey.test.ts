import { describe, it, expect } from 'vitest';
import { urlKey } from './urlKey';

describe('urlKey', () => {
  it('collapses the forms the same article travels in', () => {
    const canonical = urlKey('https://example.com/post');
    expect(urlKey('https://example.com/post/')).toBe(canonical);
    expect(urlKey('https://example.com/post#section')).toBe(canonical);
    expect(urlKey('https://EXAMPLE.com/post')).toBe(canonical);
    expect(urlKey('https://example.com:443/post')).toBe(canonical);
    expect(urlKey('https://example.com/post?utm_source=semble')).toBe(canonical);
  });

  it('keeps the query params a page actually needs, in a stable order', () => {
    expect(urlKey('https://example.com/p?b=2&a=1')).toBe(urlKey('https://example.com/p?a=1&b=2'));
    expect(urlKey('https://example.com/p?id=7')).toContain('id=7');
  });

  it('keeps hosts apart that are only cosmetically alike', () => {
    expect(urlKey('https://www.example.com/p')).not.toBe(urlKey('https://example.com/p'));
    expect(urlKey('http://example.com/p')).not.toBe(urlKey('https://example.com/p'));
    expect(urlKey('https://example.com/a')).not.toBe(urlKey('https://example.com/b'));
  });

  it('leaves the bare root alone', () => {
    expect(urlKey('https://example.com/')).toBe('https://example.com/');
  });

  it('returns null for anything that is not a web page, so callers can tell', () => {
    expect(urlKey('at://did:plc:abc/app.bsky.feed.post/123')).toBeNull();
    expect(urlKey('some-feed-item-guid')).toBeNull();
    expect(urlKey('')).toBeNull();
  });
});
