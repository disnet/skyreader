import { browser } from '$app/environment';
import { MOBILE_BREAKPOINT } from '$lib/stores/mediaQuery.svelte';

/**
 * Where the app scrolls.
 *
 * Above the shell breakpoint the content pane is a framed card pinned to the
 * viewport, so the list scrolls *inside* it and `window.scrollY` never moves.
 * At or below the breakpoint the frame is off and the window scrolls, exactly
 * as it always has (the mobile URL-bar collapse and pull-to-refresh both depend
 * on that, so it is deliberately left alone).
 *
 * Everything that measures or moves the scroll position goes through here
 * rather than touching `window` directly, so one breakpoint owns the answer.
 * `/dev/*` escapes the app shell entirely and has no pane; the helpers fall
 * back to the window there too.
 */
export const APP_SCROLL_ID = 'app-scroll';

/**
 * The framed layout's media query — the single JS-side statement of the shell
 * breakpoint, kept in step with the `@media (min-width: 1001px)` blocks in
 * app.css and AppShell. Exported because the frame's ground colour has to be
 * mirrored into `<meta name="theme-color">`, which only JS can do.
 */
export const SHELL_FRAME_QUERY = `(min-width: ${MOBILE_BREAKPOINT + 1}px)`;

/** The scrolling pane, or null when the window is the scroller. */
export function appScrollElement(): HTMLElement | null {
  if (!browser) return null;
  if (!window.matchMedia(SHELL_FRAME_QUERY).matches) return null;
  return document.getElementById(APP_SCROLL_ID);
}

/** The scrolling surface, or null on the server where there is neither. */
function scroller(): HTMLElement | Window | null {
  return appScrollElement() ?? (browser ? window : null);
}

export function appScrollTop(): number {
  const el = appScrollElement();
  if (el) return el.scrollTop;
  return browser ? window.scrollY : 0;
}

export function appScrollTo(options: ScrollToOptions): void {
  scroller()?.scrollTo(options);
}

export function appScrollBy(options: ScrollToOptions): void {
  scroller()?.scrollBy(options);
}

/**
 * The visible scroll viewport in client coordinates. Callers that position an
 * element by fraction-of-viewport need the pane's box, not the window's — the
 * pane is inset by the toolbar strip and the frame gap.
 */
export function appViewportRect(): { top: number; height: number } {
  const el = appScrollElement();
  if (!el) return { top: 0, height: browser ? window.innerHeight : 0 };
  const rect = el.getBoundingClientRect();
  return { top: rect.top, height: rect.height };
}

/**
 * Subscribe to scroll on whichever surface is scrolling. Both targets are bound
 * so a viewport resize across the breakpoint can't strand the listener on the
 * wrong one; handlers read the position through `appScrollTop()`, which always
 * answers for the current breakpoint.
 */
export function onAppScroll(handler: () => void): () => void {
  if (!browser) return () => {};
  const pane = document.getElementById(APP_SCROLL_ID);
  window.addEventListener('scroll', handler, { passive: true });
  pane?.addEventListener('scroll', handler, { passive: true });
  return () => {
    window.removeEventListener('scroll', handler);
    pane?.removeEventListener('scroll', handler);
  };
}

/**
 * Run `handler` whenever the shell crosses its breakpoint — i.e. whenever the
 * answer from `appScrollElement()` changes. IntersectionObservers rooted on the
 * pane need re-arming at that moment.
 */
export function onAppScrollRootChange(handler: () => void): () => void {
  if (!browser) return () => {};
  const mql = window.matchMedia(SHELL_FRAME_QUERY);
  const listener = () => handler();
  mql.addEventListener('change', listener);
  return () => mql.removeEventListener('change', listener);
}
