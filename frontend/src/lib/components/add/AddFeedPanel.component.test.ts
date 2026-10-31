import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';
import AddFeedPanel from './AddFeedPanel.svelte';

// Adding a feed whose link looks private, with Atmospheric sync on, asks
// before the link goes on the reader's public feed list.

const PRIVATE_URL = 'https://www.patreon.com/rss/creator?auth=secret';
const PUBLIC_URL = 'https://example.com/feed.xml';

const state = vi.hoisted(() => ({ feeds: [] as string[], pdsSyncEnabled: true }));

vi.mock('$lib/services/api', () => ({
  api: {
    discoverFeedsV2: vi.fn(async () => ({ feeds: state.feeds, standardSite: null })),
    getSettings: vi.fn(async () => ({ pdsSyncEnabled: state.pdsSyncEnabled })),
  },
}));

const add = vi.hoisted(() => vi.fn(async () => 1));
vi.mock('$lib/stores/subscriptions.svelte', () => ({
  subscriptionsStore: {
    add,
    getById: () => undefined,
    update: vi.fn(),
    subscriptions: [],
    maxSubscriptions: 100,
  },
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/stores/articles.svelte', () => ({ articlesStore: { savedGuids: new Set() } }));
vi.mock('$lib/stores/social.svelte', () => ({ socialStore: { loadFeed: vi.fn() } }));
vi.mock('$lib/stores/sidebar.svelte', () => ({ sidebarStore: { closeMobile: vi.fn() } }));
vi.mock('$lib/stores/sync.svelte', () => ({ syncStore: { isOnline: true } }));
vi.mock('$lib/stores/auth.svelte', () => ({ auth: { isGuest: false } }));
vi.mock('$lib/services/feedFetcher', () => ({
  fetchSingleFeed: vi.fn(() => new Promise(() => {})),
  fetchAllDocuments: vi.fn(),
}));

async function settle() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

describe('AddFeedPanel private feed prompt', () => {
  let target: HTMLElement;
  let component: ReturnType<typeof mount>;

  beforeEach(() => {
    add.mockClear();
    target = document.createElement('div');
    document.body.appendChild(target);
  });

  afterEach(() => {
    unmount(component);
    target.remove();
  });

  async function submit(url: string) {
    state.feeds = [url];
    component = mount(AddFeedPanel, { target, props: { onclose: vi.fn(), initialValue: url } });
    await settle();
    target.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
  }

  function button(label: string): HTMLButtonElement {
    const found = [...target.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === label
    );
    if (!found) throw new Error(`no button "${label}"`);
    return found;
  }

  it('asks before adding a private-looking feed, and keeps it private on request', async () => {
    state.pdsSyncEnabled = true;
    await submit(PRIVATE_URL);

    expect(add).not.toHaveBeenCalled();
    expect(target.textContent).toContain('This looks like a private feed');

    button('Keep it private').click();
    await settle();
    expect(add).toHaveBeenCalledWith(PRIVATE_URL, 'www.patreon.com', { keepPrivate: true });
  });

  it('syncs it publicly when the reader says so', async () => {
    state.pdsSyncEnabled = true;
    await submit(PRIVATE_URL);

    button('Sync it publicly').click();
    await settle();
    expect(add).toHaveBeenCalledWith(PRIVATE_URL, 'www.patreon.com', { keepPrivate: false });
  });

  it('adds an ordinary feed without asking', async () => {
    state.pdsSyncEnabled = true;
    await submit(PUBLIC_URL);

    expect(add).toHaveBeenCalledWith(PUBLIC_URL, 'example.com', { keepPrivate: undefined });
  });

  it('does not ask when Atmospheric sync is off', async () => {
    state.pdsSyncEnabled = false;
    await submit(PRIVATE_URL);

    expect(target.textContent).not.toContain('This looks like a private feed');
    expect(add).toHaveBeenCalledWith(PRIVATE_URL, 'www.patreon.com', { keepPrivate: undefined });
  });
});
