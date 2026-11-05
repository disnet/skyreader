import { describe, it, expect } from 'vitest';
import { linkPageBaseFor, linkPageUrl } from './linkPages';

describe('link page links', () => {
  it('maps each app host to its read host', () => {
    expect(linkPageBaseFor('skyreader.app')).toBe('https://read.skyreader.app');
    expect(linkPageBaseFor('staging.skyreader.app')).toBe('https://staging-read.skyreader.app');
    expect(linkPageBaseFor('staging-prod.skyreader.app')).toBe('https://read.skyreader.app');
    expect(linkPageBaseFor('127.0.0.1')).toBe('http://127.0.0.1:5175/link');
  });

  it('appends the article as-is, keeping its query and dropping its fragment', () => {
    expect(linkPageUrl('https://example.com/post?id=7#comments', 'skyreader.app')).toBe(
      'https://read.skyreader.app/https://example.com/post?id=7'
    );
  });

  it('has no link page for an item without a public web address', () => {
    expect(linkPageUrl('', 'skyreader.app')).toBeNull();
    expect(linkPageUrl('/saved/abc', 'skyreader.app')).toBeNull();
    expect(linkPageUrl('mailto:a@example.com', 'skyreader.app')).toBeNull();
    expect(linkPageUrl('http://localhost/x', 'skyreader.app')).toBeNull();
    expect(linkPageUrl(`https://example.com/${'a'.repeat(2048)}`, 'skyreader.app')).toBeNull();
  });
});
