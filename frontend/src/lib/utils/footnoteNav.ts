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

function scrollTo(el: Element | null): void {
  if (!el) return;

  const reduceMotion =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

  el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });

  el.classList.add('footnote-flash');
  setTimeout(() => el.classList.remove('footnote-flash'), FLASH_MS);
}

/**
 * Handle a click inside rendered content. Returns true when the click was a
 * footnote jump (already prevented and stopped), so callers can bail out of
 * their own content-click behavior.
 */
export function handleFootnoteClick(
  e: MouseEvent,
  container: HTMLElement | null | undefined
): boolean {
  const target = e.target as HTMLElement | null;
  if (!target) return false;

  const ref = target.closest<HTMLElement>('a[data-footnote-ref]');
  const backref = ref ? null : target.closest<HTMLElement>('a[data-footnote-backref]');
  if (!ref && !backref) return false;

  // The marker is a placeholder link; never follow it.
  e.preventDefault();
  e.stopPropagation();

  // Numbers are renderer-generated, but keep the selector well-formed regardless.
  const number = (ref?.dataset.footnoteRef ?? backref?.dataset.footnoteBackref ?? '').trim();
  if (!container || !/^\d+$/.test(number)) return true;

  scrollTo(
    ref
      ? container.querySelector(`[data-footnote-id="${number}"]`)
      : container.querySelector(`a[data-footnote-ref="${number}"]`)
  );
  return true;
}
