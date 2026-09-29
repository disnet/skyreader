import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import CollectionPickerHost from './CollectionPicker.test-host.svelte';

const pending: Array<{
  url: string;
  resolve: (value: {
    items: Array<{ uri: string; cid: string }>;
    memberships: Array<{ collectionUri: string; linkUri: string }>;
    truncated: boolean;
  }) => void;
}> = [];
let resolveSettings:
  ((value: { backing: null | { provider: 'semble'; collectionUri: string } }) => void) | null =
  null;
let deferSettings = true;

vi.mock('$lib/services/api', () => ({
  api: {
    getIntegrationMemberships: vi.fn(
      (_kind: string, url: string) =>
        new Promise((resolve) => pending.push({ url, resolve: resolve as (value: any) => void }))
    ),
    getSettings: vi.fn(() =>
      deferSettings
        ? new Promise((resolve) => {
            resolveSettings = resolve;
          })
        : Promise.resolve({ backing: null })
    ),
  },
}));

vi.mock('$lib/stores/collections.svelte', () => ({
  collectionsStore: {
    collections: {
      semble: [
        {
          uri: 'at://did:plc:test/network.cosmik.collection/backing',
          cid: 'bafycollection',
          name: 'Saved',
        },
        { uri: 'at://did:plc:test/network.cosmik.collection/ai', cid: 'bafyai', name: 'AI safety' },
        {
          uri: 'at://did:plc:test/network.cosmik.collection/reading',
          cid: 'bafyreading',
          name: 'Reading queue',
          lastUsedAt: 1_700_000_000_000,
        },
        {
          uri: 'at://did:plc:test/network.cosmik.collection/research',
          cid: 'bafyresearch',
          name: 'Research',
        },
      ],
      margin: [],
    },
    loading: { semble: false, margin: false },
    refreshing: { semble: false, margin: false },
    error: { semble: null, margin: null },
    truncated: { semble: false, margin: false },
    favorites: { 'at://did:plc:test/network.cosmik.collection/research': 1 },
    toggleFavorite: vi.fn(),
    loadAndRefresh: vi.fn(),
  },
}));

describe('CollectionPicker membership requests', () => {
  let component: Record<string, any> | undefined;

  afterEach(() => {
    if (component) unmount(component);
    component = undefined;
    pending.length = 0;
    document.body.innerHTML = '';
  });

  it('keeps remove-all disabled until the Saved backing is known', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(CollectionPickerHost, { target });
    flushSync();

    pending[0].resolve({
      items: [{ uri: 'at://did:plc:test/network.cosmik.card/item', cid: 'bafyitem' }],
      memberships: [
        {
          collectionUri: 'at://did:plc:test/network.cosmik.collection/backing',
          linkUri: 'at://did:plc:test/network.cosmik.collectionLink/link',
        },
      ],
      truncated: false,
    });
    await vi.waitFor(() => {
      flushSync();
      expect(document.body.textContent).toContain('Remove from all collections');
    });

    const removeAll = document.body.querySelector('.no-collection') as HTMLButtonElement;
    expect(removeAll.disabled).toBe(true);
    removeAll.click();

    deferSettings = false;
    resolveSettings?.({
      backing: {
        provider: 'semble',
        collectionUri: 'at://did:plc:test/network.cosmik.collection/backing',
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    flushSync();

    expect(removeAll.disabled).toBe(false);
    expect(document.body.querySelector('.btn-primary')?.hasAttribute('disabled')).toBe(true);
  });

  it('keeps the reopened article loading when the earlier lookup resolves', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(CollectionPickerHost, { target });
    flushSync();
    expect(pending.map((request) => request.url)).toEqual(['https://example.test/a']);

    (target.querySelector('[data-testid="reopen"]') as HTMLButtonElement).click();
    flushSync();
    expect(pending.map((request) => request.url)).toEqual([
      'https://example.test/a',
      'https://example.test/b',
    ]);

    pending[0].resolve({ items: [], memberships: [], truncated: false });
    await Promise.resolve();
    flushSync();

    expect(document.body.textContent).toContain('Checking existing saves…');
    expect(document.body.querySelector('.btn-primary')?.hasAttribute('disabled')).toBe(true);
  });

  it('warns but permits a new save after a truncated lookup', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(CollectionPickerHost, { target });
    flushSync();

    pending[0].resolve({ items: [], memberships: [], truncated: true });
    await Promise.resolve();
    await Promise.resolve();
    flushSync();

    expect(document.body.textContent).toContain(
      "Couldn't check all older saves. Saving may create another Semble item."
    );
    (document.body.querySelector('.no-collection') as HTMLButtonElement).click();
    flushSync();
    expect(document.body.querySelector('.btn-primary')?.hasAttribute('disabled')).toBe(false);
  });

  it('offers favorites then recents as quick picks, and names the choice', async () => {
    deferSettings = false;
    const target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(CollectionPickerHost, { target });
    flushSync();
    pending[0].resolve({ items: [], memberships: [], truncated: false });
    await vi.waitFor(() => {
      flushSync();
      expect(document.body.querySelectorAll('.chip').length).toBe(2);
      expect(document.body.textContent).not.toContain('Checking existing saves');
    });

    const chips = [...document.body.querySelectorAll<HTMLButtonElement>('.chip')];
    expect(chips.map((c) => c.textContent?.trim())).toEqual(['Research', 'Reading queue']);
    chips[1].click();
    flushSync();
    expect(chips[1].getAttribute('aria-pressed')).toBe('true');
    expect(document.body.querySelector('.footer-summary')?.textContent).toBe('Reading queue');
  });

  it('adds the top filter match on Enter and saves on Ctrl+Enter', async () => {
    deferSettings = false;
    const onconfirm = vi.fn();
    const target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(CollectionPickerHost, { target, props: { onconfirm } });
    flushSync();
    pending[0].resolve({ items: [], memberships: [], truncated: false });
    await vi.waitFor(() => {
      flushSync();
      expect(document.body.querySelector('.search-input')).not.toBeNull();
      expect(document.body.textContent).not.toContain('Checking existing saves');
    });

    const input = document.body.querySelector('.search-input') as HTMLInputElement;
    input.value = 'safe';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    expect(document.body.querySelector('.list-count')?.textContent?.trim()).toBe('1 of 4');

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    flushSync();
    expect(input.value).toBe('');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));
    flushSync();
    expect(onconfirm).toHaveBeenCalledWith({
      mode: 'create',
      collections: [{ uri: 'at://did:plc:test/network.cosmik.collection/ai', cid: 'bafyai' }],
    });
  });
});
