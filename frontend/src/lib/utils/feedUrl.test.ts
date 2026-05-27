import { describe, it, expect } from 'vitest';
import { normalizeFeedUrl, normalizeFeedUrlSafe } from './feedUrl';

describe('normalizeFeedUrl (frontend)', () => {
  it('matches the backend normaliser on the canonical variants', () => {
    const canonical = normalizeFeedUrl('https://example.com/feed');
    expect(normalizeFeedUrl('https://EXAMPLE.com/feed')).toBe(canonical);
    expect(normalizeFeedUrl('https://example.com/feed/')).toBe(canonical);
    expect(normalizeFeedUrl('https://example.com:443/feed')).toBe(canonical);
    expect(normalizeFeedUrl('https://example.com/feed#anchor')).toBe(canonical);
  });

  it('preserves the query string verbatim', () => {
    expect(normalizeFeedUrl('https://example.com/feed?format=rss&id=42')).toBe(
      'https://example.com/feed?format=rss&id=42'
    );
  });

  it('does not rewrite http→https', () => {
    expect(normalizeFeedUrl('http://example.com/feed')).toBe('http://example.com/feed');
  });

  it('is idempotent', () => {
    const input = 'https://Example.COM/Feed/?a=1#x';
    const once = normalizeFeedUrl(input);
    expect(normalizeFeedUrl(once)).toBe(once);
  });

  it('throws on invalid input', () => {
    expect(() => normalizeFeedUrl('not a url')).toThrow();
  });
});

describe('normalizeFeedUrlSafe', () => {
  it('returns normalised URL on valid input', () => {
    expect(normalizeFeedUrlSafe('https://Example.com/feed/')).toBe('https://example.com/feed');
  });

  it('returns the original string on invalid input', () => {
    expect(normalizeFeedUrlSafe('not a url')).toBe('not a url');
  });
});
