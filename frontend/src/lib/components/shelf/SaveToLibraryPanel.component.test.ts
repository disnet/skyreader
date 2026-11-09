import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import SaveToLibraryPanel from './SaveToLibraryPanel.svelte';
import { shelfStore } from '$lib/stores/shelf.svelte';

// Saves by url, reactive as the store's rows are: a save "lands" by appearing.
const rows = new SvelteMap<string, { rkey: string; url: string }>();

vi.mock('$lib/stores/saves.svelte', () => ({
  savesStore: { find: (key: string) => rows.get(key) },
}));

vi.mock('$lib/stores/auth.svelte', () => ({
  auth: { user: { did: 'did:plc:reader' } },
}));

vi.mock('$lib/stores/shelf.svelte', () => ({
  shelfStore: {
    collections: [
      { id: 'c1', name: 'Field notes', items: [], pinned: false },
      { id: 'c2', name: 'Course', items: [], pinned: false },
    ],
    canWrite: true,
    loading: false,
    load: () => Promise.resolve(),
    isOnShelf: () => false,
    collectionIdsFor: () => [],
    roomIn: () => 10,
    addItems: vi.fn(() => Promise.resolve()),
    setOnShelf: vi.fn(() => Promise.resolve()),
    removeItem: vi.fn(() => Promise.resolve()),
    create: vi.fn(() => Promise.resolve('c3')),
  },
}));

const URL_ = 'https://example.com/a';

describe('SaveToLibraryPanel while the save is landing', () => {
  let component: Record<string, any> | undefined;

  afterEach(() => {
    if (component) unmount(component);
    component = undefined;
    rows.clear();
    vi.mocked(shelfStore.addItems).mockClear();
    vi.mocked(shelfStore.setOnShelf).mockClear();
    vi.mocked(shelfStore.create).mockReset();
    document.body.innerHTML = '';
  });

  // The host hands the panel the save it finds by key, as the link menu does.
  function open(props: { landingKey?: string } = { landingKey: URL_ }) {
    const target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(SaveToLibraryPanel, {
      target,
      props: {
        get save() {
          return rows.get(URL_) as never;
        },
        anchorEl: null,
        inline: true,
        onClose: () => {},
        ...props,
      },
    });
    flushSync();
  }

  function box(name: string): HTMLInputElement {
    const label = Array.from(document.querySelectorAll('label')).find((l) =>
      l.textContent?.includes(name)
    );
    return label!.querySelector('input')!;
  }

  it('takes collection picks before the save lands, and files them when it does', async () => {
    open();
    expect(document.querySelector('.status')?.textContent).toContain('Saving…');
    expect(box('Field notes').disabled).toBe(false);

    box('Field notes').click();
    flushSync();
    expect(box('Field notes').checked).toBe(true);
    // A collection member is on the Shelf.
    expect(box('Shelf').checked).toBe(true);
    expect(shelfStore.addItems).not.toHaveBeenCalled();

    rows.set(URL_, { rkey: 'r1', url: URL_ });
    flushSync();
    await vi.waitFor(() =>
      expect(shelfStore.addItems).toHaveBeenCalledWith('c1', [{ rkey: 'r1', url: URL_ }])
    );
    expect(shelfStore.setOnShelf).not.toHaveBeenCalled();
  });

  it('keeps it on the Shelf when only the Shelf was ticked', async () => {
    open();
    box('Shelf').click();
    flushSync();
    rows.set(URL_, { rkey: 'r1', url: URL_ });
    flushSync();
    await vi.waitFor(() =>
      expect(shelfStore.setOnShelf).toHaveBeenCalledWith({ rkey: 'r1', url: URL_ }, true)
    );
  });

  it('unticking the Shelf drops the collection picks too', () => {
    open();
    box('Field notes').click();
    flushSync();
    box('Shelf').click();
    flushSync();
    expect(box('Field notes').checked).toBe(false);
    expect(box('Shelf').checked).toBe(false);
  });

  it('files the picks when the save lands after the panel has closed', async () => {
    open();
    box('Course').click();
    flushSync();
    unmount(component!);
    component = undefined;

    rows.set(URL_, { rkey: 'r1', url: URL_ });
    flushSync();
    await vi.waitFor(() =>
      expect(shelfStore.addItems).toHaveBeenCalledWith('c2', [{ rkey: 'r1', url: URL_ }])
    );
  });

  it('waits for the save without a key to find it by', () => {
    open({ landingKey: undefined });
    expect(box('Field notes').disabled).toBe(true);
    expect(box('Shelf').disabled).toBe(true);
  });

  it('a panel reopened before the save lands shows the picks still waiting, and owns them', async () => {
    open();
    box('Course').click();
    flushSync();
    unmount(component!);
    component = undefined;
    await Promise.resolve();

    open();
    expect(box('Course').checked).toBe(true);
    // Unticked here: the earlier pick doesn't file it behind the reader's back.
    box('Course').click();
    flushSync();
    rows.set(URL_, { rkey: 'r1', url: URL_ });
    flushSync();
    await new Promise((r) => setTimeout(r, 0));
    expect(shelfStore.addItems).not.toHaveBeenCalled();
  });

  it('files into a collection made while saving, even when the panel closed first', async () => {
    let made!: (id: string) => void;
    vi.mocked(shelfStore.create).mockImplementation(
      () => new Promise<string>((r) => (made = r)) as never
    );
    open();
    const name = document.querySelector<HTMLInputElement>('input[type="text"]:not(.filter)')!;
    const form = name.closest('form')!;
    name.value = 'New';
    name.dispatchEvent(new Event('input'));
    flushSync();
    form.requestSubmit();
    flushSync();
    unmount(component!);
    component = undefined;

    made('c3');
    await vi.waitFor(() => expect(shelfStore.create).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    rows.set(URL_, { rkey: 'r1', url: URL_ });
    flushSync();
    await vi.waitFor(() =>
      expect(shelfStore.addItems).toHaveBeenCalledWith('c3', [{ rkey: 'r1', url: URL_ }])
    );
  });
});
