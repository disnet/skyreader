import { describe, expect, it } from 'vitest';
import {
  coerceHomeLayout,
  mergeHomeOrder,
  moveHomeSection,
  orderHomeSections,
  pruneHomeLayout,
} from './homeLayout';

describe('orderHomeSections', () => {
  const defaults = ['a', 'b', 'c', 'd'];

  it('uses the built-in order when nothing is saved', () => {
    expect(orderHomeSections(defaults, [])).toEqual(defaults);
  });

  it('follows the saved order', () => {
    expect(orderHomeSections(defaults, ['d', 'c', 'b', 'a'])).toEqual(['d', 'c', 'b', 'a']);
  });

  it('drops saved ids that no longer exist, and duplicates', () => {
    expect(orderHomeSections(['a', 'b'], ['gone', 'b', 'b', 'a'])).toEqual(['b', 'a']);
  });

  it('slots a new section in after its built-in predecessor', () => {
    // 'c' is new; its built-in predecessor 'b' sits first in the saved order.
    expect(orderHomeSections(defaults, ['b', 'd', 'a'])).toEqual(['b', 'c', 'd', 'a']);
  });

  it('puts a new first section at the top', () => {
    expect(orderHomeSections(defaults, ['c', 'b', 'd'])).toEqual(['a', 'c', 'b', 'd']);
  });

  it('keeps consecutive new sections together in built-in order', () => {
    expect(orderHomeSections(['a', 'x', 'y', 'b'], ['b', 'a'])).toEqual(['b', 'a', 'x', 'y']);
  });
});

describe('moveHomeSection', () => {
  it('swaps with a neighbour', () => {
    expect(moveHomeSection(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveHomeSection(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
  });

  it('is a no-op at the ends or for an unknown id', () => {
    const order = ['a', 'b'];
    expect(moveHomeSection(order, 'a', -1)).toBe(order);
    expect(moveHomeSection(order, 'b', 1)).toBe(order);
    expect(moveHomeSection(order, 'z', 1)).toBe(order);
  });
});

describe('coerceHomeLayout', () => {
  it('rejects junk', () => {
    expect(coerceHomeLayout(null)).toEqual({ order: [], hidden: [] });
    expect(coerceHomeLayout({ order: 'a', hidden: [1, 'x'] })).toEqual({
      order: [],
      hidden: ['x'],
    });
  });
});

describe('mergeHomeOrder', () => {
  it('keeps a saved id that is absent right now next to its old neighbour', () => {
    // 'room' isn't loaded; the reader swapped a and b.
    expect(mergeHomeOrder(['a', 'room', 'b'], ['b', 'a'])).toEqual(['b', 'a', 'room']);
  });

  it('takes the new order as-is when everything is present', () => {
    expect(mergeHomeOrder(['a', 'b'], ['b', 'a'])).toEqual(['b', 'a']);
    expect(mergeHomeOrder([], ['b', 'a'])).toEqual(['b', 'a']);
  });
});

describe('pruneHomeLayout', () => {
  const layout = {
    order: ['recent', 'channel:keep', 'room:x', 'channel:gone'],
    hidden: ['channel:gone', 'magazine'],
  };

  it('drops channels that no longer exist and keeps everything else', () => {
    expect(pruneHomeLayout(layout, new Set(['keep']))).toEqual({
      order: ['recent', 'channel:keep', 'room:x'],
      hidden: ['magazine'],
    });
  });

  it('prunes nothing before channels have loaded', () => {
    expect(pruneHomeLayout(layout, new Set())).toBe(layout);
  });
});
