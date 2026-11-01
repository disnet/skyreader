import { browser } from '$app/environment';
import { onDestroy } from 'svelte';

import { SHELL_MOBILE_QUERY } from '$lib/utils/shellMedia.js';

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
    const mql = window.matchMedia(SHELL_MOBILE_QUERY);
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
