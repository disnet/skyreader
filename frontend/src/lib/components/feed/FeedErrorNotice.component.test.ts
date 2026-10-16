// Mounted component test (jsdom) — see the "component" project in vitest.config.ts.
import { describe, it, expect, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import FeedErrorNotice from './FeedErrorNotice.svelte';
import type { ErrorDetails } from '$lib/stores/feedStatus.svelte';

const mounted: Record<string, any>[] = [];

function render(errorDetails: ErrorDetails) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(FeedErrorNotice, { target, props: { errorDetails } }));
  flushSync();
  return target;
}

describe('FeedErrorNotice', () => {
  afterEach(() => {
    for (const component of mounted.splice(0)) unmount(component);
    document.body.innerHTML = '';
  });

  it('shows the error title, explanation and raw detail inline', () => {
    const target = render({
      title: 'Blocked by site',
      description: "This site doesn't allow Skyreader's feed fetcher.",
      isPermanent: true,
      errorCount: 2,
      errorCode: 'HTTP 403',
      rawError: 'Site is blocking automated access (HTTP 403)',
    });
    const notice = target.querySelector('.feed-error-notice')!;
    expect(notice.classList.contains('permanent')).toBe(true);
    expect(notice.textContent).toContain('Blocked by site');
    expect(notice.textContent).toContain("doesn't allow Skyreader's feed fetcher");
    expect(notice.textContent).toContain('Failed 2 times');
    expect(notice.querySelector('code')?.textContent).toContain('blocking automated access');
  });

  it('omits the count and technical details when there are none', () => {
    const target = render({
      title: 'Temporarily Unavailable',
      description: 'There was a problem loading this feed.',
      isPermanent: false,
      errorCount: 1,
    });
    const notice = target.querySelector('.feed-error-notice')!;
    expect(notice.classList.contains('permanent')).toBe(false);
    expect(notice.textContent).not.toContain('Failed');
    expect(notice.querySelector('details')).toBeNull();
  });
});
