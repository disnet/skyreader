/**
 * In-page navigation for the footnotes rendered by `leaflet-renderer.ts`.
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
  if (!ref && !backref) return 'none';

  // The marker is a placeholder link; never follow it.
  e.preventDefault();

  // The surface can't jump right now — leave the click to the caller.
  if (options.jump === false) return 'suppressed';

  e.stopPropagation();

  // Numbers are renderer-generated, but keep the selector well-formed regardless.
  const number = (ref?.dataset.footnoteRef ?? backref?.dataset.footnoteBackref ?? '').trim();
  if (!container || !/^\d+$/.test(number)) return 'handled';

  jumpTo(
    ref
      ? container.querySelector(`[data-footnote-id="${number}"]`)
      : container.querySelector(`a[data-footnote-ref="${number}"]`),
    options
  );
  return 'handled';
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
    },
  };
}
