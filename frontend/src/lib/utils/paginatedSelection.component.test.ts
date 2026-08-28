import { beforeEach, describe, expect, it } from 'vitest';
import {
  firstVisibleTextPoint,
  lastVisibleTextPoint,
  selectionFocusRect,
  settledViewportRect,
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
    expect(firstVisibleTextPoint(root, viewport, measure)).toEqual({ node: text, offset: 4 });
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

  it('skips text nodes that are pages away instead of binary-searching them', () => {
    // Three paragraphs a page apart; only the middle one is on screen. Every
    // probe here is a forced range measurement in a real browser, on the frame
    // a page turn starts — so the scan must reject the off-page nodes cheaply.
    const root = document.createElement('div');
    const nodes = ['0123456789', 'abcdefghij', 'ABCDEFGHIJ'].map((chunk) => {
      const paragraph = document.createElement('p');
      const node = document.createTextNode(chunk);
      paragraph.append(node);
      root.append(paragraph);
      return node;
    });
    document.body.replaceChildren(root);
    const origins = new Map(nodes.map((node, index) => [node, index * 1000]));
    let measurements = 0;
    const measurePages: RangeMeasurer = (range) => {
      measurements++;
      const origin = origins.get(range.startContainer as Text) ?? 0;
      return rect(origin + range.startOffset * 10, origin + range.endOffset * 10);
    };

    expect(firstVisibleTextPoint(root, rect(1000, 1100), measurePages)).toEqual({
      node: nodes[1],
      offset: 1,
    });
    // One whole-node rejection each for the two off-page paragraphs, then the
    // search inside the one that's actually visible.
    expect(measurements).toBeLessThanOrEqual(8);
  });
});

describe('settled page geometry', () => {
  // A committed turn animates `.paged-content` for ~340ms. Everything the bridge
  // measures during that window is mid-flight, so it asks where the viewport
  // will sit relative to the content once the transform lands.
  it('describes the page being turned to while the transform is still moving', () => {
    const viewport = rect(0, 400);
    const oneFrameIn = rect(-20, 780); // 20px into a 400px forward turn
    expect(settledViewportRect(viewport, oneFrameIn, 1, 400)).toMatchObject({
      left: 380,
      right: 780,
    });
  });

  it('is the live viewport once the transform has settled', () => {
    const viewport = rect(0, 400);
    const atRest = rect(-400, 400);
    expect(settledViewportRect(viewport, atRest, 1, 400)).toMatchObject({ left: 0, right: 400 });
  });

  it('falls back to the live viewport before the flow has been measured', () => {
    const viewport = rect(0, 400);
    expect(settledViewportRect(viewport, rect(0, 400), 0, 0)).toBe(viewport);
  });
});
