// Mounted component test (jsdom) — see the "component" project in vitest.config.ts.
import { describe, it, expect, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import SourceRow from './SourceRow.svelte';

const mounted: Record<string, any>[] = [];

const errorDetails = {
  title: 'Service Unavailable',
  description: 'temporarily unavailable',
  isPermanent: false,
  errorCount: 3,
  errorCode: 'HTTP 503',
  rawError: 'Feed fetch failed (HTTP 503)',
};

function render() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(SourceRow, {
    target,
    props: {
      iconUrl: null,
      title: 'Flaky Feed',
      subtitle: 'flaky.example.com',
      hasError: true,
      errorDetails,
      onRefresh: () => {},
      onRemove: () => {},
    },
  });
  flushSync();
  mounted.push(component);
  return { target };
}

describe('SourceRow error popover focus region', () => {
  afterEach(() => {
    for (const component of mounted.splice(0)) unmount(component);
    document.body.innerHTML = '';
  });

  it('keeps the popover open while focus moves from badge into it', () => {
    const { target } = render();
    const badge = target.querySelector<HTMLButtonElement>('.error-badge')!;
    badge.focus();
    flushSync();

    const popover = target.querySelector('.error-popover-container');
    expect(popover).not.toBeNull();

    // The popover is a DOM sibling right after the badge, so Tab lands on it.
    const summary = popover!.querySelector<HTMLElement>('summary')!;
    expect(badge.compareDocumentPosition(popover!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    summary.focus();
    flushSync();
    expect(target.querySelector('.error-popover-container')).not.toBeNull();
    expect(document.activeElement).toBe(summary);

    // Expanding the details still keeps the popover mounted.
    summary.click();
    flushSync();
    expect(target.querySelector('.error-popover-container')).not.toBeNull();
    expect(target.querySelector('.error-popover-container')!.textContent).toContain('HTTP 503');
  });

  it('closes when focus leaves the region', () => {
    const { target } = render();
    const badge = target.querySelector<HTMLButtonElement>('.error-badge')!;
    badge.focus();
    flushSync();
    expect(target.querySelector('.error-popover-container')).not.toBeNull();

    const outside = target.querySelector<HTMLButtonElement>('.action-btn')!;
    outside.focus();
    flushSync();
    expect(target.querySelector('.error-popover-container')).toBeNull();
  });

  it('closes on Escape and returns focus to the badge', () => {
    const { target } = render();
    const badge = target.querySelector<HTMLButtonElement>('.error-badge')!;
    badge.focus();
    flushSync();
    const summary = target.querySelector<HTMLElement>('.error-popover-container summary')!;
    summary.focus();
    flushSync();

    summary.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();
    expect(target.querySelector('.error-popover-container')).toBeNull();
    expect(document.activeElement).toBe(badge);
  });
});
