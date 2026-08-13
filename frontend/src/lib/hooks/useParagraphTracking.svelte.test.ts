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
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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
});
