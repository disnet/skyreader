import { describe, it, expect } from 'vitest';
import { normalizeFeedUrl } from '../src/lib/feed-url';

describe('normalizeFeedUrl', () => {
  it('lowercases host', () => {
    expect(normalizeFeedUrl('https://Example.COM/feed')).toBe('https://example.com/feed');
  });

  it('preserves path case', () => {
    expect(normalizeFeedUrl('https://example.com/Feed/Path')).toBe('https://example.com/Feed/Path');
  });

  it('strips trailing slash on non-root path', () => {
    expect(normalizeFeedUrl('https://example.com/feed/')).toBe('https://example.com/feed');
  });

  it('preserves bare-host root slash', () => {
    // WHATWG URL normalises the empty path to "/", which is the canonical form.
    expect(normalizeFeedUrl('https://example.com/')).toBe('https://example.com/');
    expect(normalizeFeedUrl('https://example.com')).toBe('https://example.com/');
  });

  it('strips default ports', () => {
    expect(normalizeFeedUrl('https://example.com:443/feed')).toBe('https://example.com/feed');
    expect(normalizeFeedUrl('http://example.com:80/feed')).toBe('http://example.com/feed');
  });

  it('keeps non-default ports', () => {
    expect(normalizeFeedUrl('http://example.com:8080/feed')).toBe('http://example.com:8080/feed');
  });

  it('strips fragments', () => {
    expect(normalizeFeedUrl('https://example.com/feed#section')).toBe('https://example.com/feed');
  });

  it('preserves query string verbatim', () => {
    expect(normalizeFeedUrl('https://example.com/feed?format=rss&id=42')).toBe(
      'https://example.com/feed?format=rss&id=42'
    );
  });

  it('does not rewrite http→https', () => {
    expect(normalizeFeedUrl('http://example.com/feed')).toBe('http://example.com/feed');
  });

  it('is idempotent', () => {
    const inputs = [
      'https://Example.COM/Feed/',
      'http://example.com:80/feed#frag',
      'https://example.com/feed?a=1#x',
      'https://example.com',
    ];
    for (const input of inputs) {
      const once = normalizeFeedUrl(input);
      const twice = normalizeFeedUrl(once);
      expect(twice).toBe(once);
    }
  });

  it('throws on invalid URL', () => {
    expect(() => normalizeFeedUrl('not a url')).toThrow();
  });

  it('collapses common duplicate-causing variants to one key', () => {
    const canonical = normalizeFeedUrl('https://example.com/feed');
    expect(normalizeFeedUrl('https://EXAMPLE.com/feed')).toBe(canonical);
    expect(normalizeFeedUrl('https://example.com/feed/')).toBe(canonical);
    expect(normalizeFeedUrl('https://example.com:443/feed')).toBe(canonical);
    expect(normalizeFeedUrl('https://example.com/feed#anchor')).toBe(canonical);
  });
});
