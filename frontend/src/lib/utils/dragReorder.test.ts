import { describe, it, expect } from 'vitest';
import { clampDrag, dragSlot, makeWayOffset, settleOffset, type RowRect } from './dragReorder';

// Four 30px rows with a 2px gap: tops at 0, 32, 64, 96.
const rects: RowRect[] = [0, 32, 64, 96].map((top) => ({ top, bottom: top + 30 }));

describe('dragSlot', () => {
  it('stays put until the centre passes a neighbour’s middle', () => {
    expect(dragSlot(rects, 1, 0)).toBe(1);
    expect(dragSlot(rects, 1, 31)).toBe(1);
    expect(dragSlot(rects, 1, 33)).toBe(2);
    expect(dragSlot(rects, 1, -33)).toBe(0);
  });

  it('takes the end slot when held against the end of the list', () => {
    expect(dragSlot(rects, 2, clampDrag(rects, 2, -500))).toBe(0);
    expect(dragSlot(rects, 0, clampDrag(rects, 0, 500))).toBe(3);
  });

  it('goes as far as the pointer, and no further than the ends', () => {
    expect(dragSlot(rects, 0, 70)).toBe(2);
    expect(dragSlot(rects, 0, 500)).toBe(3);
    expect(dragSlot(rects, 3, -500)).toBe(0);
  });
});

describe('makeWayOffset', () => {
  it('slides the rows the drag passes by one pitch, toward where it came from', () => {
    expect([0, 1, 2, 3].map((i) => makeWayOffset(rects, 0, 2, i))).toEqual([0, -32, -32, 0]);
    expect([0, 1, 2, 3].map((i) => makeWayOffset(rects, 3, 1, i))).toEqual([0, 32, 32, 0]);
  });

  it('moves nothing while the row is over its own slot', () => {
    expect([0, 1, 2, 3].map((i) => makeWayOffset(rects, 1, 1, i))).toEqual([0, 0, 0, 0]);
  });
});

describe('settleOffset', () => {
  it('lands the row exactly in the room the others made', () => {
    expect(settleOffset(rects, 0, 2)).toBe(64);
    expect(settleOffset(rects, 3, 0)).toBe(-96);
    expect(settleOffset(rects, 2, 2)).toBe(0);
  });
});

describe('clampDrag', () => {
  it('keeps the row within the list', () => {
    expect(clampDrag(rects, 1, -100)).toBe(-32);
    expect(clampDrag(rects, 1, 100)).toBe(64);
    expect(clampDrag(rects, 1, 10)).toBe(10);
  });
});
