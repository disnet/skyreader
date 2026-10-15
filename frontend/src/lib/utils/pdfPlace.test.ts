// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { pdfPlace, setPdfPlace } from './pdfPlace';

describe('pdfPlace', () => {
  beforeEach(() => localStorage.clear());

  it('opens a PDF at its top by default', () => {
    expect(pdfPlace('pdf-a')).toBeNull();
  });

  it('remembers a place for that PDF only', () => {
    setPdfPlace('pdf-a', { page: 7, at: 0.25 });
    expect(pdfPlace('pdf-a')).toEqual({ page: 7, at: 0.25 });
    expect(pdfPlace('pdf-b')).toBeNull();
  });

  it('stores nothing for the top of the first page', () => {
    setPdfPlace('pdf-a', { page: 3, at: 0.5 });
    setPdfPlace('pdf-a', { page: 1, at: 0 });
    expect(pdfPlace('pdf-a')).toBeNull();
    expect(localStorage.getItem('skyreader-pdf-place')).toBe('{}');
  });

  it('ignores a corrupt or foreign stored value', () => {
    localStorage.setItem(
      'skyreader-pdf-place',
      JSON.stringify({
        'pdf-a': { page: 0, at: 0.5 },
        'pdf-b': { page: 2, at: 0.5 },
        'pdf-c': { page: 2, at: 4 },
        'pdf-d': 3,
      })
    );
    expect(pdfPlace('pdf-a')).toBeNull();
    expect(pdfPlace('pdf-b')).toEqual({ page: 2, at: 0.5 });
    expect(pdfPlace('pdf-c')).toBeNull();
    expect(pdfPlace('pdf-d')).toBeNull();
    localStorage.setItem('skyreader-pdf-place', 'not json');
    expect(pdfPlace('pdf-b')).toBeNull();
  });

  it('forgets the oldest places past the cap', () => {
    for (let i = 0; i < 201; i++) setPdfPlace(`pdf-${i}`, { page: 2, at: 0 });
    expect(pdfPlace('pdf-0')).toBeNull();
    expect(pdfPlace('pdf-1')).toEqual({ page: 2, at: 0 });
    expect(pdfPlace('pdf-200')).toEqual({ page: 2, at: 0 });
  });
});
