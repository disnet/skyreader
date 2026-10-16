import { describe, expect, it } from 'vitest';
import { isPdfPlace, pdfPlaceProgress } from './pdfPlace';

describe('isPdfPlace', () => {
  it('accepts a page and a point down it', () => {
    expect(isPdfPlace({ page: 1, at: 0 })).toBe(true);
    expect(isPdfPlace({ page: 7, at: 1, lastReadAt: 5 })).toBe(true);
  });

  it('rejects a corrupt or foreign value', () => {
    expect(isPdfPlace(null)).toBe(false);
    expect(isPdfPlace(3)).toBe(false);
    expect(isPdfPlace({ paragraphIndex: 4 })).toBe(false);
    expect(isPdfPlace({ page: 0, at: 0.5 })).toBe(false);
    expect(isPdfPlace({ page: 1.5, at: 0.5 })).toBe(false);
    expect(isPdfPlace({ page: 2, at: 4 })).toBe(false);
    expect(isPdfPlace({ page: 2, at: '0.5' })).toBe(false);
  });

  it('accepts a page count, but not one short of the page', () => {
    expect(isPdfPlace({ page: 3, at: 0.5, pages: 10 })).toBe(true);
    expect(isPdfPlace({ page: 3, at: 0.5, pages: 2 })).toBe(false);
    expect(isPdfPlace({ page: 3, at: 0.5, pages: 4.5 })).toBe(false);
  });
});

describe('pdfPlaceProgress', () => {
  const fraction = (p: { paragraphIndex: number; totalParagraphs: number } | null) =>
    p ? (p.paragraphIndex + 1) / p.totalParagraphs : null;

  it('needs a page count', () => {
    expect(pdfPlaceProgress({ page: 3, at: 0.5 })).toBeNull();
  });

  it('is how far through the document the place is', () => {
    expect(fraction(pdfPlaceProgress({ page: 5, at: 0.5, pages: 10 }))).toBeCloseTo(0.45);
    expect(fraction(pdfPlaceProgress({ page: 1, at: 0, pages: 10 }))).toBeGreaterThan(0);
    expect(fraction(pdfPlaceProgress({ page: 10, at: 1, pages: 10 }))).toBe(1);
  });
});
