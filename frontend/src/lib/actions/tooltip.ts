/**
 * Svelte action for a lightweight hover/focus tooltip.
 *
 * Apply to any element: `<button use:tooltip={'Save private highlight'}>`. On
 * hover (after a short delay) or keyboard focus, a small floating bubble is
 * portaled to `document.body` and positioned above the element (flipping below
 * when there isn't room). It dismisses on mouse-leave, blur, or click.
 *
 * Body-portaled so it escapes `overflow: hidden` / `transform` ancestors and
 * stacks above floating UI like popovers. Styling lives in the global
 * `.app-tooltip` class (app.css) so it tracks the design tokens.
 *
 * Pair with an `aria-label` on the element for screen-reader users — the bubble
 * is decorative (`pointer-events: none`) and not a replacement for one.
 */
const SHOW_DELAY_MS = 350;

export function tooltip(node: HTMLElement, text: string) {
  let label = text;
  let bubble: HTMLDivElement | null = null;
  let showTimer: ReturnType<typeof setTimeout> | undefined;

  function place() {
    if (!bubble) return;
    const anchor = node.getBoundingClientRect();
    const tip = bubble.getBoundingClientRect();
    const gap = 6;

    // Prefer above the anchor; flip below if it would clip the top edge.
    let top = anchor.top - gap - tip.height;
    if (top < 8) top = anchor.bottom + gap;

    let left = anchor.left + anchor.width / 2 - tip.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tip.width - 8));

    bubble.style.top = `${Math.round(top)}px`;
    bubble.style.left = `${Math.round(left)}px`;
  }

  function show() {
    if (bubble || !label) return;
    bubble = document.createElement('div');
    bubble.className = 'app-tooltip';
    bubble.setAttribute('role', 'tooltip');
    bubble.textContent = label;
    document.body.appendChild(bubble);
    place();
    requestAnimationFrame(() => bubble?.classList.add('app-tooltip--visible'));
  }

  function scheduleShow() {
    clearTimeout(showTimer);
    showTimer = setTimeout(show, SHOW_DELAY_MS);
  }

  function hide() {
    clearTimeout(showTimer);
    bubble?.remove();
    bubble = null;
  }

  node.addEventListener('mouseenter', scheduleShow);
  node.addEventListener('mouseleave', hide);
  node.addEventListener('focus', show);
  node.addEventListener('blur', hide);
  node.addEventListener('click', hide);

  return {
    update(next: string) {
      label = next;
      if (bubble) bubble.textContent = next;
    },
    destroy() {
      hide();
      node.removeEventListener('mouseenter', scheduleShow);
      node.removeEventListener('mouseleave', hide);
      node.removeEventListener('focus', show);
      node.removeEventListener('blur', hide);
      node.removeEventListener('click', hide);
    },
  };
}
