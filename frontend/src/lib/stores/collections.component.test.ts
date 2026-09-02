// Named `.component.test.ts` so the Svelte plugin compiles this rune store.
import { beforeEach, describe, expect, it, vi } from 'vitest';

class FakeScopeUpgradeError extends Error {
  constructor() {
    super('scope upgrade');
    this.name = 'ScopeUpgradeError';
  }
}

const listCurrentsCollections = vi.fn();
const cachedCurrents = {
  integration: 'currents',
  uri: 'at://did:plc:reader/is.currents.feed.collection/one',
  cid: 'bafycollection',
  name: 'Reference',
  cachedAt: 1,
};

const collectionQuery = {
  equals: vi.fn(() => collectionQuery),
  toArray: vi.fn(async () => [cachedCurrents]),
  delete: vi.fn(),
};

vi.mock('$lib/services/db', () => ({
  db: {
    integrationCollections: {
      where: vi.fn(() => collectionQuery),
    },
  },
}));

vi.mock('$lib/services/api', () => ({
  api: {
    listCurrentsCollections: (...args: unknown[]) => listCurrentsCollections(...args),
  },
  ScopeUpgradeError: FakeScopeUpgradeError,
}));

const { collectionsStore } = await import('./collections.svelte');

beforeEach(async () => {
  listCurrentsCollections.mockReset();
  collectionQuery.equals.mockClear();
  collectionQuery.toArray.mockClear();
  await collectionsStore.invalidate('currents');
});

describe('collectionsStore', () => {
  it('surfaces missing Currents scopes even when cached collections exist', async () => {
    listCurrentsCollections.mockRejectedValue(new FakeScopeUpgradeError());

    await collectionsStore.loadAndRefresh('currents');

    expect(collectionsStore.collections.currents).toEqual([
      expect.objectContaining({ uri: cachedCurrents.uri, name: 'Reference' }),
    ]);
    expect(collectionsStore.error.currents).toBe('scope_upgrade_required');
    expect(collectionsStore.loading.currents).toBe(false);
    expect(collectionsStore.refreshing.currents).toBe(false);
  });
});
