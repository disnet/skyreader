// An anchored menu or panel (Style, Share, Save) puts itself away when the
// reader moves on: a press outside it and its anchor, a scroll gesture outside
// (wheel or touch drag, not `scroll`, which also fires when the page reflows or
// a phone lifts a focused input above its keyboard, and inside so the menu's
// own list can scroll), or focus moving to
// something outside. Focus dropping to nothing, e.g. a button disabling under
// it, doesn't count.

/**
 * `parts` are the menu and its anchor, read when an event arrives. `listen()`
 * adds the document listeners and returns their removal; `onFocusOut` goes on
 * the menu element.
 */
export function outsideDismiss(
  parts: () => Array<Node | null | undefined>,
  close: () => void
): { listen: () => () => void; onFocusOut: (e: FocusEvent) => void } {
  function inside(target: EventTarget | null): boolean {
    const node = target as Node | null;
    return Boolean(node && parts().some((part) => part?.contains(node)));
  }

  function onOutside(e: Event) {
    if (!inside(e.target)) close();
  }

  return {
    listen() {
      document.addEventListener('pointerdown', onOutside, true);
      document.addEventListener('wheel', onOutside, { capture: true, passive: true });
      document.addEventListener('touchmove', onOutside, { capture: true, passive: true });
      return () => {
        document.removeEventListener('pointerdown', onOutside, true);
        document.removeEventListener('wheel', onOutside, true);
        document.removeEventListener('touchmove', onOutside, true);
      };
    },
    onFocusOut(e: FocusEvent) {
      if (e.relatedTarget && !inside(e.relatedTarget)) close();
    },
  };
}
