import { describe, expect, it } from 'vitest';
import { isHttpUrl } from './httpUrl';

describe('isHttpUrl', () => {
  it('takes http and https addresses that parse', () => {
    expect(isHttpUrl('https://example.com/a')).toBe(true);
    expect(isHttpUrl('http://example.com')).toBe(true);
  });

  it('turns down other schemes, non-URLs and nothing', () => {
    expect(isHttpUrl('mailto:a@b.test')).toBe(false);
    expect(isHttpUrl('at://did:plc:x/app.bsky.feed.post/1')).toBe(false);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('https://')).toBe(false);
    expect(isHttpUrl('example.com')).toBe(false);
    expect(isHttpUrl('')).toBe(false);
    expect(isHttpUrl(undefined)).toBe(false);
    expect(isHttpUrl(null)).toBe(false);
  });
});
