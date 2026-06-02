/**
 * Svelte action for the depth shadow on a sticky bar that overlaps scrolling
 * content.
 *
 * Apply it to a 1px sentinel placed in normal flow just after a
 * `position: sticky` bar. The action watches whether the sentinel is in view:
 * while it sits below the fold the bar is pinned and overlapping content
 * ("floating"); once it scrolls into view the bar has reached its natural rest
 * position. The boolean is reported through `onChange` so the component can
 * toggle the bar's depth-shadow (and scroll-hide) classes itself, keeping the
 * presentation layer free of store wiring.
 *
 * `root` defaults to the viewport (`null`) to match the app's window scroll;
 * pass a scroll-container element to scope detection to it.
 */
export interface OverlapShadowOptions {
  onChange: (overlapping: boolean) => void;
  root?: Element | null;
}

export function overlapShadow(node: HTMLElement, options: OverlapShadowOptions) {
  let onChange = options.onChange;

  // Assume not-overlapping on mount: a freshly expanded card is scrolled to its
  // top, so this matches reality and avoids a one-frame shadow flash before the
  // observer's first async callback corrects it.
  onChange(false);

  const observer = new IntersectionObserver(([entry]) => onChange(!entry.isIntersecting), {
    root: options.root ?? null,
    threshold: 0,
  });
  observer.observe(node);

  return {
    update(next: OverlapShadowOptions) {
      onChange = next.onChange;
    },
    destroy() {
      observer.disconnect();
    },
  };
}
