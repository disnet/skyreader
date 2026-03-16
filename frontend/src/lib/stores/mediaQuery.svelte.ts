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

  if (browser) {
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
