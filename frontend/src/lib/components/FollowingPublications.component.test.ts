// Mounted component test (jsdom) — see the "component" project in vitest.config.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { FollowingPublication } from '$lib/types';
import FollowingPublications from './FollowingPublications.svelte';

const store = {
  publications: [] as FollowingPublication[],
  loaded: true,
  loading: false,
  scanning: false,
  error: null,
  hiddenAccounts: [] as Array<Record<string, unknown>>,
  load: vi.fn(),
  subscribe: vi.fn(),
  hide: vi.fn(),
  unhide: vi.fn(),
};

const subs = { subscriptions: [] as Array<Record<string, unknown>> };

vi.mock('$lib/stores/followingPublications.svelte', () => ({
  get followingPublicationsStore() {
    return store;
  },
}));

vi.mock('$lib/stores/subscriptions.svelte', () => ({
  get subscriptionsStore() {
    return subs;
  },
}));

// One publication per account, so account groups and publication rows count 1:1
// except where a test says otherwise.
function pub(i: number): FollowingPublication {
  return {
    did: `did:plc:acct${i}`,
    handle: `acct${i}.bsky.social`,
    displayName: `Account ${i}`,
    publicationUri: `at://did:plc:acct${i}/site.standard.publication/pub`,
    name: `Publication ${i}`,
    description: `About publication ${i}`,
    url: `https://pub${i}.example.com`,
  };
}

let component: Record<string, any> | undefined;
let target: HTMLElement;

function render(props: Record<string, unknown> = {}) {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(FollowingPublications, { target, props });
  flushSync();
}

function accounts(): HTMLElement[] {
  return [...target.querySelectorAll<HTMLElement>('.account')];
}

function showMore(): HTMLButtonElement[] {
  return [...target.querySelectorAll<HTMLButtonElement>('.show-more')];
}

function countText(): string {
  return target.querySelector('.count')!.textContent!.replace(/\s+/g, ' ').trim();
}

function type(value: string) {
  const input = target.querySelector<HTMLInputElement>('input[type="search"]')!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

describe('FollowingPublications full variant windowing', () => {
  beforeEach(() => {
    store.publications = Array.from({ length: 30 }, (_, i) => pub(i));
    store.hiddenAccounts = [];
    store.scanning = false;
    subs.subscriptions = [];
  });

  afterEach(() => {
    if (component) unmount(component);
    component = undefined;
    document.body.innerHTML = '';
  });

  it('caps the list at 10 account groups and reveals the rest on Show more', () => {
    render();
    expect(accounts()).toHaveLength(10);
    expect(showMore()[0].textContent).toContain('Show 20 more');

    showMore()[0].click();
    flushSync();
    expect(accounts()).toHaveLength(30);
    expect(showMore()).toHaveLength(0);
  });

  it('labels each click with no more than the 25 groups it will reveal', () => {
    store.publications = Array.from({ length: 100 }, (_, i) => pub(i));
    render();

    expect(showMore()[0].textContent).toContain('Show 25 more');
    showMore()[0].click();
    flushSync();
    expect(accounts()).toHaveLength(35);
    expect(showMore()[0].textContent).toContain('Show 25 more');
  });

  it('keeps the count line reporting what the scan found, not what is on screen', () => {
    render();
    expect(countText()).toContain('30 publications from 30 accounts you follow');
  });

  it('filters on search and resets the window so late matches are visible', () => {
    render();
    // "Publication 29" is the last group, far past the initial window.
    type('Publication 29');
    expect(accounts()).toHaveLength(1);
    expect(showMore()).toHaveLength(0);
    expect(target.textContent).toContain('Publication 29');
    expect(countText()).toContain('1 of 30 accounts');

    type('');
    expect(accounts()).toHaveLength(10);
  });

  it('re-caps the window when the query changes after an expansion', () => {
    render();
    showMore()[0].click();
    flushSync();
    expect(accounts()).toHaveLength(30);

    type('Account');
    expect(accounts()).toHaveLength(10);
    expect(showMore()[0].textContent).toContain('Show 20 more');
  });

  it('reports no matches for a query that hits nothing', () => {
    render();
    type('nothing here');
    expect(accounts()).toHaveLength(0);
    expect(target.textContent).toContain('No publications match');
  });

  it('drops already-added accounts when Hide added is on, and resets the window', () => {
    subs.subscriptions = store.publications
      .slice(0, 8)
      .map((p) => ({ sourceType: 'atproto.documents', feedUrl: p.publicationUri }));
    render();
    showMore()[0].click();
    flushSync();
    expect(accounts()).toHaveLength(30);

    const toggle = target.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    toggle.click();
    flushSync();
    // 22 accounts left, re-windowed to 10.
    expect(accounts()).toHaveLength(10);
    expect(showMore()[0].textContent).toContain('Show 12 more');
    expect(countText()).toContain('22 of 30 accounts');
  });
});

describe('FollowingPublications suggestions variant', () => {
  afterEach(() => {
    if (component) unmount(component);
    component = undefined;
    document.body.innerHTML = '';
  });

  it('still honours the limit, with no toolbar or Show more', () => {
    store.publications = Array.from({ length: 30 }, (_, i) => pub(i));
    subs.subscriptions = [];
    render({
      variant: 'suggestions',
      limit: 3,
      heading: 'Publications from people you follow',
    });

    expect(target.querySelectorAll('.suggestion')).toHaveLength(3);
    expect(accounts()).toHaveLength(0);
    expect(showMore()).toHaveLength(0);
    expect(target.querySelector('.discovery-toolbar')).toBeNull();
  });
});
