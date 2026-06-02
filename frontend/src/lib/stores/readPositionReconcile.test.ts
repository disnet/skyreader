import { describe, it, expect } from 'vitest';
import type { ItemLabel } from '$lib/types';
import { staleReadLabelsInWindow } from './readPositionReconcile';

function label(overrides: Partial<ItemLabel> & { itemKey: string }): ItemLabel {
  return {
    itemType: 'article',
    label: 'read',
    props: {},
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const WINDOW_START = 1_000_000;

describe('staleReadLabelsInWindow', () => {
  it('removes in-window read labels that are absent from the server set', () => {
    const labels = [label({ itemKey: 'a', props: { readAt: WINDOW_START + 100 } })];
    const result = staleReadLabelsInWindow(labels, new Set(), WINDOW_START);
    expect(result).toEqual([['a', 'read']]);
  });

  it('keeps read labels still present on the server', () => {
    const labels = [label({ itemKey: 'a', props: { readAt: WINDOW_START + 100 } })];
    const result = staleReadLabelsInWindow(labels, new Set(['a']), WINDOW_START);
    expect(result).toEqual([]);
  });

  it('preserves out-of-window read labels even when absent from the server', () => {
    // The key safety property: a windowed full sync must NOT wipe older local
    // read state that the server simply no longer returns.
    const labels = [label({ itemKey: 'old', props: { readAt: WINDOW_START - 1 } })];
    const result = staleReadLabelsInWindow(labels, new Set(), WINDOW_START);
    expect(result).toEqual([]);
  });

  it('treats a readAt exactly at the window boundary as in-window', () => {
    const labels = [label({ itemKey: 'edge', props: { readAt: WINDOW_START } })];
    const result = staleReadLabelsInWindow(labels, new Set(), WINDOW_START);
    expect(result).toEqual([['edge', 'read']]);
  });

  it('treats a missing/zero readAt as out-of-window (never removed)', () => {
    const labels = [
      label({ itemKey: 'no-props', props: {} }),
      label({ itemKey: 'zero', props: { readAt: 0 } }),
    ];
    const result = staleReadLabelsInWindow(labels, new Set(), WINDOW_START);
    expect(result).toEqual([]);
  });

  it('ignores non-read labels and non-article types', () => {
    const labels = [
      label({
        itemKey: 'starred',
        label: 'starred',
        props: { readAt: WINDOW_START + 1 },
      }),
      label({
        itemKey: 'archived',
        label: 'archived',
        props: { readAt: WINDOW_START + 1 },
      }),
      label({
        itemKey: 'tagged',
        label: 'tag:foo',
        props: { readAt: WINDOW_START + 1 },
      }),
      label({
        itemKey: 'doc',
        itemType: 'document',
        props: { readAt: WINDOW_START + 1 },
      }),
    ];
    const result = staleReadLabelsInWindow(labels, new Set(), WINDOW_START);
    expect(result).toEqual([]);
  });

  it('returns only the in-window absent subset from a mixed set', () => {
    const labels = [
      label({ itemKey: 'remove-me', props: { readAt: WINDOW_START + 50 } }), // in-window, absent
      label({ itemKey: 'on-server', props: { readAt: WINDOW_START + 50 } }), // in-window, present
      label({ itemKey: 'too-old', props: { readAt: WINDOW_START - 50 } }), // out-of-window, absent
    ];
    const result = staleReadLabelsInWindow(labels, new Set(['on-server']), WINDOW_START);
    expect(result).toEqual([['remove-me', 'read']]);
  });

  it('accepts a Map values() iterator (as the store passes)', () => {
    const map = new Map<string, ItemLabel>([
      ['k1', label({ itemKey: 'a', props: { readAt: WINDOW_START + 1 } })],
      ['k2', label({ itemKey: 'b', props: { readAt: WINDOW_START + 1 } })],
    ]);
    const result = staleReadLabelsInWindow(map.values(), new Set(['a']), WINDOW_START);
    expect(result).toEqual([['b', 'read']]);
  });
});
