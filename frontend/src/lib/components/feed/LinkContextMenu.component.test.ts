import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import LinkContextMenu from './LinkContextMenu.svelte';
import { savesStore } from '$lib/stores/saves.svelte';
import { toastStore } from '$lib/stores/toast.svelte';

const authState = { isGuest: false, signedIn: true };
const openFor = vi.fn();
const savedUrls = new Set<string>();
const openPicker = vi.fn();
const memberships = vi.fn();
const scopeStatus = vi.fn(() => Promise.resolve({ scopeStatus: { semble: true, margin: true } }));
// Reactive, as the store's rows are: the panel picks the save up when it lands.
const savedRows = new SvelteMap<string, { rkey: string; url: string }>();

vi.mock('$lib/stores/auth.svelte', () => ({
  auth: {
    get isGuest() {
      return authState.isGuest;
    },
    get user() {
      return authState.signedIn ? { did: 'did:plc:reader' } : null;
    },
  },
}));

vi.mock('$lib/stores/sembleConnection.svelte', () => ({
  sembleConnectionStore: { openFor: (...args: unknown[]) => openFor(...args) },
}));

vi.mock('$lib/stores/saves.svelte', () => ({
  savesStore: {
    isSaved: (url: string) => savedUrls.has(url),
    find: (url: string) => savedRows.get(url),
    saveFromUrl: vi.fn(() => Promise.resolve({})),
    remove: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock('$lib/stores/shelf.svelte', () => ({
  shelfStore: {
    collections: [],
    canWrite: true,
    loading: false,
    load: () => Promise.resolve(),
    isOnShelf: () => false,
    collectionIdsFor: () => [],
    roomIn: () => 10,
  },
}));

vi.mock('$lib/stores/integrationSave.svelte', () => ({
  integrationSaveStore: { openPicker: (...args: unknown[]) => openPicker(...args) },
}));

vi.mock('$lib/stores/toast.svelte', () => ({
  toastStore: { add: vi.fn(() => 'toast'), update: vi.fn() },
}));

vi.mock('$lib/services/api', () => ({
  UrlSaveLimitError: class extends Error {},
  api: {
    getIntegrationMemberships: (...args: unknown[]) => memberships(...args),
    getIntegrationStatus: () => scopeStatus(),
  },
}));

describe('LinkContextMenu', () => {
  let component: Record<string, any> | undefined;

  afterEach(() => {
    if (component) unmount(component);
    component = undefined;
    authState.isGuest = false;
    authState.signedIn = true;
    openFor.mockReset();
    savedUrls.clear();
    openPicker.mockReset();
    memberships.mockReset();
    vi.mocked(toastStore.update).mockClear();
    vi.mocked(toastStore.add).mockClear();
    vi.mocked(savesStore.saveFromUrl).mockClear();
    vi.mocked(savesStore.remove).mockClear();
    savedRows.clear();
    vi.mocked(savesStore.saveFromUrl).mockImplementation(() => Promise.resolve({}) as never);
    document.body.innerHTML = '';
  });

  function open(
    url: string,
    linkText = 'A long enough link title',
    extra: { connectFrom?: { url: string; title?: string }; connectLabel?: string } = {}
  ) {
    const onClose = vi.fn();
    const target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(LinkContextMenu, {
      target,
      props: { url, linkText, anchorRect: new DOMRect(10, 10, 100, 20), onClose, ...extra },
    });
    flushSync();
    return onClose;
  }

  function item(label: string): HTMLButtonElement | undefined {
    return Array.from(document.querySelectorAll<HTMLButtonElement>('.menu-item')).find((b) =>
      b.textContent?.includes(label)
    );
  }

  it('leads with the host and the link text', () => {
    open('https://www.example.com/post/1', 'Why reading adds up');
    expect(document.querySelector('.link-host')?.textContent).toContain('example.com');
    expect(document.querySelector('.link-host')?.textContent).not.toContain('www.');
    expect(document.querySelector('.link-label')?.textContent).toBe('Why reading adds up');
  });

  it('shows the raw path when it cannot be decoded', () => {
    open('https://example.com/100%-off', '');
    expect(document.querySelector('.link-label')?.textContent).toBe('/100%-off');
    expect(item('Open in new tab')).toBeDefined();
  });

  it('opens the collection picker for Semble and Margin with the link', () => {
    const onClose = open('https://example.com/post/1');

    item('Save to Semble')!.click();
    expect(onClose).toHaveBeenCalled();
    expect(openPicker).toHaveBeenLastCalledWith('semble', {
      url: 'https://example.com/post/1',
      title: 'A long enough link title',
    });

    item('Save to Margin')!.click();
    expect(openPicker).toHaveBeenLastCalledWith('margin', {
      url: 'https://example.com/post/1',
      title: 'A long enough link title',
    });
  });

  // The hosts pass props that read through to their menu state, which closing
  // clears, so a prop read after onClose throws.
  function openThrowing(url: string) {
    let menu: { url: string; linkText: string } | null = {
      url,
      linkText: 'A long enough link title',
    };
    // As a host does: clear the state, and with it the menu.
    const onClose = vi.fn(() => {
      menu = null;
      if (component) unmount(component);
      component = undefined;
    });
    const target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(LinkContextMenu, {
      target,
      props: {
        get url() {
          return menu!.url;
        },
        get linkText() {
          return menu!.linkText;
        },
        anchorRect: new DOMRect(10, 10, 100, 20),
        onClose,
      },
    });
    flushSync();
    return onClose;
  }

  it('saves the link and opens the Save panel on it', async () => {
    const url = 'https://example.com/post/1';
    let land!: () => void;
    vi.mocked(savesStore.saveFromUrl).mockImplementation(
      () =>
        new Promise((resolve) => {
          land = () => {
            savedRows.set(url, { rkey: 'r1', url });
            resolve({} as never);
          };
        })
    );
    const onClose = openThrowing(url);

    item('Save to Skyreader')!.click();
    flushSync();
    expect(savesStore.saveFromUrl).toHaveBeenLastCalledWith(url, {
      title: 'A long enough link title',
    });
    expect(onClose).not.toHaveBeenCalled();
    const panel = document.querySelector('.save-panel');
    expect(panel?.textContent).toContain('Saving…');
    // In the menu's own box, in place of its actions.
    expect(document.querySelector('.link-menu .save-panel')).not.toBeNull();
    expect(item('Open in new tab')).toBeUndefined();

    land();
    await vi.waitFor(() => {
      flushSync();
      expect(document.querySelector('.save-panel')?.textContent).toContain('Saved to your Queue');
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(toastStore.update).not.toHaveBeenCalled();
  });

  it('closes the panel and says so when the save fails, props or not', async () => {
    vi.mocked(savesStore.saveFromUrl).mockImplementation(() => Promise.reject(new Error('x')));
    const onClose = openThrowing('https://example.com/post/1');
    item('Save to Skyreader')!.click();
    await vi.waitFor(() =>
      expect(toastStore.update).toHaveBeenLastCalledWith('toast', 'error', 'Failed to save article')
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('confirms a save that lands after the panel closed', async () => {
    let land!: () => void;
    vi.mocked(savesStore.saveFromUrl).mockImplementation(
      () => new Promise((resolve) => (land = () => resolve({} as never)))
    );
    openThrowing('https://example.com/post/1');
    item('Save to Skyreader')!.click();
    flushSync();
    unmount(component!);
    component = undefined;
    land();
    await vi.waitFor(() =>
      expect(toastStore.update).toHaveBeenLastCalledWith('toast', 'success', 'Saved to your Queue')
    );
  });

  it('shows where a saved link is kept, and Edit save… opens the panel on it', () => {
    const url = 'https://example.com/post/1';
    savedUrls.add(url);
    savedRows.set(url, { rkey: 'r1', url });
    const onClose = open(url);
    // A quiet status line, and nothing that unsaves in one tap.
    expect(document.querySelector('.link-kept')?.textContent).toContain('In your Queue');
    expect(item('Save to Skyreader')).toBeUndefined();

    item('Edit save…')!.click();
    flushSync();
    expect(savesStore.saveFromUrl).not.toHaveBeenCalled();
    expect(document.querySelector('.save-panel')?.textContent).toContain('Saved to your Queue');

    (document.querySelector('.save-panel .unsave') as HTMLButtonElement).click();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(savesStore.remove).toHaveBeenCalledWith('r1');
  });

  it('goes back to the link actions from the panel, keeping the save', () => {
    const url = 'https://example.com/post/1';
    savedUrls.add(url);
    savedRows.set(url, { rkey: 'r1', url });
    const onClose = open(url);
    item('Edit save…')!.click();
    flushSync();
    (document.querySelector('.save-panel .back') as HTMLButtonElement).click();
    flushSync();
    expect(document.querySelector('.save-panel')).toBeNull();
    expect(item('Open in new tab')).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
    expect(savesStore.remove).not.toHaveBeenCalled();
  });

  it('says when the link is already in Semble or Margin', async () => {
    memberships.mockImplementation((kind: string) =>
      Promise.resolve(
        kind === 'semble'
          ? {
              items: [{}],
              memberships: [{ collectionUri: 'at://a' }, { collectionUri: 'at://b' }],
              truncated: false,
            }
          : { items: [], memberships: [], truncated: false }
      )
    );
    open('https://example.com/post/1');
    await vi.waitFor(() => {
      expect(memberships).toHaveBeenCalledWith('semble', 'https://example.com/post/1');
      expect(memberships).toHaveBeenCalledWith('margin', 'https://example.com/post/1');
    });
    await vi.waitFor(() => {
      flushSync();
      expect(item('Saved to Semble')?.textContent).toContain('2 collections');
    });
    expect(item('Saved to Semble')?.classList.contains('done')).toBe(true);
    expect(item('Save to Margin…')).toBeDefined();

    item('Saved to Semble')!.click();
    expect(openPicker).toHaveBeenLastCalledWith('semble', {
      url: 'https://example.com/post/1',
      title: 'A long enough link title',
    });
  });

  // The status is asked once a page load, so this file's later tests see the
  // first answer: scope for both.
  it('reads memberships only for the integrations the session may read', async () => {
    open('https://example.com/post/1');
    await vi.waitFor(() => expect(memberships).toHaveBeenCalledTimes(2));
    expect(scopeStatus).toHaveBeenCalledTimes(1);
  });

  it('offers to save to Semble and Margin when it cannot tell', async () => {
    memberships.mockImplementation(() => Promise.reject(new Error('no scope')));
    open('https://example.com/post/1');
    await Promise.resolve();
    flushSync();
    expect(item('Save to Semble…')).toBeDefined();
    expect(item('Save to Margin…')).toBeDefined();
  });

  it('hides saving and collecting from a guest', () => {
    authState.isGuest = true;
    open('https://example.com/post/1');
    expect(memberships).not.toHaveBeenCalled();
    expect(item('Open in new tab')).toBeDefined();
    expect(item('Save to Skyreader')).toBeUndefined();
    expect(item('Save to Semble')).toBeUndefined();
    expect(item('Save to Margin')).toBeUndefined();
  });

  it('offers only open and copy for a non-web link', () => {
    open('mailto:someone@example.com', 'Email me');
    expect(item('Copy link')).toBeDefined();
    expect(item('Save to Skyreader')).toBeUndefined();
    expect(item('Save to Semble')).toBeUndefined();
  });

  // A cited link is the likeliest other end of a connection from the article
  // it's cited in, so the dialog opens with it filled.
  it('connects the page it sits in to the link on Semble', () => {
    const from = { url: 'https://example.com/the-article', title: 'The Article' };
    const onClose = open('https://cited.example/source', 'The cited source', { connectFrom: from });
    item('Connect on Semble…')!.click();
    expect(onClose).toHaveBeenCalled();
    expect(openFor).toHaveBeenCalledWith(from, {
      target: { url: 'https://cited.example/source', title: 'The cited source' },
    });
  });

  it('words the item as the host asks', () => {
    open('https://cited.example/source', '', {
      connectFrom: { url: 'https://example.com/my-save' },
      connectLabel: 'Connect back on Semble…',
    });
    expect(item('Connect back on Semble…')).toBeDefined();
  });

  it('offers no connection without a page to connect from, an account, or a web link', () => {
    open('https://cited.example/source');
    expect(item('Connect on Semble')).toBeUndefined();
    unmount(component!);

    authState.signedIn = false;
    open('https://cited.example/source', 'x', { connectFrom: { url: 'https://example.com/a' } });
    expect(item('Connect on Semble')).toBeUndefined();
    unmount(component!);

    authState.signedIn = true;
    open('mailto:someone@example.com', 'x', { connectFrom: { url: 'https://example.com/a' } });
    expect(item('Connect on Semble')).toBeUndefined();
    unmount(component!);

    // A document with no web address falls back to its bare path.
    open('https://cited.example/source', 'x', { connectFrom: { url: '/posts/foo' } });
    expect(item('Connect on Semble')).toBeUndefined();
  });

  it('never offers to connect a page to itself', () => {
    open('https://example.com/a/#notes', 'x', { connectFrom: { url: 'https://example.com/a' } });
    expect(item('Connect on Semble')).toBeUndefined();
  });
});
