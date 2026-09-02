import { onDestroy } from 'svelte';
import { handleFootnoteClick, type FootnotePagedController } from '$lib/utils/footnoteNav';

export interface LinkMenuState {
  url: string;
  linkText: string;
  anchorRect: DOMRect;
  imageUrl?: string;
  pageUrl?: string;
  /** The image's own description, for a Currents save's alt text. */
  imageAlt?: string;
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
  pageUrl?: () => string | undefined;
}

function imageSource(image: HTMLImageElement): string {
  const candidates = image.srcset
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
  return candidates.at(-1) || image.currentSrc || image.src;
}

export function useLinkInterception(params: LinkInterceptionParams) {
  let menuState = $state<LinkMenuState | null>(null);
  let currentHandler: ((e: MouseEvent) => void) | null = null;
  let currentEl: HTMLElement | null = null;

  function handleClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.closest(INTERACTIVE_MEDIA_SELECTOR)) return;

    // Footnote markers are placeholder links that jump within this content, so
    // they're resolved here rather than offered as an external link. This runs
    // in the capture phase, ahead of any handler on the content itself, and
    // ahead of the modifier-click bail below: the marker's href is the
    // sanitizer's rewrite to the source article, so a cmd/middle-click must not
    // be handed to the browser (the helper consumes those). A 'suppressed'
    // result already blocked the href but deliberately left propagation alone,
    // so the host's content tap still runs.
    const footnote = handleFootnoteClick(e, currentEl ?? params.contentEl(), {
      jump: params.footnoteJump?.() ?? true,
      pagedController: params.pagedController,
    });
    if (footnote !== 'none') return;

    // Let modifier clicks (cmd/ctrl/shift/middle-click) on real links use default
    // browser behavior
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;

    const image = target.closest('img') as HTMLImageElement | null;
    const link = target.closest('a[href]') as HTMLAnchorElement | null;
    if (!link && !image) return;
    if (!params.enabled()) return;

    e.preventDefault();
    e.stopPropagation();

    const resolvedImageUrl = image
      ? new URL(imageSource(image), params.pageUrl?.() || document.baseURI).href
      : undefined;
    const href = link?.getAttribute('href') || resolvedImageUrl;
    if (!href) return;

    menuState = {
      url: href,
      linkText: link?.textContent?.trim() || image?.alt || '',
      anchorRect: (link ?? image!).getBoundingClientRect(),
      ...(image
        ? {
            imageUrl: resolvedImageUrl,
            pageUrl: params.pageUrl?.(),
            imageAlt: image.alt || image.title || undefined,
          }
        : {}),
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
