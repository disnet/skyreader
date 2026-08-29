import type { Page } from '@playwright/test';

/**
 * Browser-side twin of `frontend/src/lib/utils/appScroll.ts`.
 *
 * Above 1000px the app shell frames its content in a card pinned to the
 * viewport, and that card — not the window — is what scrolls. Tests that
 * position a list or assert a scroll offset have to ask the same question the
 * app does, or they measure a window that never moves.
 *
 * The predicate runs in the page rather than importing app code into the test
 * process, so it stays a copy of the rule, not a dependency on it.
 */

/** Current scroll offset of whichever surface is scrolling. */
export function appScrollTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    const pane = window.matchMedia('(min-width: 1001px)').matches
      ? document.getElementById('app-scroll')
      : null;
    return Math.round(pane ? pane.scrollTop : window.scrollY);
  });
}

/** Scroll whichever surface is scrolling to an absolute offset. */
export function appScrollTo(page: Page, top: number): Promise<void> {
  return page.evaluate((value) => {
    const pane = window.matchMedia('(min-width: 1001px)').matches
      ? document.getElementById('app-scroll')
      : null;
    if (pane) pane.scrollTop = value;
    else window.scrollTo(0, value);
  }, top);
}
