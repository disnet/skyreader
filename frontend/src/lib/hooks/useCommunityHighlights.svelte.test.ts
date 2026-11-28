// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';

const group = {
  id: 'g1',
  selector: { type: 'TextQuoteSelector', exact: 'made rather than applied' },
  people: [{ did: 'did:plc:a', handle: 'a.example', displayName: 'A', note: null }],
};
vi.mock('$lib/stores/communityHighlights.svelte', () => ({
  communityHighlightsStore: {
    get: () => ({ groups: [group], failed: false, capped: false }),
    load: vi.fn(),
  },
}));

const { useCommunityHighlights } = await import('./useCommunityHighlights.svelte');

let cleanup = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
  document.body.innerHTML = '';
});

function setup() {
  const el = document.createElement('div');
  el.innerHTML = '<p>Ink marks that look made rather than applied, so that.</p>';
  document.body.append(el);
  let hook!: ReturnType<typeof useCommunityHighlights>;
  cleanup = $effect.root(() => {
    hook = useCommunityHighlights({
      contentEl: () => el,
      itemUrl: () => 'https://example.com/a',
      enabled: () => true,
    });
  });
  flushSync();
  hook.attach();
  const mark = el.querySelector<HTMLElement>('mark.community-highlight')!;
  return { el, mark };
}

describe('useCommunityHighlights', () => {
  // A focusable mark under a press is focused, and in Chromium a press on its
  // first glyph then starts no selection at all.
  it('takes a pressed mark out of the tab order until the press ends', () => {
    const { mark } = setup();
    expect(mark.getAttribute('tabindex')).toBe('0');
    mark.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(mark.hasAttribute('tabindex')).toBe(false);
    window.dispatchEvent(new Event('pointerup'));
    expect(mark.getAttribute('tabindex')).toBe('0');
  });

  it('puts the mark back when the press is cancelled', () => {
    const { mark } = setup();
    mark.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    window.dispatchEvent(new Event('pointercancel'));
    expect(mark.getAttribute('tabindex')).toBe('0');
  });
});
