// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clampPdfZoom,
  claimPdfZoomShortcuts,
  openPdfZoom,
  pdfZoom,
  setPdfZoom,
  stepPdfZoom,
} from './pdfZoom';

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

describe('claimPdfZoomShortcuts', () => {
  it('hands the shortcuts to the open PDF until it lets go', () => {
    const first = { step: () => {}, reset: () => {} };
    const second = { step: () => {}, reset: () => {} };
    expect(openPdfZoom()).toBeNull();
    const releaseFirst = claimPdfZoomShortcuts(first);
    const releaseSecond = claimPdfZoomShortcuts(second);
    // A stale release (the old view unmounting after the new one mounted) is a no-op.
    releaseFirst();
    expect(openPdfZoom()).toBe(second);
    releaseSecond();
    expect(openPdfZoom()).toBeNull();
  });

  it('keeps a pinched zoom in range, to the percent, snapping near-fit to fit', () => {
    expect(clampPdfZoom(1.234)).toBe(1.23);
    expect(clampPdfZoom(9)).toBe(3);
    expect(clampPdfZoom(0.1)).toBe(0.5);
    expect(clampPdfZoom(1.03)).toBe(1);
    expect(clampPdfZoom(0.96)).toBe(1);
    expect(clampPdfZoom(Number.NaN)).toBe(1);
  });

  it('steps to the next stop from anywhere a pinch left it', () => {
    expect(stepPdfZoom(1, 1)).toBe(1.25);
    expect(stepPdfZoom(1, -1)).toBe(0.75);
    expect(stepPdfZoom(1.37, 1)).toBe(1.5);
    expect(stepPdfZoom(1.37, -1)).toBe(1.25);
    expect(stepPdfZoom(1.24, 1)).toBe(1.5);
    expect(stepPdfZoom(1.52, -1)).toBe(1.25);
    expect(stepPdfZoom(3, 1)).toBe(3);
    expect(stepPdfZoom(0.5, -1)).toBe(0.5);
  });

  it('opens a pinched zoom as it was left, and an out-of-range one clamped', () => {
    setPdfZoom('pdf-a', 1.37);
    expect(pdfZoom('pdf-a')).toBe(1.37);
    localStorage.setItem('skyreader-pdf-zoom', '{"pdf-b":12}');
    expect(pdfZoom('pdf-b')).toBe(3);
  });
});
