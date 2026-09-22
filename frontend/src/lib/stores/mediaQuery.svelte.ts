import { browser } from '$app/environment';
import { onDestroy } from 'svelte';

/** Mobile breakpoint in pixels — keep in sync with CSS @media (max-width: 1000px) rules */
export const MOBILE_BREAKPOINT = 1000;

/**
 * Shared reactive mobile state. Call once at the top level of your component tree
 * (e.g. +page.svelte) to start tracking. Other components can import and read directly.
 */
function createMobileStore() {
  let isMobile = $state(false);

  // `typeof matchMedia` as well as `browser`: this store is now imported at
  // module scope by feedView (the initial page size depends on it), so anything
  // that imports a feed store — including jsdom component tests — evaluates this
  // line. jsdom has no matchMedia, and throwing here would take the importing
  // module down with it. Non-mobile is the right answer where we can't ask.
  if (browser && typeof window.matchMedia === 'function') {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`);
    isMobile = mql.matches;
    mql.addEventListener('change', (e) => {
      isMobile = e.matches;
    });
  }

  return {
    get isMobile() {
      return isMobile;
    },
  };
}

export const mobileStore = createMobileStore();
