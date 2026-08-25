import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import CollectionPickerHost from './CollectionPicker.test-host.svelte';

const pending: Array<{
  url: string;
  resolve: (value: { items: []; memberships: []; truncated: boolean }) => void;
}> = [];

vi.mock('$lib/services/api', () => ({
  api: {
    getIntegrationMemberships: vi.fn(
      (_kind: string, url: string) =>
        new Promise((resolve) => pending.push({ url, resolve: resolve as (value: any) => void }))
    ),
    getSettings: vi.fn(async () => ({ backing: null })),
  },
}));

vi.mock('$lib/stores/collections.svelte', () => ({
  collectionsStore: {
    collections: { semble: [], margin: [] },
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

    expect(document.body.textContent).toContain('Loading collections...');
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
