import { describe, expect, it } from 'vitest';
import { allowedIframeSrc } from './sanitize';

describe('allowedIframeSrc', () => {
  it('keeps trusted https video iframe URLs', () => {
    expect(allowedIframeSrc('https://www.youtube.com/embed/video-id', null)).toBe(
      'https://www.youtube.com/embed/video-id?autoplay=0'
    );
    expect(allowedIframeSrc('https://player.vimeo.com/video/123', null)).toBe(
      'https://player.vimeo.com/video/123?autoplay=0'
    );
  });

  it('resolves relative trusted iframe URLs against the article URL', () => {
    expect(allowedIframeSrc('/embed/video-id', new URL('https://www.youtube.com/watch?v=x'))).toBe(
      'https://www.youtube.com/embed/video-id?autoplay=0'
    );
  });

  it('overrides iframe autoplay parameters', () => {
    expect(allowedIframeSrc('https://www.youtube.com/embed/video-id?autoplay=1', null)).toBe(
      'https://www.youtube.com/embed/video-id?autoplay=0'
    );
    expect(
      allowedIframeSrc('https://player.vimeo.com/video/123?background=1&autoplay=1', null)
    ).toBe('https://player.vimeo.com/video/123?background=0&autoplay=0');
  });

  it('rejects untrusted iframe URLs', () => {
    expect(allowedIframeSrc('http://www.youtube.com/embed/video-id', null)).toBeNull();
    expect(allowedIframeSrc('https://example.com/embed', null)).toBeNull();
    expect(allowedIframeSrc('javascript:alert(1)', null)).toBeNull();
  });
});
