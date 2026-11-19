import { describe, expect, it } from 'vitest';
import { getFaviconUrl } from './favicon';

describe('getFaviconUrl', () => {
  it('asks for a web site’s icon', () => {
    expect(getFaviconUrl('https://example.com/feed.xml')).toContain('domain=example.com');
  });

  it('gives nothing for a feed url that names no site', () => {
    expect(getFaviconUrl('push:did:plc:abc/0636a0fcc5a04')).toBe('');
    expect(getFaviconUrl('newsletter:inbox/sender@example.com')).toBe('');
    expect(getFaviconUrl('not a url')).toBe('');
  });
});
