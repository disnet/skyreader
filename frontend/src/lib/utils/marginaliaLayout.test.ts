import { describe, expect, it } from 'vitest';
import { placeBrackets } from './marginaliaLayout';

const LINE = 26;

describe('placeBrackets', () => {
  it('leaves apart brackets alone in the first lane', () => {
    const placed = placeBrackets([
      { top: 0, bottom: 60, line: LINE },
      { top: 100, bottom: 160, line: LINE },
    ]);
    expect(placed).toEqual([
      { top: 0, bottom: 60, lane: 0 },
      { top: 100, bottom: 160, lane: 0 },
    ]);
  });

  it('splits a line shared by neighbours and keeps them in one column', () => {
    // The first passage ends on the line the second starts on (y 64..90).
    const [a, b] = placeBrackets([
      { top: 0, bottom: 90, line: LINE },
      { top: 64, bottom: 220, line: LINE },
    ]);
    expect(a.lane).toBe(0);
    expect(b.lane).toBe(0);
    expect(a.bottom).toBeLessThan(77);
    expect(b.top).toBeGreaterThan(77);
    expect(b.top - a.bottom).toBeGreaterThan(2);
    expect(a.top).toBe(0);
    expect(b.bottom).toBe(220);
  });

  it('splits a one-line passage from the next one starting on its line', () => {
    // Both start on the same line, so only reading order tells them apart.
    const [a, b] = placeBrackets([
      { top: 0, bottom: 26, line: LINE, first: 0, last: 0 },
      { top: 0, bottom: 90, line: LINE, first: 1, last: 2 },
    ]);
    expect(a.lane).toBe(0);
    expect(b.lane).toBe(0);
    expect(a.bottom).toBeLessThan(b.top);
    expect(b.bottom).toBe(90);
  });

  it('gives the top half of a shared line to the passage read first', () => {
    // Listed with the later passage first (equal tops sort either way).
    const [later, earlier] = placeBrackets([
      { top: 0, bottom: 90, line: LINE, first: 1, last: 2 },
      { top: 0, bottom: 26, line: LINE, first: 0, last: 0 },
    ]);
    expect(earlier.bottom).toBeLessThan(later.top);
  });

  it('nests a word marked inside a passage on the same line', () => {
    // The inner mark's index falls inside the outer passage's range.
    const [outer, inner] = placeBrackets([
      { top: 0, bottom: 90, line: LINE, first: 0, last: 2 },
      { top: 0, bottom: 26, line: LINE, first: 1, last: 1 },
    ]);
    expect(outer).toMatchObject({ top: 0, bottom: 90, lane: 1 });
    expect(inner).toMatchObject({ top: 0, bottom: 26, lane: 0 });
  });

  it('nests a passage inside another: the inner one by the text, the outer a lane out', () => {
    // Listed by top, the outer one comes first.
    const [outer, inner] = placeBrackets([
      { top: 0, bottom: 200, line: LINE },
      { top: 64, bottom: 120, line: LINE },
    ]);
    expect(inner.lane).toBe(0);
    expect(outer.lane).toBe(1);
    expect(outer).toMatchObject({ top: 0, bottom: 200 });
    expect(inner).toMatchObject({ top: 64, bottom: 120 });
  });

  it('nests overlaps longer than a line instead of splitting them', () => {
    const [a, b] = placeBrackets([
      { top: 0, bottom: 150, line: LINE },
      { top: 64, bottom: 300, line: LINE },
    ]);
    expect(a).toMatchObject({ top: 0, bottom: 150, lane: 0 });
    expect(b).toMatchObject({ top: 64, bottom: 300, lane: 1 });
  });

  it('nests when the line height is unknown', () => {
    const [a, b] = placeBrackets([
      { top: 0, bottom: 90 },
      { top: 64, bottom: 220 },
    ]);
    expect(a.lane).not.toBe(b.lane);
  });

  it('puts a long bracket outside every shorter one it overlaps', () => {
    // Two short passages overlap each other; the long one overlaps only the
    // second, yet still belongs outside both.
    const placed = placeBrackets([
      { top: 0, bottom: 60 },
      { top: 40, bottom: 140 },
      { top: 120, bottom: 600 },
    ]);
    expect(placed.map((p) => p.lane)).toEqual([0, 1, 2]);
  });

  it('caps the lanes so brackets never reach the notes', () => {
    const placed = placeBrackets([
      { top: 0, bottom: 400 },
      { top: 10, bottom: 300 },
      { top: 20, bottom: 200 },
      { top: 30, bottom: 100 },
    ]);
    expect(Math.max(...placed.map((p) => p.lane))).toBe(2);
  });
});
