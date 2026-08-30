import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import FeedItem from './FeedItem.svelte';
import type { Subscription } from '$lib/types';

const subscription: Subscription = {
  id: 1,
  rkey: 'abcdefghijklm',
  feedUrl: 'https://example.com/feed.xml',
  siteUrl: 'https://example.com',
  title: 'Example',
  tags: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  localUpdatedAt: 0,
};

function render(props: Record<string, unknown>) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  return mount(FeedItem, {
    target,
    props: {
      subscription,
      unreadCount: 0,
      isActive: false,
      onSelect: vi.fn(),
      onContextMenu: vi.fn(),
      onTouchStart: vi.fn(),
      onTouchEnd: vi.fn(),
      onTouchMove: vi.fn(),
      onRetry: vi.fn(),
      onMoreClick: vi.fn(),
      ...props,
    },
  });
}

describe('FeedItem', () => {
  let component: Record<string, any> | undefined;

  afterEach(() => {
    if (component) unmount(component);
    component = undefined;
    document.body.innerHTML = '';
  });

  // A refresh is one archive-wide timeline request, so nothing per-feed ever
  // arrives to settle a per-feed spinner. A source with no error must render its
  // favicon, not an indicator that spins for the life of the tab.
  it('renders the favicon and no spinner for a healthy feed', () => {
    component = render({ hasError: false });

    expect(document.querySelector('.feed-favicon')).not.toBeNull();
    expect(document.querySelector('[class*="spinner"]')).toBeNull();
  });

  it('renders the error badge and a retry control for a broken feed', () => {
    component = render({
      hasError: true,
      errorMessage: 'HTTP 404',
      errorDetails: {
        title: 'Feed Not Found',
        description: 'This feed could not be found.',
        isPermanent: true,
        errorCount: 3,
      },
    });

    expect(document.querySelector('.feed-error-icon')).not.toBeNull();
    expect(document.querySelector('.feed-favicon')).toBeNull();
    expect(document.querySelector('.retry-btn')).not.toBeNull();
  });
});
