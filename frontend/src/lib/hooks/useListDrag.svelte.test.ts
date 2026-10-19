// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useListDrag } from './useListDrag.svelte';

// Three 30px rows with a 2px gap, in a container that may scroll.
let containerTop = 0;
const container = { getBoundingClientRect: () => ({ top: containerTop }) } as unknown as Element;
function row(top: number) {
  return {
    getBoundingClientRect: () => ({ top: top + containerTop, bottom: top + 30 + containerTop }),
    closest: () => container,
    parentElement: container,
  } as unknown as HTMLElement;
}

function setup(ids = ['a', 'b', 'c']) {
  const list = { ids };
  const rows = [row(0), row(32), row(64)];
  const onDrop = vi.fn();
  const drag = useListDrag({ ids: () => list.ids, rows: () => rows, onDrop });
  return { drag, onDrop, list };
}

const down = (y: number) => ({ clientY: y, button: 0, pointerType: 'mouse' }) as PointerEvent;
const move = (y: number, buttons = 1) =>
  ({ clientY: y, buttons, preventDefault() {} }) as unknown as PointerEvent;

afterEach(() => {
  containerTop = 0;
  vi.useRealTimers();
});

describe('useListDrag', () => {
  it('lifts after a few pixels, follows the pointer and drops into the slot', () => {
    vi.useFakeTimers();
    const { drag, onDrop } = setup();
    drag.start(down(70), 'c');
    drag.move(move(68));
    expect(drag.lifted).toBe(false);
    drag.move(move(-20));
    expect(drag.lifted).toBe(true);
    // Held against the top of the list.
    expect(drag.offset(2)).toBe(-64);
    expect(drag.offset(0)).toBe(32);
    drag.end();
    vi.runAllTimers();
    expect(onDrop).toHaveBeenCalledWith(['c', 'a', 'b']);
    expect(drag.active).toBe(false);
  });

  it('keeps the row under the pointer when the list scrolls mid-drag', () => {
    const { drag } = setup();
    drag.start(down(5), 'a');
    drag.move(move(20));
    expect(drag.offset(0)).toBe(15);
    // The sidebar scrolls the rows up by 40px; the pointer stays put.
    containerTop = -40;
    drag.move(move(20));
    expect(drag.offset(0)).toBe(55);
  });

  it('forgets a press whose release it never heard', () => {
    const { drag, onDrop } = setup();
    drag.start(down(5), 'a');
    drag.move(move(40, 0));
    expect(drag.active).toBe(false);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('drops the drag if the list changes under it', () => {
    vi.useFakeTimers();
    const { drag, onDrop, list } = setup();
    drag.start(down(5), 'a');
    drag.move(move(80));
    drag.end();
    list.ids = ['a', 'b', 'c', 'd'];
    vi.runAllTimers();
    expect(onDrop).not.toHaveBeenCalled();
    expect(drag.active).toBe(false);
  });
});
