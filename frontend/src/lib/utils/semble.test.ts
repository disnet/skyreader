import { describe, expect, it } from 'vitest';
import { sembleCardUrl, sembleSourceUrl } from './semble';

const ARTICLE = 'https://example.test/post';
const SLASHED = 'https://example.test/post/';

describe('sembleCardUrl', () => {
  it('builds the card page the proxy builds', () => {
    expect(sembleCardUrl(ARTICLE)).toBe(`https://semble.so/url/${encodeURIComponent(ARTICLE)}`);
  });

  it('has no card page without a URL', () => {
    expect(sembleCardUrl(null)).toBeNull();
    expect(sembleCardUrl(undefined)).toBeNull();
    expect(sembleCardUrl('')).toBeNull();
  });
});

describe('sembleSourceUrl', () => {
  it('recovers the exact variant Semble keyed the card under', () => {
    // The proxy resolved the trailing-slash form; an edge written against our
    // own copy would land on a different card.
    expect(sembleSourceUrl(sembleCardUrl(SLASHED), ARTICLE)).toBe(SLASHED);
  });

  it('falls back when the panel never resolved a card page', () => {
    expect(sembleSourceUrl(null, ARTICLE)).toBe(ARTICLE);
    expect(sembleSourceUrl(undefined, ARTICLE)).toBe(ARTICLE);
  });

  it('falls back on a card URL that is not semble.so', () => {
    expect(sembleSourceUrl(`https://evil.test/url/${encodeURIComponent(SLASHED)}`, ARTICLE)).toBe(
      ARTICLE
    );
  });

  it('falls back on an unexpected path shape', () => {
    expect(sembleSourceUrl('https://semble.so/collections/abc', ARTICLE)).toBe(ARTICLE);
  });

  it('falls back when the encoded segment is not an http(s) URL', () => {
    expect(
      sembleSourceUrl(`https://semble.so/url/${encodeURIComponent('javascript:alert(1)')}`, ARTICLE)
    ).toBe(ARTICLE);
  });
});
