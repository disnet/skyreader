import { findEpubAnchor, isEpubAnchorHref } from './epubContent';
import {
  closeFootnotePreview,
  closeFootnotePreviewWithin,
  inPageTarget,
  isBackLink,
  isFootnotePreviewFor,
  isPreviewable,
  noteBlock,
  openFootnotePreview,
  replaceFootnotePreview,
} from './footnotePreview';

/**
 * In-page navigation for the footnotes rendered by `leaflet-renderer.ts`, for a
 * saved EPUB's own links (`#epub-c3-note12`, see `utils/epubContent.ts`), which a
 * book with no base URL keeps as real hash links, and for any article's own
 * in-page links, which `sanitizeHtml` marks with `data-in-page` (the id they
 * point at) before rewriting their href to the source article.
 *
 * A link to a note opens the note beside it (`footnotePreview.ts`) instead of
 * jumping to the end of the article. A link to a heading or a chapter (a table
 * of contents), or a note's way back (↩), still jumps.
 *
 * The markers are anchors with `data-footnote-ref` / `data-footnote-backref`
 * rather than real hash links: `sanitizeHtml` rewrites `href="#…"` to the
 * source article and forces `target="_blank"` on every anchor (it also
 * processes untrusted feed HTML, so it isn't loosened for our own output).
 * Lookups are scoped to the clicked content container, so several Leaflet
 * cards on one page can't collide the way document-global `id`s would.
 */

/** How long the arrival highlight stays on the jumped-to element. */
const FLASH_MS = 1200;

/**
 * The slice of `PagedController` this needs. Structural, so the helper doesn't
 * have to import a type out of a `.svelte` module.
 */
export interface FootnotePagedController {
  goToElement: (el: HTMLElement) => void;
}

export interface FootnoteNavOptions {
  /**
   * False when the surface can't honor a jump — today the clamped card preview,
   * where the footnotes list is below the line clamp. The click is still kept
   * from following its (rewritten) href, but propagation is left alone so the
   * caller's ordinary content tap runs and expands the card.
   */
  jump?: boolean;
  /**
   * Paged reading: the paginator for the flow this content sits in. Paged mode
   * lays the body out in horizontally overflowing columns inside an
   * `overflow: hidden` viewport and positions pages with a transform, so
   * `scrollIntoView` would scroll that viewport sideways and desync every
   * subsequent page turn. Inside a paged flow we turn the page instead.
   */
  pagedController?: () => FootnotePagedController | null | undefined;
}

/**
 * - `none` — not a footnote click; the caller's own handling applies.
 * - `handled` — jumped; the event is prevented *and* stopped, so callers bail.
 * - `suppressed` — a footnote click the surface can't jump for: prevented only,
 *   and the caller should treat it as a tap on ordinary text (not on a link).
 */
export type FootnoteClickResult = 'none' | 'handled' | 'suppressed';

function flash(el: Element): void {
  el.classList.add('footnote-flash');
  setTimeout(() => el.classList.remove('footnote-flash'), FLASH_MS);
}

function jumpTo(el: Element | null, options: FootnoteNavOptions): void {
  if (!el) return;

  // Paged mode: never scroll (see `pagedController` above) — turn to the page the
  // target sits on. Without a paginator to ask, do nothing rather than scroll the
  // paged viewport out of sync.
  if (el.closest('.paged-content')) {
    const controller = options.pagedController?.();
    if (!controller) return;
    controller.goToElement(el as HTMLElement);
    flash(el);
    return;
  }

  const reduceMotion =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

  el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
  flash(el);
}

/**
 * Handle a click inside rendered content. See `FootnoteClickResult` for what the
 * caller should do with each outcome.
 */
export function handleFootnoteClick(
  e: MouseEvent,
  container: HTMLElement | null | undefined,
  options: FootnoteNavOptions = {}
): FootnoteClickResult {
  const target = e.target as HTMLElement | null;
  if (!target) return 'none';

  const ref = target.closest<HTMLElement>('a[data-footnote-ref]');
  const backref = ref ? null : target.closest<HTMLElement>('a[data-footnote-backref]');
  const anchor = ref || backref ? null : target.closest<HTMLElement>('a[href]');
  const bookHref = anchor?.getAttribute('href') ?? null;
  const bookLink = isEpubAnchorHref(bookHref);
  // An article's own in-page link counts only when what it points at is in this
  // content: otherwise (an id the extractor dropped) it stays the link to the
  // source article it was rewritten to.
  const inPage =
    anchor && !bookLink && anchor.hasAttribute('data-in-page') && container
      ? findById(container, anchor.getAttribute('data-in-page') ?? '')
      : null;
  if (!ref && !backref && !bookLink && !inPage) return 'none';

  // The marker is a placeholder link; never follow it.
  e.preventDefault();

  // A modifier / non-primary click on a real link means "open a copy elsewhere",
  // but this href is the sanitizer's rewrite to the source article, so honoring
  // it would open the whole post in a new tab. An in-page jump has no
  // open-elsewhere form either, so consume the gesture and do nothing — the same
  // outcome on every surface, rather than one that depends on which entry point
  // sees the click first.
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
    e.stopPropagation();
    return 'handled';
  }

  // The surface can't jump right now — leave the click to the caller.
  if (options.jump === false) return 'suppressed';

  e.stopPropagation();
  if (!container) return 'handled';

  const link = (ref ?? backref ?? anchor) as HTMLElement;
  // A second tap on the marker whose note is showing puts it away.
  if (isFootnotePreviewFor(link)) {
    closeFootnotePreview();
    return 'handled';
  }

  const destination = resolveLink(link, container);
  if (destination) follow(link, destination, container, options);
  return 'handled';
}

/** Where a footnote, book or in-page link points, inside `container`. */
function resolveLink(link: HTMLElement, container: HTMLElement): HTMLElement | null {
  const refNumber = link.dataset.footnoteRef ?? link.dataset.footnoteBackref;
  if (refNumber !== undefined) {
    // Numbers are renderer-generated, but keep the selector well-formed regardless.
    const number = refNumber.trim();
    if (!/^\d+$/.test(number)) return null;
    return link.hasAttribute('data-footnote-ref')
      ? container.querySelector<HTMLElement>(`[data-footnote-id="${number}"]`)
      : container.querySelector<HTMLElement>(`a[data-footnote-ref="${number}"]`);
  }
  const href = link.getAttribute('href');
  if (isEpubAnchorHref(href)) return findEpubAnchor(container, href);
  const id = link.getAttribute('data-in-page');
  return id ? findById(container, id) : null;
}

/**
 * The element with this id inside `container`. Ids come from feed HTML, so
 * they're matched by comparison rather than built into a selector (`fn:1`,
 * Defuddle's footnote ids, isn't a valid `#id` selector anyway).
 */
function findById(container: HTMLElement, id: string): HTMLElement | null {
  if (!id) return null;
  for (const el of container.querySelectorAll<HTMLElement>('[id], a[name]')) {
    if (el.id === id || (el.tagName === 'A' && el.getAttribute('name') === id)) return el;
  }
  return null;
}

/** Open a note beside its marker, or go to a place that isn't one. */
function follow(
  link: HTMLElement,
  destination: HTMLElement,
  container: HTMLElement,
  options: FootnoteNavOptions
): void {
  const block = noteBlock(destination, container);
  if (isBackLink(link) || !isPreviewable(block)) {
    closeFootnotePreview();
    jumpTo(destination, options);
    return;
  }
  openFootnotePreview(link, block, container, {
    // A note that cites another note (or this content's own places) follows it
    // here too, in the same card, rather than through the rewritten href.
    onInnerLink: (inner, e) => {
      const to = resolveInner(inner, container);
      if (!to) return false;
      e.preventDefault();
      e.stopPropagation();
      const innerBlock = noteBlock(to, container);
      if (isBackLink(inner) || !isPreviewable(innerBlock)) {
        closeFootnotePreview();
        jumpTo(to, options);
      } else {
        replaceFootnotePreview(innerBlock);
      }
      return true;
    },
  });
}

/** Where a link inside a note card points in the content it came from. */
function resolveInner(link: HTMLElement, container: HTMLElement): HTMLElement | null {
  if (link.matches('a[data-footnote-ref], a[data-footnote-backref]')) {
    return resolveLink(link, container);
  }
  const href = link.getAttribute('href');
  if (isEpubAnchorHref(href)) return findEpubAnchor(container, href);
  if (!link.hasAttribute('data-in-page')) return null;
  const id = inPageTarget(link);
  return id ? findById(container, id) : null;
}

/**
 * Svelte action: delegate footnote clicks for a block of rendered content that
 * has no click handling of its own (the curated-edition pieces). Capture phase,
 * so it wins over anything the content itself attaches.
 */
export function footnoteNav(node: HTMLElement, options: FootnoteNavOptions = {}) {
  let current = options;
  const onClick = (e: MouseEvent) => {
    handleFootnoteClick(e, node, current);
  };
  node.addEventListener('click', onClick, true);
  return {
    update(next: FootnoteNavOptions = {}) {
      current = next;
    },
    destroy() {
      node.removeEventListener('click', onClick, true);
      closeFootnotePreviewWithin(node);
    },
  };
}
