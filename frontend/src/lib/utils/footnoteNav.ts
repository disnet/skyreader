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

  const modified = e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
  // An article's own in-page link is a real link to the source page at that
  // place, so "open elsewhere" keeps its meaning there: leave it to the browser.
  if (modified && inPage) return 'none';

  // The marker is a placeholder link; never follow it.
  e.preventDefault();

  // A modifier / non-primary click on a real link means "open a copy elsewhere",
  // but this href is the sanitizer's rewrite to the source article, so honoring
  // it would open the whole post in a new tab. An in-page jump has no
  // open-elsewhere form either, so consume the gesture and do nothing — the same
  // outcome on every surface, rather than one that depends on which entry point
  // sees the click first.
  if (modified) {
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

/** The id a link points at in this content, whichever kind of link it is. */
function linkTargetId(a: Element): string | null {
  const href = a.getAttribute('href');
  if (isEpubAnchorHref(href)) return href.slice(1);
  return a.hasAttribute('data-in-page') ? inPageTarget(a) : null;
}

/** The ids at a link and around it, up to `container`. */
function idsAround(el: HTMLElement, container: HTMLElement): Set<string> {
  const ids = new Set<string>();
  for (let at: HTMLElement | null = el; at && at !== container; at = at.parentElement) {
    if (at.id) ids.add(at.id);
  }
  return ids;
}

/** Whether `root` is, holds, or sits in a link that points back at one of `ids`. */
function linksBackTo(root: HTMLElement, ids: Set<string>): boolean {
  if (ids.size === 0) return false;
  const links = [root.closest('a'), ...root.querySelectorAll('a')];
  return links.some((a) => {
    const id = a && linkTargetId(a);
    return Boolean(id && ids.has(id));
  });
}

/** Where a note tends to live: a notes list, an aside, something named for notes. */
const NOTE_PLACE =
  'li, aside, [data-footnote-id], [role~="doc-footnote"], [role~="doc-endnote"], [class*="footnote"], [class*="endnote"], [id^="fn"], [id*="footnote"], [id*="note"]';

/**
 * Whether following `link` to `destination` should show a note beside it rather
 * than go there. A note's way back (the ↩, or Substack's note number, which
 * points at the marker before it) goes back. So does anything that doesn't read
 * as a note: a heading, a chapter, a long passage, or a contents entry pointing
 * at a chapter title set as a plain paragraph.
 */
function shouldPreview(link: HTMLElement, destination: HTMLElement, container: HTMLElement) {
  if (isBackLink(link)) return false;
  const ids = idsAround(link, container);
  const precedes = Boolean(
    destination.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING
  );
  // A two-way pair whose other end comes first: this is the way back.
  if (precedes && linksBackTo(destination, ids)) return false;

  const block = noteBlock(destination, container);
  if (!isPreviewable(block)) return false;

  // Reads as a marker: a raised or bracketed number, a symbol.
  const text = (link.textContent ?? '').replace(/[[\]()]/g, '').trim();
  if (link.closest('sup') || link.matches('[data-footnote-ref], [role~="doc-noteref"]')) {
    return true;
  }
  if (text.length > 0 && text.length <= 4) return true;
  // Or points at something that lives where notes do, or that links back to it.
  const place = destination.closest(NOTE_PLACE);
  if (place && container.contains(place) && place !== container) return true;
  return linksBackTo(block, ids);
}

/** Open a note beside its marker, or go to a place that isn't one. */
function follow(
  link: HTMLElement,
  destination: HTMLElement,
  container: HTMLElement,
  options: FootnoteNavOptions
): void {
  if (!shouldPreview(link, destination, container)) {
    closeFootnotePreview();
    jumpTo(destination, options);
    return;
  }
  openFootnotePreview(link, noteBlock(destination, container), container, {
    // A note that cites another note (or this content's own places) follows it
    // here too, in the same card, rather than through the rewritten href.
    onInnerLink: (inner, e) => {
      const ours =
        inner.matches('a[data-footnote-ref], a[data-footnote-backref]') ||
        isEpubAnchorHref(inner.getAttribute('href'));
      const to = resolveInner(inner, container);
      if (!to) {
        // A placeholder or book link has nothing real to open; don't let it try.
        if (ours) e.preventDefault();
        return ours;
      }
      e.preventDefault();
      e.stopPropagation();
      // The link in the card is a copy; judge it by its original where there is
      // one, so its place in the text (and its ids) count.
      if (!shouldPreview(inner, to, container)) {
        closeFootnotePreview();
        jumpTo(to, options);
      } else {
        replaceFootnotePreview(noteBlock(to, container), inner);
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
  const id = linkTargetId(link);
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

/** Where a footnote, book or in-page link points, looking ids up in `ids`. */
function destinationOf(
  link: HTMLElement,
  container: HTMLElement,
  ids: Map<string, HTMLElement>
): HTMLElement | null {
  if (link.hasAttribute('data-footnote-ref') || isEpubAnchorHref(link.getAttribute('href'))) {
    return resolveLink(link, container);
  }
  const id = link.getAttribute('data-in-page');
  return id ? (ids.get(id) ?? null) : null;
}

/** Every id (and `<a name>`) in `container`, first one winning, as `findById` does. */
function idIndex(container: HTMLElement): Map<string, HTMLElement> {
  const ids = new Map<string, HTMLElement>();
  for (const el of container.querySelectorAll<HTMLElement>('[id], a[name]')) {
    const name = el.tagName === 'A' ? el.getAttribute('name') : null;
    for (const key of [el.id, name]) if (key && !ids.has(key)) ids.set(key, el);
  }
  return ids;
}

/**
 * Mark the links in `container` that open a note beside them (the ones
 * `handleFootnoteClick` previews), so they look like what they are, a small
 * button (`a[data-note-marker]` in app.css), and say so to a screen reader.
 * A link that only jumps (a contents entry, a heading link, a note's ↩) is left
 * a link. Run again when the content changes; it only ever touches markers.
 */
export function markNoteMarkers(container: HTMLElement): void {
  const links = container.querySelectorAll<HTMLElement>(
    'a[data-footnote-ref], a[href^="#epub-c"], a[data-in-page]'
  );
  if (links.length === 0) return;
  const ids = idIndex(container);
  for (const link of links) {
    const destination = destinationOf(link, container, ids);
    const marker = Boolean(destination && shouldPreview(link, destination, container));
    if (marker === link.hasAttribute('data-note-marker')) continue;
    if (marker) {
      link.setAttribute('data-note-marker', '');
      link.setAttribute('role', 'button');
      link.setAttribute('aria-haspopup', 'dialog');
      link.setAttribute('aria-expanded', 'false');
      const label = (link.textContent ?? '').replace(/[[\]()]/g, '').trim();
      if (!link.hasAttribute('aria-label') && label.length > 0 && label.length <= 4) {
        link.setAttribute('aria-label', `Footnote ${label}`);
      }
    } else {
      for (const name of ['data-note-marker', 'role', 'aria-haspopup', 'aria-expanded']) {
        link.removeAttribute(name);
      }
    }
  }
}

/**
 * Svelte action: keep the note markers in rendered content marked
 * (`markNoteMarkers`) as it renders and re-renders, and let Space press one,
 * as it would any button (Enter already follows a link).
 */
export function noteMarkers(node: HTMLElement) {
  const mark = () => markNoteMarkers(node);
  mark();
  const observer = new MutationObserver(mark);
  observer.observe(node, { childList: true, subtree: true });
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== ' ' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const marker = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('a[data-note-marker]');
    if (!marker || !node.contains(marker)) return;
    e.preventDefault();
    e.stopPropagation();
    marker.click();
  };
  // Window capture: ahead of the paged reader's Space page turn (document capture).
  window.addEventListener('keydown', onKeyDown, true);
  return {
    destroy() {
      observer.disconnect();
      window.removeEventListener('keydown', onKeyDown, true);
    },
  };
}
