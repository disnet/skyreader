/**
 * A footnote shown where it's referenced: a small card beside the marker holding
 * the note's text, so reading one doesn't send the reader to the end of the
 * article and leave them to find their way back.
 *
 * Built as plain DOM on `document.body` rather than as a component, because every
 * surface that renders article text reaches footnotes through one click helper
 * (`handleFootnoteClick` in `footnoteNav.ts`), and none of them has to mount
 * anything for this. On `body` and `position: fixed` so it sits outside the
 * paged reader's overflow-hidden, transformed columns (which it would otherwise
 * be clipped by, or counted into) and over the reader overlay. Nothing scrolls
 * or turns a page, so a reading position is never touched.
 *
 * One card at a time. It closes on a tap outside it, Escape (focus goes back to
 * the marker), a scroll or wheel that moves the marker away, a resize, any key
 * that does something else (a page turn, a shortcut), history navigation, or
 * when the content it came from is torn down.
 */

/** Elements a note's text is a block of. */
const BLOCK_SELECTOR =
  'li, p, aside, div, dd, dt, blockquote, section, footer, figure, figcaption, td, th, article';

/** Past this a "note" is a passage, and the reader is better off going there. */
const MAX_NOTE_CHARS = 4000;

/** Gap between the marker and the card, and the card and the screen edge. */
const GAP = 8;
const EDGE = 16;

/** Keys that scroll a long note while focus is in the card. */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

/** Keys that change nothing on their own, so they leave the card up. */
const INERT_KEYS = new Set(['Tab', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);

/** How far the marker may drift (a late image, scroll anchoring) before the card is left behind. */
const DRIFT = 4;

/** Which link text reads as a way back to the reference rather than part of the note. */
const BACK_TEXT = /^(?:↩|↑|\^|⤴|⮌|back|return)[\u{FE0E}\u{FE0F}]?$/iu;

/**
 * The block of text a footnote target stands for. A target is often the note
 * itself (`<li id="fn:1">`), but it can be an empty anchor or a number at the
 * start of the note (`<a id="footnote-1">1</a>` in Substack's markup), so climb
 * from an inline element to the block around it — never past `container`.
 */
export function noteBlock(target: HTMLElement, container: HTMLElement): HTMLElement {
  if (target.matches(BLOCK_SELECTOR) && (target.textContent ?? '').trim()) return target;
  const block = target.parentElement?.closest<HTMLElement>(BLOCK_SELECTOR);
  if (!block || block === container || !container.contains(block)) return target;
  return block;
}

/**
 * Whether `link` is the way back from a note to where it's referenced (the ↩
 * at the end of a note), which should keep jumping rather than preview the
 * paragraph it came from.
 */
export function isBackLink(link: Element): boolean {
  if (link.matches('[data-footnote-backref], [role="doc-backlink"]')) return true;
  if (/(?:^|[\s_-])back(?:ref|link)/i.test(link.getAttribute('class') ?? '')) return true;
  if (link.closest('[class*="backlink"], [class*="backref"]')) return true;
  return BACK_TEXT.test((link.textContent ?? '').trim());
}

/**
 * Whether the block a link points at reads as a note to preview, rather than a
 * place to go: not a heading or a chapter (a table of contents), and short.
 */
export function isPreviewable(block: HTMLElement): boolean {
  if (block.matches('h1, h2, h3, h4, h5, h6, section[data-epub-chapter]')) return false;
  if (block.querySelector('h1, h2, h3, h4, h5, h6')) return false;
  const text = (block.textContent ?? '').trim();
  return text.length > 0 && text.length <= MAX_NOTE_CHARS;
}

/**
 * The note's content, safe to show a second time: no ids (they'd duplicate the
 * article's), none of the reader's own decoration (highlight marks, note
 * glyphs, the arrival flash), and no links back to the reference — the reader is
 * already there.
 */
function noteContent(block: HTMLElement, refIds: Set<string>): DocumentFragment {
  const clone = block.cloneNode(true) as HTMLElement;
  for (const el of clone.querySelectorAll('.highlight-note-marker, .community-note-marker')) {
    el.remove();
  }
  for (const a of clone.querySelectorAll<HTMLElement>('a')) {
    const to = inPageTarget(a);
    if (isBackLink(a) || (to && refIds.has(to))) a.remove();
  }
  // A marker copied in is a button for the note it cites, but no note of its own is showing.
  for (const a of clone.querySelectorAll('a[aria-expanded][data-note-marker]')) {
    a.removeAttribute('aria-expanded');
  }
  // Wikipedia-style backlink wrappers are left empty by the pass above.
  for (const el of clone.querySelectorAll('[class*="backlink"], [class*="backref"]')) {
    if (!(el.textContent ?? '').trim()) el.remove();
  }
  for (const mark of clone.querySelectorAll('mark.highlight, mark.community-highlight')) {
    mark.replaceWith(...mark.childNodes);
  }
  for (const el of [clone, ...clone.querySelectorAll<HTMLElement>('[id], .jump-arrival')]) {
    el.removeAttribute('id');
    el.classList.remove('jump-arrival');
  }
  const fragment = document.createDocumentFragment();
  // A list item or table cell keeps its children only: on its own it would draw
  // a bullet or need a table around it.
  if (clone.matches('li, td, th, dt, dd')) fragment.append(...clone.childNodes);
  else fragment.append(clone);
  return fragment;
}

/** The id an in-page link points at, from the sanitizer's mark or a bare hash. */
export function inPageTarget(link: Element): string | null {
  const marked = link.getAttribute('data-in-page');
  if (marked) return marked;
  const href = link.getAttribute('href');
  if (href && href.startsWith('#') && href.length > 1) {
    try {
      return decodeURIComponent(href.slice(1));
    } catch {
      return href.slice(1);
    }
  }
  return null;
}

/** The ids at and around a reference, which a note's way-back link points to. */
function referenceIds(ref: HTMLElement, container: HTMLElement): Set<string> {
  const ids = new Set<string>();
  for (let el: HTMLElement | null = ref; el && el !== container; el = el.parentElement) {
    if (el.id) ids.add(el.id);
  }
  return ids;
}

/** A short label for the card, from the marker's own text: "1", "iv", "*". */
function markerLabel(ref: HTMLElement): string {
  const text = (ref.textContent ?? '').replace(/[[\]()]/g, '').trim();
  return text.length > 0 && text.length <= 4 ? text : '';
}

export interface FootnotePreviewOptions {
  /**
   * A click inside the card on a link to somewhere else in the same content (a
   * note that cites another note). Return true when it was handled.
   */
  onInnerLink?: (link: HTMLElement, e: MouseEvent) => boolean;
}

interface OpenPreview {
  card: HTMLElement;
  ref: HTMLElement;
  container: HTMLElement;
  teardown: () => void;
}

let open: OpenPreview | null = null;

/** The card currently showing, if any (for tests and callers that need to know). */
export function currentFootnotePreview(): HTMLElement | null {
  return open?.card ?? null;
}

/** Close the card; `restoreFocus` sends focus back to the marker it came from. */
export function closeFootnotePreview(restoreFocus = false): void {
  if (!open) return;
  const { card, ref, teardown } = open;
  open = null;
  teardown();
  if (ref.hasAttribute('data-note-marker')) ref.setAttribute('aria-expanded', 'false');
  // Focus left in the card would fall to <body> with it; send it back to the marker.
  const focusInCard = card.contains(document.activeElement);
  card.remove();
  if ((restoreFocus || focusInCard) && ref.isConnected) ref.focus({ preventScroll: true });
}

/** Close the card if it belongs to content inside `node` (which is going away). */
export function closeFootnotePreviewWithin(node: Node): void {
  if (open && (node === open.container || node.contains(open.container))) closeFootnotePreview();
}

/** Whether the card showing came from this marker. */
export function isFootnotePreviewFor(ref: HTMLElement): boolean {
  return open?.ref === ref;
}

function place(card: HTMLElement, ref: HTMLElement): void {
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const rect = ref.getBoundingClientRect();
  const width = Math.min(card.offsetWidth || 0, vw - EDGE * 2);
  // Measure the content at its natural height: a cap left from an earlier note
  // would make a longer one look short and land it over the marker.
  card.style.maxHeight = '';
  card.scrollTop = 0;
  const height = card.offsetHeight || 0;
  const below = vh - rect.bottom - GAP - EDGE;
  const above = rect.top - GAP - EDGE;
  const putBelow = height <= below || below >= above;
  const room = Math.max(putBelow ? below : above, 120);
  card.style.maxHeight = `${Math.floor(Math.min(room, vh * 0.6))}px`;
  const shown = Math.min(height, room);
  const top = putBelow ? rect.bottom + GAP : rect.top - GAP - shown;
  const center = rect.left + rect.width / 2;
  const left = Math.min(Math.max(center - width / 2, EDGE), Math.max(EDGE, vw - EDGE - width));
  card.style.top = `${Math.round(Math.max(EDGE, top))}px`;
  card.style.left = `${Math.round(left)}px`;
  card.dataset.side = putBelow ? 'below' : 'above';
}

/**
 * Put `block`'s content in the card (first open, or a note followed from inside
 * it). `from` is the link that led here: it names the card, and links back to
 * it are left out.
 */
function fill(card: HTMLElement, from: HTMLElement, block: HTMLElement, container: HTMLElement) {
  const label = markerLabel(from);
  card.setAttribute('aria-label', label ? `Note ${label}` : 'Note');
  const body = document.createElement('div');
  body.className = 'footnote-preview-body';
  body.append(noteContent(block, referenceIds(from, container)));
  card.replaceChildren(body);
}

/** Show `block` as the note for `ref`, replacing any card already open. */
export function openFootnotePreview(
  ref: HTMLElement,
  block: HTMLElement,
  container: HTMLElement,
  options: FootnotePreviewOptions = {}
): HTMLElement {
  closeFootnotePreview();

  const card = document.createElement('div');
  card.className = 'footnote-preview';
  card.setAttribute('role', 'dialog');
  card.tabIndex = -1;
  fill(card, ref, block, container);
  card.style.visibility = 'hidden';
  document.body.appendChild(card);
  place(card, ref);
  card.style.visibility = '';

  const onPointerDown = (e: PointerEvent) => {
    const target = e.target as Node | null;
    if (!target || card.contains(target)) return;
    // A press on the marker itself is left to its click, which toggles the card.
    if (ref.contains(target)) return;
    closeFootnotePreview();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      // Window capture runs ahead of the reader's own Escape (document capture),
      // so this closes the note, not the reader.
      e.preventDefault();
      e.stopPropagation();
      closeFootnotePreview(true);
      return;
    }
    if (INERT_KEYS.has(e.key)) return;
    // A long note scrolls by key while it has focus.
    const inCard = card.contains(document.activeElement);
    if (inCard && SCROLL_KEYS.has(e.key) && card.scrollHeight > card.clientHeight) return;
    // Anything else (a page turn, a shortcut opening a panel) moves on without the
    // note; the key still does what it does.
    closeFootnotePreview();
  };
  // Where the marker was when the card opened: a scroll that doesn't move it
  // (a lane loading elsewhere, scroll anchoring) leaves the card up.
  const anchor = ref.getBoundingClientRect();
  const markerMoved = () => {
    if (!ref.isConnected) return true;
    const now = ref.getBoundingClientRect();
    return Math.abs(now.top - anchor.top) > DRIFT || Math.abs(now.left - anchor.left) > DRIFT;
  };
  const onScroll = (e: Event) => {
    const target = e.target as Node | null;
    if (target && target !== document && card.contains(target)) return;
    if (markerMoved()) closeFootnotePreview();
  };
  // Paged mode turns a page on the wheel by transform, with no scroll event; the
  // wheel itself is the signal. Over the card, the wheel scrolls the note.
  const onWheel = (e: WheelEvent) => {
    const target = e.target as Node | null;
    if (target && card.contains(target)) return;
    closeFootnotePreview();
  };
  const onResize = () => closeFootnotePreview();
  const onPopState = () => closeFootnotePreview();
  const onClick = (e: MouseEvent) => {
    const link = (e.target as HTMLElement | null)?.closest<HTMLElement>('a[href]');
    if (!link || !card.contains(link)) return;
    if (options.onInnerLink?.(link, e)) return;
  };

  document.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('scroll', onScroll, true);
  document.addEventListener('wheel', onWheel, { capture: true, passive: true });
  window.addEventListener('resize', onResize);
  window.addEventListener('popstate', onPopState);
  card.addEventListener('click', onClick);

  open = {
    card,
    ref,
    container,
    teardown: () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('wheel', onWheel, { capture: true });
      window.removeEventListener('resize', onResize);
      window.removeEventListener('popstate', onPopState);
      card.removeEventListener('click', onClick);
    },
  };

  // A marked marker (footnoteNav.ts's `markNoteMarkers`) is a button that says
  // whether its note is showing.
  if (ref.hasAttribute('data-note-marker')) ref.setAttribute('aria-expanded', 'true');
  card.focus({ preventScroll: true });
  return card;
}

/** Show another note in the card already open (a note citing another note). */
export function replaceFootnotePreview(block: HTMLElement, from: HTMLElement): void {
  if (!open) return;
  fill(open.card, from, block, open.container);
  place(open.card, open.ref);
}
