// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleFootnoteClick } from './footnoteNav';

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

  it('scrolls to the entry, stops the event, and flashes the target', () => {
    vi.useFakeTimers();
    const { container, ref, entry } = content();
    const { result, prevented, reachedAncestor } = click(ref, container);
    expect(result).toBe('handled');
    expect(prevented).toBe(true);
    expect(reachedAncestor).toBe(false);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(entry.classList.contains('footnote-flash')).toBe(true);
    vi.advanceTimersByTime(1500);
    expect(entry.classList.contains('footnote-flash')).toBe(false);
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
    click(second.ref, second.container);
    expect(second.entry.classList.contains('footnote-flash')).toBe(true);
    expect(first.entry.classList.contains('footnote-flash')).toBe(false);
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

  it('turns the page instead of scrolling inside a paged flow', () => {
    const { container, ref, entry } = content(true);
    const goToElement = vi.fn();
    const { result } = click(ref, container, { pagedController: () => ({ goToElement }) });
    expect(result).toBe('handled');
    // Scrolling would slide the overflow-hidden paged viewport sideways, and the
    // paginator (which positions pages with a transform) never resets that.
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(goToElement).toHaveBeenCalledWith(entry);
  });

  it('does nothing in a paged flow without a paginator', () => {
    const { container, ref, entry } = content(true);
    const { result } = click(ref, container, { pagedController: () => null });
    expect(result).toBe('handled');
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(entry.classList.contains('footnote-flash')).toBe(false);
  });

  it('consumes a modifier click instead of opening the rewritten href', () => {
    const { container, ref, entry } = content();
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
    expect(entry.classList.contains('footnote-flash')).toBe(false);
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
  });
});
