// Mounted component test (jsdom) — see the "component" project in vitest.config.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { LinkblogPerson } from '$lib/types';
import LinkblogDiscovery from './LinkblogDiscovery.svelte';

const store = {
  friends: [] as LinkblogPerson[],
  people: [] as LinkblogPerson[],
  friendsLoaded: true,
  peopleLoaded: true,
  loadingFriends: false,
  loadingPeople: false,
  error: null,
  loadFriends: vi.fn(),
  loadDiscover: vi.fn(),
  subscribe: vi.fn(),
};

const subs = { subscriptions: [] as Array<Record<string, unknown>> };

vi.mock('$lib/stores/linkblogDiscovery.svelte', () => ({
  get linkblogDiscoveryStore() {
    return store;
  },
}));

vi.mock('$lib/stores/subscriptions.svelte', () => ({
  get subscriptionsStore() {
    return subs;
  },
}));

function person(i: number, isFollow: boolean): LinkblogPerson {
  return {
    did: `did:plc:${isFollow ? 'f' : 'o'}${i}`,
    handle: `${isFollow ? 'friend' : 'other'}${i}.bsky.social`,
    displayName: `${isFollow ? 'Friend' : 'Other'} ${i}`,
    publicationUri: `at://did:plc:${isFollow ? 'f' : 'o'}${i}/site.standard.publication/skyreader-links`,
    blogUrl: `https://linkblogs.skyreader.app/${i}`,
    isFollow,
  };
}

let component: Record<string, any> | undefined;
let target: HTMLElement;

function render(props: Record<string, unknown> = { variant: 'full' }) {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(LinkblogDiscovery, { target, props });
  flushSync();
}

function rows(): HTMLElement[] {
  return [...target.querySelectorAll<HTMLElement>('.person')];
}

function showMore(): HTMLButtonElement[] {
  return [...target.querySelectorAll<HTMLButtonElement>('.show-more')];
}

function type(value: string) {
  const input = target.querySelector<HTMLInputElement>('input[type="search"]')!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

describe('LinkblogDiscovery full variant windowing', () => {
  beforeEach(() => {
    store.friends = [];
    // 12 friends + 18 others = 30 people in the registry.
    store.people = [
      ...Array.from({ length: 12 }, (_, i) => person(i, true)),
      ...Array.from({ length: 18 }, (_, i) => person(i, false)),
    ];
    subs.subscriptions = [];
  });

  afterEach(() => {
    if (component) unmount(component);
    component = undefined;
    document.body.innerHTML = '';
  });

  it('caps each group at 10 rows and reveals the rest on Show more', () => {
    render();
    // 10 of 12 friends + 10 of 18 others.
    expect(rows()).toHaveLength(20);

    const buttons = showMore();
    expect(buttons).toHaveLength(2);
    expect(buttons[0].textContent).toContain('Show 2 more');
    expect(buttons[1].textContent).toContain('Show 8 more');

    // A step of 25 exhausts both groups, so both buttons go away.
    buttons[0].click();
    flushSync();
    buttons[1].click();
    flushSync();
    expect(rows()).toHaveLength(30);
    expect(showMore()).toHaveLength(0);
  });

  it('filters on search and resets the window so late matches are visible', () => {
    render();
    // "Other 17" sits well past the initial window of its group.
    type('Other 1');
    expect(rows().map((r) => r.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('Other 17')])
    );
    // Others 1, 10–17 = 9 matches, all within one window; friends drop out.
    expect(rows()).toHaveLength(9);
    expect(showMore()).toHaveLength(0);

    type('');
    expect(rows()).toHaveLength(20);
  });

  it('re-caps the window when the query changes after an expansion', () => {
    render();
    // Expand "More on Skyreader" only: 10 friends + all 18 others.
    showMore()[1].click();
    flushSync();
    expect(rows()).toHaveLength(28);

    type('Other');
    expect(rows()).toHaveLength(10);
    expect(showMore()[0].textContent).toContain('Show 8 more');
  });

  it('reports no matches for a query that hits nothing', () => {
    render();
    type('nobody at all');
    expect(rows()).toHaveLength(0);
    expect(target.textContent).toContain('No linkblogs match');
  });

  it('drops already-added rows when Hide added is on', () => {
    subs.subscriptions = store.people
      .slice(0, 5)
      .map((p) => ({ sourceType: 'atproto.documents', feedUrl: p.publicationUri }));
    render();
    expect(rows()).toHaveLength(20);

    const toggle = target.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    toggle.click();
    flushSync();
    // 7 friends left (5 of 12 hidden) + 10 of 18 others.
    expect(rows()).toHaveLength(17);
    expect(showMore()[0].textContent).toContain('Show 8 more');
  });
});

describe('LinkblogDiscovery other variants', () => {
  afterEach(() => {
    if (component) unmount(component);
    component = undefined;
    document.body.innerHTML = '';
  });

  it('still honours the suggestions limit, with no toolbar or Show more', () => {
    store.friends = [];
    store.people = Array.from({ length: 30 }, (_, i) => person(i, false));
    subs.subscriptions = [];
    render({ variant: 'suggestions', limit: 3, heading: 'More Skyreader linkblogs' });

    expect(rows()).toHaveLength(3);
    expect(showMore()).toHaveLength(0);
    expect(target.querySelector('.discovery-toolbar')).toBeNull();
  });

  it('renders the friends variant uncapped', () => {
    store.friends = Array.from({ length: 14 }, (_, i) => person(i, true));
    store.people = [];
    subs.subscriptions = [];
    render({ variant: 'friends' });

    expect(rows()).toHaveLength(14);
    expect(showMore()).toHaveLength(0);
    expect(target.querySelector('.discovery-toolbar')).toBeNull();
  });
});
