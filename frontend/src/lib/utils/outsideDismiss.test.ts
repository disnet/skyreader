// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { outsideDismiss } from './outsideDismiss';

function setup() {
  const menu = document.createElement('div');
  const item = document.createElement('button');
  menu.append(item);
  const anchor = document.createElement('button');
  const elsewhere = document.createElement('button');
  document.body.append(menu, anchor, elsewhere);
  const close = vi.fn();
  const dismiss = outsideDismiss(() => [menu, anchor], close);
  return { menu, item, anchor, elsewhere, close, dismiss };
}

describe('outsideDismiss', () => {
  afterEach(() => document.body.replaceChildren());

  it('closes on a press or scroll gesture outside, not inside or on the anchor', () => {
    const { item, anchor, elsewhere, close, dismiss } = setup();
    const stop = dismiss.listen();
    item.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    anchor.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    item.dispatchEvent(new Event('wheel', { bubbles: true }));
    expect(close).not.toHaveBeenCalled();
    elsewhere.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    elsewhere.dispatchEvent(new Event('wheel', { bubbles: true }));
    elsewhere.dispatchEvent(new Event('touchmove', { bubbles: true }));
    expect(close).toHaveBeenCalledTimes(3);
    stop();
    elsewhere.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(close).toHaveBeenCalledTimes(3);
  });

  it('closes when focus moves outside, not when it drops to nothing', () => {
    const { item, elsewhere, close, dismiss } = setup();
    dismiss.onFocusOut(new FocusEvent('focusout', { relatedTarget: item }));
    dismiss.onFocusOut(new FocusEvent('focusout', { relatedTarget: null }));
    expect(close).not.toHaveBeenCalled();
    dismiss.onFocusOut(new FocusEvent('focusout', { relatedTarget: elsewhere }));
    expect(close).toHaveBeenCalledTimes(1);
  });
});
