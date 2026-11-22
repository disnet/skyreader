// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from './sanitize';

describe('sanitizeHtml in-page links', () => {
  const base = 'https://www.example.com/2024/post/';
  const mark = (html: string, url: string | undefined = base) => {
    const div = document.createElement('div');
    div.innerHTML = sanitizeHtml(html, url);
    return div.querySelector('a')?.getAttribute('data-in-page') ?? null;
  };

  it('marks a bare fragment with the id it points at', () => {
    expect(mark('<a href="#fn:1">1</a>')).toBe('fn:1');
    expect(mark('<a href="#fn%201">1</a>')).toBe('fn 1');
    expect(mark('<a href="#fn1">1</a>', undefined)).toBe('fn1');
  });

  it('marks the article’s own address with a fragment, loosely', () => {
    expect(mark('<a href="https://example.com/2024/post#fn1">1</a>')).toBe('fn1');
    expect(mark('<a href="http://www.example.com/2024/post/#fn1">1</a>')).toBe('fn1');
    // An item address with tracking parameters still matches its own links.
    expect(
      mark('<a href="https://example.com/2024/post#fn1">1</a>', `${base}?utm_source=rss`)
    ).toBe('fn1');
  });

  it('leaves other pages, and the bare article, unmarked', () => {
    expect(mark('<a href="https://example.com/other#fn1">1</a>')).toBeNull();
    expect(mark('<a href="https://example.com/2024/post/">x</a>')).toBeNull();
    expect(mark('<a href="#">x</a>')).toBeNull();
  });

  it('never keeps a mark the feed supplied', () => {
    expect(mark('<a href="https://elsewhere.example/" data-in-page="fn1">x</a>')).toBeNull();
    const div = document.createElement('div');
    div.innerHTML = sanitizeHtml(
      '<svg><a href="https://elsewhere.example/" data-in-page="fn1"><text>x</text></a></svg>',
      base
    );
    expect(div.querySelector('[data-in-page]')).toBeNull();
  });
});
