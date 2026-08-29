/**
 * Svelte action that relocates a page's control bar into the app shell's
 * toolbar strip — the band of ground colour above the content card.
 *
 * The card is a fixed frame whose list scrolls inside it, so its top edge has
 * to stay put. A control bar rendered by the page therefore cannot live in the
 * card and still sit above it: it has to escape into the shell's own grid row.
 * Moving the node (rather than duplicating markup or threading a snippet
 * through a store) keeps every page owning its own controls, keeps Svelte's
 * scoped classes and event handlers attached, and lands in the same commit as
 * mount, so nothing flashes in the wrong place first.
 *
 * Below the shell breakpoint the strip is `display: none` and the mobile bottom
 * bar takes over, which is what the page bars already do on their own — so the
 * move is unconditional and the breakpoint stays in CSS.
 */
export const SHELL_TOOLBAR_ID = 'shell-toolbar';

export function shellToolbar(node: HTMLElement) {
  const target = document.getElementById(SHELL_TOOLBAR_ID);
  // No strip means no app shell (the /dev harness escapes the root layout).
  // Leave the bar where the page put it.
  if (!target) return {};

  target.appendChild(node);

  return {
    destroy() {
      node.remove();
    },
  };
}
