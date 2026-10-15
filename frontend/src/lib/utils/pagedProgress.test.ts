import { describe, expect, it } from 'vitest';
import { lastIndexOnOrBefore } from './pagedProgress';

const id = (page: number) => page;

describe('lastIndexOnOrBefore', () => {
  it('finds the last element starting on or before the page', () => {
    const pages = [0, 0, 1, 1, 1, 2, 4, 4];
    expect(lastIndexOnOrBefore(pages, 0, id)).toBe(1);
    expect(lastIndexOnOrBefore(pages, 1, id)).toBe(4);
    expect(lastIndexOnOrBefore(pages, 3, id)).toBe(5);
    expect(lastIndexOnOrBefore(pages, 9, id)).toBe(7);
  });

  it('falls back to 0 when nothing starts that early', () => {
    expect(lastIndexOnOrBefore([2, 3], 1, id)).toBe(0);
    expect(lastIndexOnOrBefore([], 1, id)).toBe(0);
  });

  it('matches a linear scan', () => {
    const pages = Array.from({ length: 500 }, (_, i) => Math.floor(i / 7));
    for (let page = 0; page < 80; page++) {
      let linear = 0;
      pages.forEach((p, i) => {
        if (p <= page) linear = i;
      });
      expect(lastIndexOnOrBefore(pages, page, id)).toBe(linear);
    }
  });

  it('measures only a logarithmic number of elements', () => {
    const pages = Array.from({ length: 10_000 }, (_, i) => Math.floor(i / 10));
    let reads = 0;
    lastIndexOnOrBefore(pages, 500, (p) => (reads++, p));
    expect(reads).toBeLessThanOrEqual(15);
  });
});
