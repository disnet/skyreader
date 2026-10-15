import { describe, expect, it } from 'vitest';
import { isPdfPlace } from './pdfPlace';

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
});
