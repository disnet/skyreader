// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  setReadProgress,
  getReadProgress,
  getLatestReadProgress,
  flushReadProgress,
  getLabel,
  destroyCallbacks,
} = vi.hoisted(() => ({
  setReadProgress: vi.fn(),
  getReadProgress: vi.fn(),
  getLatestReadProgress: vi.fn(),
  flushReadProgress: vi.fn(),
  destroyCallbacks: [] as Array<() => void>,
  // The flush-time re-check: whatever is stored when the debounce fires, which
  // a delta may have replaced with another device's newer position since.
  getLabel: vi.fn(),
}));

vi.mock('$lib/stores/itemLabels.svelte', () => ({
  itemLabelsStore: {
    setReadProgress,
    getReadProgress,
    getLatestReadProgress,
    flushReadProgress,
    getLabel,
  },
}));

vi.mock('svelte', () => ({ onDestroy: (fn: () => void) => destroyCallbacks.push(fn) }));

import { useParagraphTracking } from './useParagraphTracking.svelte';

/**
 * Build an article body whose paragraphs all report a top edge above the viewport,
 * so a single scroll event walks the tracker to the last detected paragraph.
 */
function renderBody(paragraphCount: number): HTMLElement {
  const content = document.createElement('article');
  content.innerHTML = Array.from(
    { length: paragraphCount },
    (_, i) => `<p>Paragraph ${i} is comfortably longer than the tracking threshold.</p>`
  ).join('');
  for (const para of Array.from(content.querySelectorAll('p'))) {
    vi.spyOn(para, 'getBoundingClientRect').mockReturnValue({
      top: -1,
      bottom: 10,
      left: 0,
      right: 100,
      width: 100,
      height: 11,
      x: 0,
      y: -1,
      toJSON: () => ({}),
    });
  }
  document.body.append(content);
  return content;
}

function track(content: HTMLElement) {
  return useParagraphTracking({
    contentEl: () => content,
    scrollRoot: () => null,
    itemKey: () => 'article-key',
    itemType: () => 'article',
    enabled: () => true,
  });
}

describe('useParagraphTracking', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setReadProgress.mockReset();
    getReadProgress.mockReset();
    getLabel.mockReset();
    getLatestReadProgress.mockReset();
    flushReadProgress.mockReset();
    destroyCallbacks.length = 0;
    getLabel.mockReturnValue(undefined);
    getReadProgress.mockReturnValue({ paragraphIndex: 8, totalParagraphs: 20 });
    vi.stubGlobal('$state', <T>(value: T) => value);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    // jsdom implements no layout, so it leaves scrollIntoView undefined; the tests
    // below drive the resulting scroll events by hand instead.
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal('scrollTo', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (Element.prototype as Partial<Element>).scrollIntoView;
    document.body.replaceChildren();
  });

  it('does not overwrite hydrated progress during the initial body measurement', () => {
    const content = document.createElement('article');
    content.innerHTML =
      '<p>This fallback paragraph is long enough to be tracked while loading.</p>' +
      '<p>A second fallback paragraph makes a genuine scroll position observable.</p>';
    const firstParagraph = content.querySelector('p')!;
    vi.spyOn(firstParagraph, 'getBoundingClientRect').mockReturnValue({
      top: -1,
      bottom: 10,
      left: 0,
      right: 100,
      width: 100,
      height: 11,
      x: 0,
      y: -1,
      toJSON: () => ({}),
    });
    document.body.append(content);

    const tracking = useParagraphTracking({
      contentEl: () => content,
      scrollRoot: () => null,
      itemKey: () => 'article-key',
      itemType: () => 'article',
      enabled: () => true,
    });

    tracking.setupObserver();
    vi.advanceTimersByTime(1_000);

    expect(setReadProgress).not.toHaveBeenCalled();

    tracking.cleanup();
  });

  it('does not persist the clamped index when a partial restore scrolls', () => {
    getReadProgress.mockReturnValue({ paragraphIndex: 12, totalParagraphs: 40 });
    // Only the short description fallback has rendered so far.
    const content = renderBody(3);
    const tracking = track(content);

    tracking.setupObserver();
    expect(tracking.restorePosition()).toBe('partial');

    // The smooth scroll the restore kicked off keeps firing scroll events.
    window.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(200);
    window.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(2_000);

    expect(setReadProgress).not.toHaveBeenCalled();

    tracking.cleanup();
  });

  it('does not persist a genuine scroll while the body is still partial', () => {
    getReadProgress.mockReturnValue({ paragraphIndex: 12, totalParagraphs: 40 });
    const content = renderBody(3);
    const tracking = track(content);

    tracking.setupObserver();
    // No restore in flight — the reader themself nudges the fallback body.
    window.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(2_000);

    expect(setReadProgress).not.toHaveBeenCalled();

    tracking.cleanup();
  });

  it('persists scroll progress once the full body has loaded', () => {
    getReadProgress.mockReturnValue({ paragraphIndex: 12, totalParagraphs: 40 });
    const content = renderBody(40);
    const tracking = track(content);

    tracking.setupObserver();
    window.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(600);

    expect(setReadProgress).toHaveBeenCalledWith('article-key', 'article', 39, 40);

    tracking.cleanup();
  });

  it('restores into a loaded body without writing, but still saves paragraph steps', () => {
    getReadProgress.mockReturnValue({ paragraphIndex: 12, totalParagraphs: 40 });
    const content = renderBody(40);
    const tracking = track(content);

    tracking.setupObserver();
    expect(tracking.restorePosition()).toBe('exact');
    window.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(600);

    // The restore's own movement is not progress.
    expect(setReadProgress).not.toHaveBeenCalled();
    expect(tracking.currentParagraphIndex).toBe(12);

    // Stepping forward by keyboard still records where the reader got to.
    tracking.nextParagraph();
    vi.advanceTimersByTime(600);
    expect(setReadProgress).toHaveBeenCalledWith('article-key', 'article', 13, 40);

    tracking.cleanup();
  });
  // A delta can land during the 500 ms debounce and replace the stored position
  // with another device's newer one. Publishing the queued position afterwards
  // would rewind that device AND republish the older position as authoritative,
  // so the flush re-checks what is actually stored before writing.
  it('abandons a queued save when a newer position arrived while it waited', () => {
    getReadProgress.mockReturnValue({ paragraphIndex: 12, totalParagraphs: 40 });
    const content = renderBody(40);
    const tracking = track(content);

    tracking.setupObserver();
    window.dispatchEvent(new Event('scroll'));
    // Another device's progress, recorded after this save was queued.
    getLabel.mockReturnValue({ props: { lastReadAt: Date.now() + 10_000 } });
    vi.advanceTimersByTime(600);

    expect(setReadProgress).not.toHaveBeenCalled();

    tracking.cleanup();
  });

  it('restores the newest position filed under any of the item’s keys', () => {
    // Nothing under the open key: the place was saved under the save's AT-URI.
    getReadProgress.mockReturnValue(null);
    getLatestReadProgress.mockReturnValue({
      paragraphIndex: 12,
      totalParagraphs: 40,
      lastReadAt: 1,
    });
    const content = renderBody(40);
    const tracking = useParagraphTracking({
      contentEl: () => content,
      scrollRoot: () => null,
      itemKey: () => 'article-key',
      itemType: () => 'article',
      enabled: () => true,
      progressKeys: () => ['at://did/save/1'],
    });

    tracking.setupObserver();
    expect(tracking.restorePosition()).toBe('exact');
    expect(getLatestReadProgress).toHaveBeenCalledWith(['article-key', 'at://did/save/1']);
    expect(tracking.currentParagraphIndex).toBe(12);

    tracking.cleanup();
  });

  it('writes a queued position at once when the page is hidden', () => {
    getReadProgress.mockReturnValue({ paragraphIndex: 12, totalParagraphs: 40 });
    const content = renderBody(40);
    const tracking = track(content);

    tracking.setupObserver();
    window.dispatchEvent(new Event('scroll'));
    expect(setReadProgress).not.toHaveBeenCalled();

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(setReadProgress).toHaveBeenCalledWith('article-key', 'article', 39, 40);
    expect(flushReadProgress).toHaveBeenCalled();

    tracking.cleanup();
  });

  it('writes a queued position when the reader closes instead of dropping it', () => {
    getReadProgress.mockReturnValue({ paragraphIndex: 12, totalParagraphs: 40 });
    const content = renderBody(40);
    const tracking = track(content);

    tracking.setupObserver();
    window.dispatchEvent(new Event('scroll'));
    for (const destroy of destroyCallbacks) destroy();

    expect(setReadProgress).toHaveBeenCalledWith('article-key', 'article', 39, 40);
    expect(setReadProgress).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(setReadProgress).toHaveBeenCalledTimes(1);
  });

  // A host's key is derived from its item prop, which is already null when the
  // reader closes; the flush must not read it again then.
  it('writes a queued position on close after the host item is gone', () => {
    getLatestReadProgress.mockReturnValue({ paragraphIndex: 12, totalParagraphs: 40 });
    const content = renderBody(40);
    let item: { key: string } | null = { key: 'article-key' };
    const tracking = useParagraphTracking({
      contentEl: () => content,
      scrollRoot: () => null,
      itemKey: () => item!.key,
      itemType: () => 'article',
      enabled: () => true,
      progressKeys: () => [item!.key + '#alias'],
    });

    tracking.setupObserver();
    window.dispatchEvent(new Event('scroll'));
    item = null;
    for (const destroy of destroyCallbacks) destroy();

    expect(getLatestReadProgress).toHaveBeenLastCalledWith(['article-key', 'article-key#alias']);
    expect(setReadProgress).toHaveBeenCalledWith('article-key', 'article', 39, 40);
  });

  it('reports whether the reader has scrolled the open item by hand', () => {
    getReadProgress.mockReturnValue({ paragraphIndex: 12, totalParagraphs: 40 });
    const content = renderBody(40);
    const tracking = track(content);

    tracking.setupObserver();
    expect(tracking.readerMoved).toBe(false);
    // A restore is not the reader moving.
    tracking.restorePosition();
    expect(tracking.readerMoved).toBe(false);

    vi.advanceTimersByTime(1_100);
    window.dispatchEvent(new Event('scroll'));
    expect(tracking.readerMoved).toBe(true);

    tracking.cleanup();
  });

  it('counts a scroll soon after an instant restore, but not during a smooth step', () => {
    getReadProgress.mockReturnValue({ paragraphIndex: 12, totalParagraphs: 40 });
    const content = renderBody(40);
    const tracking = track(content);

    tracking.setupObserver();
    tracking.restorePosition();
    // A restore jumps instantly, so the mute is short: reading on right after
    // it is the reader's.
    vi.advanceTimersByTime(200);
    window.dispatchEvent(new Event('scroll'));
    expect(tracking.readerMoved).toBe(true);
    expect(tracking.currentParagraphIndex).toBe(39);

    // A smooth step still holds the scroll tracker off while it plays.
    tracking.prevParagraph();
    const stepped = tracking.currentParagraphIndex;
    vi.advanceTimersByTime(200);
    window.dispatchEvent(new Event('scroll'));
    expect(tracking.currentParagraphIndex).toBe(stepped);

    tracking.cleanup();
  });

  it('does not count a layout shift that leaves the reader on the restored paragraph', () => {
    getReadProgress.mockReturnValue({ paragraphIndex: 2, totalParagraphs: 5 });
    const content = renderBody(5);
    // Every paragraph sits below the top of the view, so a scroll (a picture
    // loading above, the browser keeping the text in place) leaves the reader on
    // the paragraph the restore jumped to.
    for (const para of Array.from(content.querySelectorAll('p'))) {
      vi.spyOn(para, 'getBoundingClientRect').mockReturnValue({
        top: 50,
        bottom: 60,
        left: 0,
        right: 100,
        width: 100,
        height: 10,
        x: 0,
        y: 50,
        toJSON: () => ({}),
      });
    }
    const tracking = track(content);

    tracking.setupObserver();
    tracking.restorePosition();
    vi.advanceTimersByTime(200);
    window.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(1_000);
    expect(tracking.currentParagraphIndex).toBe(2);
    expect(tracking.readerMoved).toBe(false);
    expect(setReadProgress).not.toHaveBeenCalled();

    tracking.cleanup();
  });

  it('counts a keyboard step as the reader moving', () => {
    getReadProgress.mockReturnValue({ paragraphIndex: 12, totalParagraphs: 40 });
    const content = renderBody(40);
    const tracking = track(content);

    tracking.setupObserver();
    tracking.restorePosition();
    expect(tracking.readerMoved).toBe(false);
    tracking.nextParagraph();
    expect(tracking.readerMoved).toBe(true);

    tracking.cleanup();
  });

  it('steps over quotes and nested lists without landing on the container', () => {
    const long = 'is comfortably longer than the tracking threshold.';
    const content = document.createElement('article');
    content.innerHTML = [
      `<p>A ${long}</p>`,
      `<blockquote><p>B ${long}</p><p>C ${long}</p></blockquote>`,
      `<ul><li>Parent ${long}<ul><li>D ${long}</li></ul></li></ul>`,
      `<p>E ${long}</p>`,
    ].join('');
    document.body.append(content);
    Element.prototype.scrollIntoView = vi.fn();
    const tracking = track(content);
    tracking.setupObserver();

    // Indices: 0 A, 1 blockquote, 2 B, 3 C, 4 parent li, 5 D, 6 E. The containers
    // keep their indices (saved positions depend on them) but steps skip them.
    const visited = [tracking.currentParagraphIndex];
    for (let i = 0; i < 5; i++) {
      tracking.nextParagraph();
      visited.push(tracking.currentParagraphIndex);
    }
    expect(visited).toEqual([0, 2, 3, 5, 6, 6]);
    for (let i = 0; i < 4; i++) {
      tracking.prevParagraph();
      visited.push(tracking.currentParagraphIndex);
    }
    expect(visited.slice(6)).toEqual([5, 3, 2, 0]);

    tracking.cleanup();
  });

  it('resumes a position saved on a container at its first child', () => {
    const long = 'is comfortably longer than the tracking threshold.';
    const content = document.createElement('article');
    content.innerHTML = `<p>A ${long}</p><blockquote><p>B ${long}</p><p>C ${long}</p></blockquote>`;
    document.body.append(content);
    Element.prototype.scrollIntoView = vi.fn();
    getReadProgress.mockReturnValue({ paragraphIndex: 1, totalParagraphs: 4 });
    const tracking = track(content);
    tracking.setupObserver();
    tracking.restorePosition();
    expect(tracking.currentParagraphIndex).toBe(2);
    tracking.cleanup();
  });

  describe('stepping moves the view like a cursor', () => {
    const long = 'is comfortably longer than the tracking threshold.';

    // A 600px scroller, scrolled to 1000 of 5000, at the top of the screen (edges inset 90px, 15%) holding
    // paragraphs laid out at the given [top, height] positions.
    function setup(layout: Array<[number, number]>) {
      const content = document.createElement('article');
      content.innerHTML = layout.map((_, i) => `<p>P${i} ${long}</p>`).join('');
      document.body.append(content);
      Array.from(content.querySelectorAll('p')).forEach((p, i) => {
        const [top, height] = layout[i];
        vi.spyOn(p, 'getBoundingClientRect').mockReturnValue(
          new DOMRect(0, top, height ? 100 : 0, height)
        );
      });
      const root = document.createElement('div');
      Object.defineProperty(root, 'clientHeight', { value: 600 });
      Object.defineProperty(root, 'scrollHeight', { value: 5000 });
      Object.defineProperty(root, 'scrollTop', { value: 1000 });
      vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 600));
      // The glide never starts here: scrollTop stays 1000 and the layout stays put.
      const scrollTo = vi.fn();
      root.scrollTo = scrollTo as typeof root.scrollTo;
      getReadProgress.mockReturnValue(null);
      const tracking = useParagraphTracking({
        contentEl: () => content,
        scrollRoot: () => root,
        itemKey: () => 'article-key',
        itemType: () => 'article',
        enabled: () => true,
      });
      tracking.setupObserver();
      return { tracking, scrollTo };
    }

    it('leaves the view alone while the next paragraph is in it', () => {
      const { tracking, scrollTo } = setup([
        [100, 100],
        [220, 100],
      ]);
      tracking.nextParagraph();
      expect(tracking.currentParagraphIndex).toBe(1);
      expect(scrollTo).not.toHaveBeenCalled();
      expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
      tracking.cleanup();
    });

    it('brings a paragraph to the top once it goes past the bottom edge', () => {
      const { tracking, scrollTo } = setup([
        [100, 100],
        [480, 100], // bottom 580 is under the 510 edge
      ]);
      tracking.nextParagraph();
      // Its top (480) to the top edge (90).
      expect(scrollTo).toHaveBeenCalledWith({ top: 1390, behavior: 'smooth' });
      tracking.cleanup();
    });

    it('brings a paragraph to the bottom once it goes past the top edge', () => {
      const { tracking, scrollTo } = setup([
        [20, 100], // top 20 is above the 90 edge
        [300, 100],
      ]);
      tracking.scrollToParagraph(1, { persist: false });
      vi.advanceTimersByTime(1100);
      tracking.prevParagraph();
      expect(tracking.currentParagraphIndex).toBe(0);
      // Its bottom (120) to the bottom edge (510).
      expect(scrollTo).toHaveBeenCalledWith({ top: 610, behavior: 'smooth' });
      tracking.cleanup();
    });

    it('lines a paragraph taller than the view up by its top', () => {
      const { tracking, scrollTo } = setup([
        [100, 100],
        [400, 900],
      ]);
      tracking.nextParagraph();
      expect(scrollTo).toHaveBeenCalledWith({ top: 1310, behavior: 'smooth' });
      tracking.cleanup();
    });

    it('still records the step when nothing scrolls', () => {
      const { tracking } = setup([
        [100, 100],
        [220, 100],
      ]);
      tracking.nextParagraph();
      vi.advanceTimersByTime(600);
      expect(setReadProgress).toHaveBeenCalledWith('article-key', 'article', 1, 2);
      tracking.cleanup();
    });

    it('counts a paragraph a pixel past the edge it was lined up on as in view', () => {
      const { tracking, scrollTo } = setup([
        [300, 100],
        [89.4, 100],
      ]);
      tracking.nextParagraph();
      expect(scrollTo).not.toHaveBeenCalled();
      tracking.cleanup();
    });

    it('leaves the view alone for a paragraph that isn’t laid out', () => {
      const { tracking, scrollTo } = setup([
        [100, 100],
        [0, 0],
      ]);
      tracking.nextParagraph();
      expect(scrollTo).not.toHaveBeenCalled();
      tracking.cleanup();
    });

    it('measures a step taken mid-glide against where the glide is headed', () => {
      const { tracking, scrollTo } = setup([
        [100, 100],
        [480, 100],
      ]);
      tracking.nextParagraph();
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 1390, behavior: 'smooth' });
      // Straight back: P0 looks in view now, but not once the glide lands 390
      // further on (it'd sit at -290), so the step scrolls rather than let the
      // glide carry it off. Its bottom (200 - 390) to the bottom edge (510).
      tracking.prevParagraph();
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 690, behavior: 'smooth' });
      tracking.cleanup();
    });

    it('aims a step no further than the view can scroll', () => {
      const { tracking, scrollTo } = setup([
        [100, 100],
        [4500, 100],
      ]);
      tracking.nextParagraph();
      // 1000 + 4410 would pass the end (5000 - 600).
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 4400, behavior: 'smooth' });
      tracking.cleanup();
    });
  });

  it('steps the window when the reader scrolls with the page', () => {
    const long = 'is comfortably longer than the tracking threshold.';
    const content = document.createElement('article');
    content.innerHTML = `<p>A ${long}</p><p>B ${long}</p>`;
    document.body.append(content);
    const [a, b] = Array.from(content.querySelectorAll('p'));
    vi.spyOn(a, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 200, 100, 100));
    vi.spyOn(b, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 900, 100, 100));
    vi.stubGlobal('innerHeight', 800);
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 5000,
      configurable: true,
    });
    getReadProgress.mockReturnValue(null);
    const tracking = track(content);
    tracking.setupObserver();
    tracking.nextParagraph();
    // B's top (900) to the window's top edge (96).
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 804, behavior: 'smooth' });
    tracking.cleanup();
  });
});
