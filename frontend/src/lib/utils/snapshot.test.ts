// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { captureLine, fallBackToKeptImage, waybackUrl, withWaybackLink } from './snapshot';

describe('waybackUrl', () => {
  it('asks for the copy nearest the save', () => {
    expect(waybackUrl('https://example.com/a?b=1', '2026-10-18T01:02:03.456Z')).toBe(
      'https://web.archive.org/web/20261018010203/https://example.com/a?b=1'
    );
  });

  it('asks for the latest copy without a usable time', () => {
    expect(waybackUrl('https://example.com/', null)).toBe(
      'https://web.archive.org/web//https://example.com/'
    );
    expect(waybackUrl('https://example.com/', 'not a date')).toBe(
      'https://web.archive.org/web//https://example.com/'
    );
  });
});

describe('withWaybackLink', () => {
  it('adds an escaped link after the note', () => {
    const html = withWaybackLink('<p>note</p>', 'https://example.com/?a=1&b="2"', 0);
    expect(html).toBe(
      '<p>note</p>\n<p><a href="https://web.archive.org/web/19700101000000/https://example.com/?a=1&amp;b=&quot;2&quot;">Look for a copy on the Wayback Machine</a></p>'
    );
  });
});

describe('captureLine', () => {
  const snapshot = {
    rkey: '3my4cmz6zes3t',
    capturedAt: '2026-10-18T01:02:03.456Z',
    url: 'https://example.com/',
    contentType: 'text/html',
    sha256: 'ab'.repeat(32),
    size: 10,
  };

  it('says how the body was captured when that is known', () => {
    expect(captureLine({ ...snapshot, method: 'live-dom' })).toMatch(
      /^Captured on .+, from the page in your browser\.$/
    );
    const unknown = captureLine({ ...snapshot, method: null });
    expect(unknown).toMatch(/^Captured on .+\.$/);
    expect(unknown).not.toMatch(/from|fetched/);
  });
});

describe('fallBackToKeptImage', () => {
  const kept = (address: string) => `https://api.test/kept?url=${encodeURIComponent(address)}`;
  function image(html: string): HTMLImageElement {
    const root = document.createElement('div');
    root.innerHTML = html;
    return root.querySelector('img')!;
  }

  it("points a broken picture at the snapshot's copy, once", () => {
    const img = image(
      '<img src="https://example.com/a.png" srcset="https://example.com/a2.png 2x">'
    );
    expect(fallBackToKeptImage(img, kept)).toBe(true);
    expect(img.getAttribute('src')).toBe(kept('https://example.com/a.png'));
    expect(img.hasAttribute('srcset')).toBe(false);
    // The kept copy failing too leaves it be.
    expect(fallBackToKeptImage(img, kept)).toBe(false);
    expect(img.getAttribute('src')).toBe(kept('https://example.com/a.png'));
  });

  it("drops a <picture>'s sources, and reads a srcset-only picture's first candidate", () => {
    const img = image(
      '<picture><source srcset="https://example.com/a.webp"><img srcset="https://cdn.test/w_500,f_auto/a.jpg 500w, https://cdn.test/b.jpg 900w"></picture>'
    );
    expect(fallBackToKeptImage(img, kept)).toBe(true);
    expect(img.parentElement!.querySelector('source')).toBeNull();
    expect(img.getAttribute('src')).toBe(kept('https://cdn.test/w_500,f_auto/a.jpg'));
  });

  it('reads past a placeholder src to the srcset, as the capture did', () => {
    const img = image(
      '<img src="data:image/gif;base64,R0lGOD" srcset="https://example.com/a.jpg 1x">'
    );
    expect(fallBackToKeptImage(img, kept)).toBe(true);
    expect(img.getAttribute('src')).toBe(kept('https://example.com/a.jpg'));
  });

  it('leaves a picture with no web address alone', () => {
    const img = image('<img src="data:image/gif;base64,R0lGOD">');
    expect(fallBackToKeptImage(img, kept)).toBe(false);
    expect(img.getAttribute('src')).toBe('data:image/gif;base64,R0lGOD');
  });
});
