import { beforeEach, describe, expect, it } from 'vitest';
import {
  firstVisibleTextPoint,
  lastVisibleTextPoint,
  selectionFocusRect,
  visibleClientRect,
  type RangeMeasurer,
} from './paginatedSelection';

function rect(left: number, right: number): DOMRect {
  return {
    left,
    right,
    top: 0,
    bottom: 20,
    width: right - left,
    height: 20,
    x: left,
    y: 0,
    toJSON: () => ({}),
  };
}

describe('paginated selection geometry', () => {
  let root: HTMLElement;
  let text: Text;
  let measure: RangeMeasurer;

  beforeEach(() => {
    root = document.createElement('div');
    text = document.createTextNode('abcdefghij');
    root.append(text);
    document.body.replaceChildren(root);
    measure = (range) => {
      const start = range.startOffset;
      const end = range.endOffset;
      return rect(start * 10, end * 10);
    };
  });

  it('finds the first and last character visible in a page viewport', () => {
    const viewport = rect(30, 70);
    expect(firstVisibleTextPoint(root, viewport, measure)).toEqual({ node: text, offset: 3 });
    expect(lastVisibleTextPoint(root, viewport, measure)).toEqual({ node: text, offset: 7 });
  });

  it('measures a focus at a text-node boundary', () => {
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(text, 5);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selectionFocusRect(selection, measure)).toMatchObject({ left: 50, right: 50 });
  });

  it('uses the last on-screen client rect as the popover anchor', () => {
    expect(
      visibleClientRect([rect(-100, -20), rect(10, 30), rect(50, 80)], rect(0, 60))
    ).toMatchObject({ left: 50, right: 80 });
  });
});
