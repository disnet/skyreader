// Named `.component.test.ts` so it runs in the project that compiles runes —
// the store is a `.svelte.ts` module and `$state` needs the Svelte plugin.
//
// Highlights made in guest mode have to reach an EXISTING account additively.
// A guest's array holds only what was highlighted here (guest mode starts from
// a cleared cache), so draining it as an authoritative replace either loses the
// account's highlights on that article or is refused and loses these. Both are
// silent. See the merge semantics in backend/src/routes/labels.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Highlight } from '$lib/types';

const enqueue = vi.fn(async () => {});
const cancelPending = vi.fn(async () => {});
vi.mock('$lib/services/sync-queue', () => ({ syncQueue: { enqueue, cancelPending } }));

const api = {
  addLabel: vi.fn(async () => ({ success: true })),
  deleteLabel: vi.fn(async () => {}),
};
vi.mock('$lib/services/api', () => ({ api }));

const table = () => ({
  get: async () => undefined,
  put: async () => {},
  toArray: async () => [],
  where: () => ({
    equals: () => ({
      delete: async () => {},
      first: async () => undefined,
      toArray: async () => [],
    }),
  }),
  bulkPut: async () => {},
  clear: async () => {},
});
vi.mock('$lib/services/db', () => ({
  db: { itemLabels: table(), articles: table(), saved: table() },
  getMetadata: async () => undefined,
  setMetadata: async () => {},
}));
vi.mock('$lib/services/safeDb.svelte', () => ({
  safePut: async () => {},
  safeBulkPut: async () => {},
}));

const authState = { isGuest: true };
vi.mock('./auth.svelte', () => ({
  auth: {
    get isGuest() {
      return authState.isGuest;
    },
  },
}));
vi.mock('./sync.svelte', () => ({ syncStore: { isOnline: true } }));
vi.mock('./saves.svelte', () => ({ savesStore: { articles: [], loading: false } }));

const { itemLabelsStore } = await import('./itemLabels.svelte');

const ITEM = 'https://example.com/piece';
function hl(id: string): Highlight {
  return {
    id,
    selector: { exact: id },
    createdAt: Date.now(),
  } as unknown as Highlight;
}

describe('highlight writes made in guest mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.isGuest = true;
  });

  it('queues an additive merge write, not an authoritative replace', async () => {
    await itemLabelsStore.addHighlight(ITEM, 'article', hl('guest-1'));

    expect(api.addLabel).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      'create',
      'label',
      expect.stringContaining('highlights'),
      expect.objectContaining({ label: 'highlights', mode: 'merge' })
    );
  });

  it('drops the pending write instead of queueing a delete that would tombstone the account', async () => {
    await itemLabelsStore.addHighlight(ITEM, 'article', hl('guest-1'));
    enqueue.mockClear();

    await itemLabelsStore.removeHighlight(ITEM, 'guest-1');

    expect(cancelPending).toHaveBeenCalledWith('label', expect.stringContaining('highlights'));
    expect(enqueue).not.toHaveBeenCalledWith(
      'delete',
      'label',
      expect.anything(),
      expect.anything()
    );
    expect(api.deleteLabel).not.toHaveBeenCalled();
  });

  it('writes normally (replace, and removal still propagates) for an account', async () => {
    authState.isGuest = false;

    await itemLabelsStore.addHighlight(ITEM, 'article', hl('acct-1'));
    expect(api.addLabel).toHaveBeenCalledWith(expect.not.objectContaining({ mode: 'merge' }));

    await itemLabelsStore.removeHighlight(ITEM, 'acct-1');
    expect(api.deleteLabel).toHaveBeenCalled();
    expect(cancelPending).not.toHaveBeenCalled();
  });
});
