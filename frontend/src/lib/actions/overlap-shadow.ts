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

// Dead-band (px) between the float-on and float-off thresholds. Toggling the
// floating state changes the bar's own height (on mobile its padding tightens,
// ~24px total), which shifts this in-flow sentinel. Without hysteresis that
// shift pushes the sentinel back across a single threshold and the state
// oscillates ("jitter") when you park a slow scroll right at the boundary. The
// band must comfortably exceed that height change so the toggle can never
// reverse itself.
const HYSTERESIS_PX = 32;

export function overlapShadow(node: HTMLElement, options: OverlapShadowOptions) {
  let onChange = options.onChange;
  const root = options.root ?? null;

  // Assume not-overlapping on mount: a freshly expanded card is scrolled to its
  // top, so this matches reality and avoids a one-frame shadow flash before the
  // observer's first async callback corrects it.
  let overlapping = false;
  onChange(false);

  let observer: IntersectionObserver;

  // Re-arm the observer for the current state. While resting we flip to floating
  // the moment the sentinel leaves the viewport (margin 0); while floating we
  // require it to come HYSTERESIS_PX back inside before resting (negative bottom
  // margin). That gap is the dead-band that absorbs the bar's own resize.
  function arm() {
    observer?.disconnect();
    const rootMargin = overlapping ? `0px 0px -${HYSTERESIS_PX}px 0px` : '0px';
    observer = new IntersectionObserver(
      ([entry]) => {
        const next = !entry.isIntersecting;
        if (next === overlapping) return;
        overlapping = next;
        onChange(next);
        arm();
      },
      { root, threshold: 0, rootMargin }
    );
    observer.observe(node);
  }

  arm();

  return {
    update(next: OverlapShadowOptions) {
      onChange = next.onChange;
    },
    destroy() {
      observer?.disconnect();
    },
  };
}
