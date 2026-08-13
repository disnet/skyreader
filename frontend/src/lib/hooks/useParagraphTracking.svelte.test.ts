// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { setReadProgress, getReadProgress } = vi.hoisted(() => ({
  setReadProgress: vi.fn(),
  getReadProgress: vi.fn(),
}));

vi.mock('$lib/stores/itemLabels.svelte', () => ({
  itemLabelsStore: { setReadProgress, getReadProgress },
}));

vi.mock('svelte', () => ({ onDestroy: vi.fn() }));

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
    getReadProgress.mockReturnValue({ paragraphIndex: 8, totalParagraphs: 20 });
    vi.stubGlobal('$state', <T>(value: T) => value);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    // jsdom implements no layout, so it leaves scrollIntoView undefined; the tests
    // below drive the resulting scroll events by hand instead.
    Element.prototype.scrollIntoView = vi.fn();
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
});
