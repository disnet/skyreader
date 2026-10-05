import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import LinkContextMenu from './LinkContextMenu.svelte';
import { savesStore } from '$lib/stores/saves.svelte';
import { toastStore } from '$lib/stores/toast.svelte';

const authState = { isGuest: false };
const savedUrls = new Set<string>();
const openPicker = vi.fn();

vi.mock('$lib/stores/auth.svelte', () => ({
  auth: {
    get isGuest() {
      return authState.isGuest;
    },
  },
}));

vi.mock('$lib/stores/saves.svelte', () => ({
  savesStore: {
    isSaved: (url: string) => savedUrls.has(url),
    saveFromUrl: vi.fn(() => Promise.resolve({})),
  },
}));

vi.mock('$lib/stores/integrationSave.svelte', () => ({
  integrationSaveStore: { openPicker: (...args: unknown[]) => openPicker(...args) },
}));

vi.mock('$lib/stores/toast.svelte', () => ({
  toastStore: { add: vi.fn(() => 'toast'), update: vi.fn() },
}));

vi.mock('$lib/services/api', () => ({ UrlSaveLimitError: class extends Error {} }));

describe('LinkContextMenu', () => {
  let component: Record<string, any> | undefined;

  afterEach(() => {
    if (component) unmount(component);
    component = undefined;
    authState.isGuest = false;
    savedUrls.clear();
    openPicker.mockReset();
    document.body.innerHTML = '';
  });

  function open(url: string, linkText = 'A long enough link title') {
    const onClose = vi.fn();
    const target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(LinkContextMenu, {
      target,
      props: { url, linkText, anchorRect: new DOMRect(10, 10, 100, 20), onClose },
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
  it('saves the link even though its props throw once the menu closes', async () => {
    let menu: { url: string; linkText: string } | null = {
      url: 'https://example.com/post/1',
      linkText: 'A long enough link title',
    };
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
        onClose: () => {
          menu = null;
        },
      },
    });
    flushSync();

    item('Save to Skyreader')!.click();
    await Promise.resolve();
    expect(savesStore.saveFromUrl).toHaveBeenLastCalledWith('https://example.com/post/1', {
      title: 'A long enough link title',
    });
    await vi.waitFor(() =>
      expect(toastStore.update).toHaveBeenLastCalledWith('toast', 'success', 'Article saved')
    );
  });

  it('shows an already-saved link as saved', () => {
    savedUrls.add('https://example.com/post/1');
    open('https://example.com/post/1');
    const saved = item('Saved');
    expect(saved?.disabled).toBe(true);
    expect(item('Save to Skyreader')).toBeUndefined();
  });

  it('hides saving and collecting from a guest', () => {
    authState.isGuest = true;
    open('https://example.com/post/1');
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
});
