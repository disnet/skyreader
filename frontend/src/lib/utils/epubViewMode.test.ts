// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { epubViewMode, setEpubViewMode } from './epubViewMode';

describe('epubViewMode', () => {
  beforeEach(() => localStorage.clear());

  it('opens a book in pages by default', () => {
    expect(epubViewMode('book-a')).toBe('paged');
  });

  it('remembers a choice for that book only', () => {
    setEpubViewMode('book-a', 'scroll');
    expect(epubViewMode('book-a')).toBe('scroll');
    expect(epubViewMode('book-b')).toBe('paged');
    setEpubViewMode('book-a', 'paged');
    expect(epubViewMode('book-a')).toBe('paged');
  });

  it('ignores a corrupt or foreign stored value', () => {
    localStorage.setItem('skyreader-epub-view', '{"book-a":"sideways","book-b":"scroll"}');
    expect(epubViewMode('book-a')).toBe('paged');
    expect(epubViewMode('book-b')).toBe('scroll');
    localStorage.setItem('skyreader-epub-view', 'not json');
    expect(epubViewMode('book-b')).toBe('paged');
  });

  it('forgets the oldest choices past the cap', () => {
    for (let i = 0; i < 201; i++) setEpubViewMode(`book-${i}`, 'scroll');
    expect(epubViewMode('book-0')).toBe('paged');
    expect(epubViewMode('book-1')).toBe('scroll');
    expect(epubViewMode('book-200')).toBe('scroll');
  });
});
