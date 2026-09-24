// Mounted component test (jsdom) — see the "component" project in vitest.config.ts.
// A .svelte.test.ts so the filter props can be driven by $state.
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

// The page owns search and "Hide added"; the section reads them as props.
const filters = $state({ query: '', hideAdded: false });
// What the section reports back for its tab.
let shown: number | null = null;

function render() {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(FollowingPublications, {
    target,
    props: {
      get query() {
        return filters.query;
      },
      get hideAdded() {
        return filters.hideAdded;
      },
      get shownCount() {
        return shown;
      },
      set shownCount(v: number | null) {
        shown = v;
      },
    },
  });
  flushSync();
}

// One publication per account unless a test says otherwise, so rows count
// accounts too.
function rows(): HTMLElement[] {
  return [...target.querySelectorAll<HTMLElement>('.source-row')];
}

function showMore(): HTMLButtonElement[] {
  return [...target.querySelectorAll<HTMLButtonElement>('.show-more')];
}

function countText(): string {
  return String(shown);
}

function type(value: string) {
  filters.query = value;
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
    filters.query = '';
    filters.hideAdded = false;
    document.body.innerHTML = '';
  });

  it('caps the list at 10 account groups and reveals the rest on Show more', () => {
    render();
    expect(rows()).toHaveLength(10);
    expect(showMore()[0].textContent).toContain('Show 20 more');

    showMore()[0].click();
    flushSync();
    expect(rows()).toHaveLength(30);
    expect(showMore()).toHaveLength(0);
  });

  it('labels each click with no more than the 25 groups it will reveal', () => {
    store.publications = Array.from({ length: 100 }, (_, i) => pub(i));
    render();

    expect(showMore()[0].textContent).toContain('Show 25 more');
    showMore()[0].click();
    flushSync();
    expect(rows()).toHaveLength(35);
    expect(showMore()[0].textContent).toContain('Show 25 more');
  });

  it('keeps the count line reporting what the scan found, not what is on screen', () => {
    render();
    expect(countText()).toBe('30');
  });

  it('filters on search and resets the window so late matches are visible', () => {
    render();
    // "Publication 29" is the last group, far past the initial window.
    type('Publication 29');
    expect(rows()).toHaveLength(1);
    expect(showMore()).toHaveLength(0);
    expect(target.textContent).toContain('Publication 29');
    expect(countText()).toBe('1');

    type('');
    expect(rows()).toHaveLength(10);
  });

  it('re-caps the window when the query changes after an expansion', () => {
    render();
    showMore()[0].click();
    flushSync();
    expect(rows()).toHaveLength(30);

    type('Account');
    expect(rows()).toHaveLength(10);
    expect(showMore()[0].textContent).toContain('Show 20 more');
  });

  it('reports no matches for a query that hits nothing', () => {
    render();
    type('nothing here');
    expect(rows()).toHaveLength(0);
    expect(target.textContent).toContain('No publications match');
  });

  it('drops already-added accounts when Hide added is on, and resets the window', () => {
    subs.subscriptions = store.publications
      .slice(0, 8)
      .map((p) => ({ sourceType: 'atproto.documents', feedUrl: p.publicationUri }));
    render();
    showMore()[0].click();
    flushSync();
    expect(rows()).toHaveLength(30);

    filters.hideAdded = true;
    flushSync();
    // 22 accounts left, re-windowed to 10.
    expect(rows()).toHaveLength(10);
    expect(showMore()[0].textContent).toContain('Show 12 more');
    expect(countText()).toBe('22');
  });
});

describe('FollowingPublications per-account cap', () => {
  afterEach(() => {
    if (component) unmount(component);
    component = undefined;
    document.body.innerHTML = '';
  });

  it('shows two publications per account until asked for the rest', () => {
    store.publications = Array.from({ length: 5 }, (_, i) => ({
      ...pub(0),
      publicationUri: `at://did:plc:acct0/site.standard.publication/p${i}`,
      name: `Publication 0.${i}`,
    }));
    subs.subscriptions = [];
    render();

    expect(rows()).toHaveLength(2);
    const more = target.querySelector<HTMLButtonElement>('.account-more')!;
    expect(more.textContent).toContain('3 more from @acct0.bsky.social');

    more.click();
    flushSync();
    expect(rows()).toHaveLength(5);
    expect(target.querySelector('.account-more')).toBeNull();
  });
});
