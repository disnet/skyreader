// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { pdfZoom, setPdfZoom } from './pdfZoom';

describe('pdfZoom', () => {
  beforeEach(() => localStorage.clear());

  it('opens a PDF fitted to width by default', () => {
    expect(pdfZoom('pdf-a')).toBe(1);
  });

  it('remembers a zoom for that PDF only', () => {
    setPdfZoom('pdf-a', 1.5);
    expect(pdfZoom('pdf-a')).toBe(1.5);
    expect(pdfZoom('pdf-b')).toBe(1);
    setPdfZoom('pdf-a', 1);
    expect(pdfZoom('pdf-a')).toBe(1);
    expect(localStorage.getItem('skyreader-pdf-zoom')).toBe('{}');
  });

  it('ignores a corrupt or foreign stored value', () => {
    localStorage.setItem('skyreader-pdf-zoom', '{"pdf-a":"big","pdf-b":2,"pdf-c":-1}');
    expect(pdfZoom('pdf-a')).toBe(1);
    expect(pdfZoom('pdf-b')).toBe(2);
    expect(pdfZoom('pdf-c')).toBe(1);
    localStorage.setItem('skyreader-pdf-zoom', 'not json');
    expect(pdfZoom('pdf-b')).toBe(1);
  });

  it('forgets the oldest zooms past the cap', () => {
    for (let i = 0; i < 201; i++) setPdfZoom(`pdf-${i}`, 2);
    expect(pdfZoom('pdf-0')).toBe(1);
    expect(pdfZoom('pdf-1')).toBe(2);
    expect(pdfZoom('pdf-200')).toBe(2);
  });
});
