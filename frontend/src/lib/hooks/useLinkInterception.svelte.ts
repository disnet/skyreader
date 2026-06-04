import { onDestroy } from 'svelte';

export interface LinkMenuState {
  url: string;
  linkText: string;
  anchorRect: DOMRect;
}

const INTERACTIVE_MEDIA_SELECTOR = 'video, audio, iframe, embed, object';

interface LinkInterceptionParams {
  contentEl: () => HTMLElement | undefined;
  enabled: () => boolean;
}

export function useLinkInterception(params: LinkInterceptionParams) {
  let menuState = $state<LinkMenuState | null>(null);
  let currentHandler: ((e: MouseEvent) => void) | null = null;
  let currentEl: HTMLElement | null = null;

  function handleClick(e: MouseEvent) {
    // Let modifier clicks (cmd/ctrl/shift/middle-click) use default browser behavior
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;

    const target = e.target as HTMLElement;
    if (target.closest(INTERACTIVE_MEDIA_SELECTOR)) return;

    const link = target.closest('a[href]') as HTMLAnchorElement | null;
    if (!link) return;
    if (!params.enabled()) return;

    e.preventDefault();
    e.stopPropagation();

    const href = link.getAttribute('href');
    if (!href) return;

    menuState = {
      url: href,
      linkText: link.textContent?.trim() || '',
      anchorRect: link.getBoundingClientRect(),
    };
  }

  function attach() {
    const el = params.contentEl();
    if (!el || el === currentEl) return;

    detach();
    currentEl = el;
    currentHandler = handleClick;
    el.addEventListener('click', currentHandler, true);
  }

  function detach() {
    if (currentEl && currentHandler) {
      currentEl.removeEventListener('click', currentHandler, true);
    }
    currentEl = null;
    currentHandler = null;
  }

  function closeMenu() {
    menuState = null;
  }

  // Open the same menu for a link outside the intercepted content area (e.g. a
  // link post's URL chip), reusing the one popup the article body uses.
  function openMenu(state: LinkMenuState) {
    menuState = state;
  }

  onDestroy(detach);

  return {
    get menuState() {
      return menuState;
    },
    closeMenu,
    openMenu,
    attach,
    detach,
  };
}
