import { onDestroy } from 'svelte';
import { handleFootnoteClick, type FootnotePagedController } from '$lib/utils/footnoteNav';

export interface LinkMenuState {
  url: string;
  linkText: string;
  anchorRect: DOMRect;
}

const INTERACTIVE_MEDIA_SELECTOR = 'video, audio, iframe, embed, object';

interface LinkInterceptionParams {
  contentEl: () => HTMLElement | undefined;
  enabled: () => boolean;
  // Footnote markers jump within the content. False while the surface can't
  // honor a jump (the clamped card preview, whose footnotes list sits below the
  // line clamp) — the click is then left to the host's own tap handling.
  footnoteJump?: () => boolean;
  // The paginator when this content is laid out in paged mode, so a footnote
  // jump turns the page instead of scrolling (which would desync the columns).
  pagedController?: () => FootnotePagedController | null | undefined;
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

    // Footnote markers are placeholder links that jump within this content, so
    // they're resolved here rather than offered as an external link. This runs
    // in the capture phase, ahead of any handler on the content itself. A
    // 'suppressed' result already blocked the (rewritten) href but deliberately
    // left propagation alone, so the host's content tap still runs.
    const footnote = handleFootnoteClick(e, currentEl ?? params.contentEl(), {
      jump: params.footnoteJump?.() ?? true,
      pagedController: params.pagedController,
    });
    if (footnote !== 'none') return;

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
