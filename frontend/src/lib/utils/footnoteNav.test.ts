// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleFootnoteClick } from './footnoteNav';
import { closeFootnotePreview, currentFootnotePreview } from './footnotePreview';

/**
 * A content container holding one footnote reference and its list entry, the
 * shape `leaflet-renderer.ts` emits.
 */
function content(paged = false): {
  container: HTMLElement;
  ref: HTMLAnchorElement;
  backref: HTMLAnchorElement;
  entry: HTMLElement;
} {
  const host = document.createElement('div');
  if (paged) host.className = 'paged-content';
  host.innerHTML = `
    <div class="body">
      <p>Text<sup class="footnote-ref"><a href="#" data-footnote-ref="1">1</a></sup></p>
      <section class="footnotes">
        <ol>
          <li data-footnote-id="1">The note
            <a href="#" class="footnote-backref" data-footnote-backref="1">↩</a>
          </li>
        </ol>
      </section>
    </div>`;
  document.body.appendChild(host);
  return {
    container: host.querySelector('.body') as HTMLElement,
    ref: host.querySelector('a[data-footnote-ref]') as HTMLAnchorElement,
    backref: host.querySelector('a[data-footnote-backref]') as HTMLAnchorElement,
    entry: host.querySelector('[data-footnote-id]') as HTMLElement,
  };
}

/**
 * Dispatch a real click on `el` and run the helper from a listener on it, so
 * `preventDefault` / `stopPropagation` can be observed the way a caller sees
 * them. `reachedAncestor` reports whether the click still bubbled out of the
 * container (i.e. whether a host's own tap handler would have run).
 */
function click(
  el: HTMLElement,
  container: HTMLElement,
  options?: Parameters<typeof handleFootnoteClick>[2],
  init: MouseEventInit = {}
): { result: string; prevented: boolean; reachedAncestor: boolean } {
  let result = 'none';
  let reachedAncestor = false;
  const onEl = (e: Event) => {
    result = handleFootnoteClick(e as MouseEvent, container, options);
  };
  const onAncestor = () => {
    reachedAncestor = true;
  };
  el.addEventListener('click', onEl);
  document.body.addEventListener('click', onAncestor);
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(event);
  el.removeEventListener('click', onEl);
  document.body.removeEventListener('click', onAncestor);
  return { result, prevented: event.defaultPrevented, reachedAncestor };
}

let scrollIntoView: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // jsdom has no layout, so scrollIntoView isn't implemented.
  scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView as unknown as Element['scrollIntoView'];
});

afterEach(() => {
  closeFootnotePreview();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('handleFootnoteClick', () => {
  it('ignores clicks that are not on a footnote marker', () => {
    const { container } = content();
    const p = container.querySelector('p') as HTMLElement;
    const { result, prevented } = click(p, container);
    expect(result).toBe('none');
    expect(prevented).toBe(false);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('opens the note beside its marker without moving, and stops the event', () => {
    const { container, ref } = content();
    const { result, prevented, reachedAncestor } = click(ref, container);
    expect(result).toBe('handled');
    expect(prevented).toBe(true);
    expect(reachedAncestor).toBe(false);
    expect(scrollIntoView).not.toHaveBeenCalled();
    const card = currentFootnotePreview();
    expect(card?.textContent?.trim()).toBe('The note');
    expect(card?.getAttribute('role')).toBe('dialog');
    expect(card?.getAttribute('aria-label')).toBe('Note 1');
    // The way back is left out: the reader is already at the reference.
    expect(card?.querySelector('a')).toBeNull();
    expect(card?.querySelector('[data-footnote-id], [id]')).toBeNull();
  });

  it('puts the note away on a second tap of its marker, or on Escape', () => {
    const { container, ref } = content();
    click(ref, container);
    expect(currentFootnotePreview()).not.toBeNull();
    click(ref, container);
    expect(currentFootnotePreview()).toBeNull();

    click(ref, container);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    let readerSawEscape = false;
    const reader = () => (readerSawEscape = true);
    document.addEventListener('keydown', reader, true);
    document.body.dispatchEvent(escape);
    document.removeEventListener('keydown', reader, true);
    expect(currentFootnotePreview()).toBeNull();
    // Escape closes the note, not the reader around it.
    expect(readerSawEscape).toBe(false);
    expect(document.activeElement).toBe(ref);
  });

  it('puts the note away on a tap outside it or a scroll', () => {
    const { container, ref } = content();
    click(ref, container);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(currentFootnotePreview()).toBeNull();
    click(ref, container);
    document.dispatchEvent(new Event('scroll'));
    expect(currentFootnotePreview()).toBeNull();
  });

  it('sends a back-reference click to its marker', () => {
    const { container, ref, backref } = content();
    const { result } = click(backref, container);
    expect(result).toBe('handled');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(ref.classList.contains('footnote-flash')).toBe(true);
  });

  it('resolves within the given container, not across the page', () => {
    const first = content();
    const second = content();
    first.entry.firstChild!.textContent = 'First card’s note';
    click(second.ref, second.container);
    expect(currentFootnotePreview()?.textContent?.trim()).toBe('The note');
  });

  it('suppresses the link but leaves the click alone when jumping is off', () => {
    const { container, ref, entry } = content();
    const { result, prevented, reachedAncestor } = click(ref, container, { jump: false });
    // Prevented (the sanitizer rewrote the href to the source article) but still
    // bubbling, so the card's own tap handler expands it.
    expect(result).toBe('suppressed');
    expect(prevented).toBe(true);
    expect(reachedAncestor).toBe(true);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(entry.classList.contains('footnote-flash')).toBe(false);
  });

  it('shows the note in a paged flow too, without turning the page', () => {
    const { container, ref } = content(true);
    const goToElement = vi.fn();
    click(ref, container, { pagedController: () => ({ goToElement }) });
    expect(currentFootnotePreview()).not.toBeNull();
    expect(goToElement).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('turns the page instead of scrolling for the way back in a paged flow', () => {
    const { container, ref, backref } = content(true);
    const goToElement = vi.fn();
    const { result } = click(backref, container, { pagedController: () => ({ goToElement }) });
    expect(result).toBe('handled');
    // Scrolling would slide the overflow-hidden paged viewport sideways, and the
    // paginator (which positions pages with a transform) never resets that.
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(goToElement).toHaveBeenCalledWith(ref);
  });

  it('does nothing in a paged flow without a paginator', () => {
    const { container, ref, backref } = content(true);
    const { result } = click(backref, container, { pagedController: () => null });
    expect(result).toBe('handled');
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(ref.classList.contains('footnote-flash')).toBe(false);
  });

  it('consumes a modifier click instead of opening the rewritten href', () => {
    const { container, ref } = content();
    const { result, prevented, reachedAncestor } = click(ref, container, undefined, {
      metaKey: true,
    });
    // sanitizeHtml rewrote the placeholder href to the source article, so letting
    // the browser have this would open the whole post in a new tab. No jump
    // either — "open elsewhere" has no in-page meaning.
    expect(result).toBe('handled');
    expect(prevented).toBe(true);
    expect(reachedAncestor).toBe(false);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(currentFootnotePreview()).toBeNull();
  });

  it('consumes a modifier click even where jumping is off', () => {
    // The clamped card preview: an ordinary tap falls through to expand the card,
    // but a cmd-click still shouldn't leave the app.
    const { container, ref } = content();
    const { result, prevented } = click(ref, container, { jump: false }, { ctrlKey: true });
    expect(result).toBe('handled');
    expect(prevented).toBe(true);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('is inert for a malformed marker', () => {
    const { container, ref } = content();
    ref.dataset.footnoteRef = 'not-a-number';
    const { result, prevented } = click(ref, container);
    expect(result).toBe('handled');
    expect(prevented).toBe(true);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(currentFootnotePreview()).toBeNull();
  });
});

describe('a saved EPUB’s own links', () => {
  function book(paged = false) {
    const host = document.createElement('div');
    if (paged) host.className = 'paged-content';
    host.innerHTML = `
      <section id="epub-c1" data-epub-chapter="1"><p>Claim.<a id="epub-c1-r1" href="#epub-c2-n1" target="_blank">1</a>
        <a href="https://example.com/" target="_blank">out</a> <a href="#intro">page anchor</a>
        <a href="#epub-c2" class="toc">Chapter two</a></p></section>
      <section id="epub-c2" data-epub-chapter="2"><h2>Notes</h2><aside id="epub-c2-n1">The note.</aside></section>`;
    document.body.appendChild(host);
    return {
      container: host,
      marker: host.querySelector('a[href="#epub-c2-n1"]') as HTMLAnchorElement,
      note: host.querySelector('#epub-c2-n1') as HTMLElement,
    };
  }

  it('shows the note a book’s marker points at, in place', () => {
    const { container, marker } = book();
    const { result, prevented, reachedAncestor } = click(marker, container);
    expect(result).toBe('handled');
    expect(prevented).toBe(true);
    expect(reachedAncestor).toBe(false);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(currentFootnotePreview()?.textContent?.trim()).toBe('The note.');
  });

  it('jumps to a chapter, turning the page in paged mode', () => {
    const { container } = book(true);
    const toc = container.querySelector('a.toc') as HTMLAnchorElement;
    const chapter = container.querySelector('#epub-c2') as HTMLElement;
    const goToElement = vi.fn();
    click(toc, container, { pagedController: () => ({ goToElement }) });
    expect(goToElement).toHaveBeenCalledWith(chapter);
    expect(currentFootnotePreview()).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('leaves links out of the book, and other hash links, alone', () => {
    const { container } = book();
    for (const a of container.querySelectorAll<HTMLAnchorElement>('a:not([href^="#epub"])')) {
      expect(click(a, container).result).toBe('none');
    }
  });
});

describe('an article’s own in-page links', () => {
  /** The shape Defuddle and most blogs emit, after `sanitizeHtml` marks the links. */
  function article() {
    const host = document.createElement('div');
    host.innerHTML = `
      <p>A claim<sup id="fnref:1"><a href="https://ex.com/post#fn:1" data-in-page="fn:1">1</a></sup>
        and <a href="https://ex.com/post#later" data-in-page="later">the later part</a>
        and <a href="https://ex.com/post#gone" data-in-page="gone">a dropped id</a>.</p>
      <h2 id="later">Later</h2>
      <p>Substack style<a id="footnote-anchor-2" href="https://ex.com/post#footnote-2" data-in-page="footnote-2">2</a>.</p>
      <div id="footnotes"><ol>
        <li id="fn:1"><p>First note, see <a href="https://ex.com/post#fn:3" data-in-page="fn:3">3</a> and <a href="https://elsewhere.example/">a source</a>.
          <a class="footnote-backref" href="https://ex.com/post#fnref:1" data-in-page="fnref:1">↩</a></p></li>
        <li id="fn:3"><p>Third note.</p></li>
      </ol></div>
      <div class="footnote"><a id="footnote-2" href="https://ex.com/post#footnote-anchor-2" data-in-page="footnote-anchor-2">2</a>
        <div class="footnote-content"><p>Second note.</p></div></div>`;
    document.body.appendChild(host);
    const link = (id: string) => host.querySelector(`a[data-in-page="${id}"]`) as HTMLAnchorElement;
    return { container: host, link };
  }

  it('shows the note a marker points at, without the way back', () => {
    const { container, link } = article();
    expect(click(link('fn:1'), container).result).toBe('handled');
    const card = currentFootnotePreview();
    expect(card?.textContent).toContain('First note');
    expect(card?.textContent).not.toContain('↩');
    expect(card?.querySelector('li')).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('climbs from an anchor at the start of a note to the whole note', () => {
    const { container, link } = article();
    click(link('footnote-2'), container);
    const text = currentFootnotePreview()?.textContent?.replace(/\s+/g, ' ').trim();
    // The note's own number links back to the marker, so it's left out.
    expect(text).toBe('Second note.');
  });

  it('follows a note citing another note inside the card', () => {
    const { container, link } = article();
    click(link('fn:1'), container);
    const card = currentFootnotePreview()!;
    const inner = card.querySelector('a[data-in-page="fn:3"]') as HTMLAnchorElement;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    inner.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(currentFootnotePreview()?.textContent?.trim()).toBe('Third note.');
    // A link out of the article inside a note is left to open as usual.
    const out = currentFootnotePreview()!.querySelector('a');
    expect(out).toBeNull();
  });

  it('jumps to a heading rather than previewing it', () => {
    const { container, link } = article();
    click(link('later'), container);
    expect(currentFootnotePreview()).toBeNull();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('leaves a link whose place isn’t in the content to the caller', () => {
    const { container, link } = article();
    const { result, prevented } = click(link('gone'), container);
    expect(result).toBe('none');
    expect(prevented).toBe(false);
  });

  it('jumps back to the marker from a note’s way back', () => {
    const { container } = article();
    const back = container.querySelector('a.footnote-backref') as HTMLAnchorElement;
    click(back, container);
    expect(currentFootnotePreview()).toBeNull();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
