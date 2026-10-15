// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { findEpubAnchor, isEpubAnchorHref, resolveEpubImages } from './epubContent';

describe('resolveEpubImages', () => {
  it("keeps the book's own links in this tab", () => {
    const html =
      '<a href="#epub-c3-note12" target="_blank" rel="noopener noreferrer">1</a><a href="https://x.test/" target="_blank" rel="noopener noreferrer">x</a>';
    expect(resolveEpubImages(html, (p) => p)).toBe(
      '<a href="#epub-c3-note12">1</a><a href="https://x.test/" target="_blank" rel="noopener noreferrer">x</a>'
    );
  });

  const assetUrl = (path: string) =>
    `https://api.test/api/saved/r1/asset?path=${encodeURIComponent(path)}`;

  it('gives each book picture the address of its asset', () => {
    const html =
      '<p>Text</p><img loading="lazy" data-epub-src="OEBPS/images/fig 1.png" alt="A &amp; B"><img data-epub-src="a&amp;b.png">';
    const out = resolveEpubImages(html, assetUrl);
    expect(out).toContain(
      '<img loading="lazy" src="https://api.test/api/saved/r1/asset?path=OEBPS%2Fimages%2Ffig%201.png" data-epub-src="OEBPS/images/fig 1.png" alt="A &amp; B">'
    );
    expect(out).toContain('src="https://api.test/api/saved/r1/asset?path=a%26b.png"');
  });

  it('leaves other pictures alone', () => {
    const html = '<img src="https://example.com/a.png" alt="">';
    expect(resolveEpubImages(html, assetUrl)).toBe(html);
  });
});

describe('book anchors', () => {
  it('knows a book’s own links from a page’s', () => {
    expect(isEpubAnchorHref('#epub-c3-note12')).toBe(true);
    expect(isEpubAnchorHref('#epub-c3')).toBe(true);
    expect(isEpubAnchorHref('#intro')).toBe(false);
    expect(isEpubAnchorHref('https://example.com/#epub-c3')).toBe(false);
    expect(isEpubAnchorHref(null)).toBe(false);
  });

  it('finds the element a link points at', () => {
    const root = document.createElement('div');
    root.innerHTML = '<section id="epub-c2"><aside id="epub-c2-n_1">Note</aside></section>';
    expect(findEpubAnchor(root, '#epub-c2-n_1')?.textContent).toBe('Note');
    expect(findEpubAnchor(root, '#epub-c2')?.tagName).toBe('SECTION');
    expect(findEpubAnchor(root, '#epub-c9')).toBeNull();
  });
});
