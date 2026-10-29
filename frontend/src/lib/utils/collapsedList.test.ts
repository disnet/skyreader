import { describe, it, expect } from 'vitest';
import { collapseList } from './collapsedList';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`);
const none = { pinned: () => false, open: () => false };

describe('collapseList', () => {
  it('leaves a short list alone', () => {
    expect(collapseList(ids(6), false, none)).toEqual({
      shown: ids(6),
      hidden: 0,
      collapsible: false,
    });
  });

  it('shows the first five once it would hide two or more', () => {
    const r = collapseList(ids(7), false, none);
    expect(r.shown).toEqual(ids(5));
    expect(r.hidden).toBe(2);
    expect(r.collapsible).toBe(true);
  });

  it('shows everything when asked, still collapsible', () => {
    expect(collapseList(ids(9), true, none)).toEqual({
      shown: ids(9),
      hidden: 0,
      collapsible: true,
    });
  });

  it('keeps the row you are on, in its place', () => {
    const r = collapseList(ids(10), false, { pinned: () => false, open: (id) => id === 'c8' });
    expect(r.shown).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c8']);
    expect(r.hidden).toBe(4);
  });

  it('shows the pinned ones, topped up from the top of the list', () => {
    const pinned = new Set(['c7', 'c9']);
    const r = collapseList(ids(10), false, { pinned: (id) => pinned.has(id), open: () => false });
    expect(r.shown).toEqual(['c0', 'c1', 'c2', 'c7', 'c9']);
    expect(r.hidden).toBe(5);
  });

  it('shows every pin, even past the limit', () => {
    const r = collapseList(ids(10), false, { pinned: (id) => id > 'c2', open: () => false });
    expect(r.shown).toEqual(ids(10).slice(3));
    expect(r.hidden).toBe(3);
  });

  it("doesn't collapse when pins and the open row would leave fewer than two hidden", () => {
    const allPinned = collapseList(ids(7), false, { pinned: () => true, open: () => false });
    expect(allPinned).toEqual({ shown: ids(7), hidden: 0, collapsible: false });
    const lastOpen = collapseList(ids(7), false, {
      pinned: () => false,
      open: (id) => id === 'c6',
    });
    expect(lastOpen).toEqual({ shown: ids(7), hidden: 0, collapsible: false });
  });

  it('shows the open row without bumping one of the five', () => {
    const r = collapseList(ids(10), false, {
      pinned: (id) => id === 'c9',
      open: (id) => id === 'c6',
    });
    expect(r.shown).toEqual(['c0', 'c1', 'c2', 'c3', 'c6', 'c9']);
  });
});
