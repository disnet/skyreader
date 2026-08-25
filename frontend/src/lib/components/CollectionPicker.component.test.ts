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
      ],
      margin: [],
    },
    loading: { semble: false, margin: false },
    refreshing: { semble: false, margin: false },
    error: { semble: null, margin: null },
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
});
