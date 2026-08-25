// Named `.component.test.ts` so it runs in the project that compiles runes —
// the store is a `.svelte.ts` module and `$state` needs the Svelte plugin.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';

class FakeScopeUpgradeError extends Error {
  constructor(message?: string) {
    super(message ?? 'scope upgrade');
    this.name = 'ScopeUpgradeError';
  }
}

const createSembleConnection = vi.fn();

vi.mock('$lib/services/api', () => ({
  api: {
    createSembleConnection: (...args: unknown[]) => createSembleConnection(...args),
  },
  ScopeUpgradeError: FakeScopeUpgradeError,
}));

vi.mock('$lib/stores/auth.svelte', () => ({
  auth: {
    get user() {
      return {
        did: 'did:plc:reader',
        handle: 'reader.bsky.social',
        displayName: 'The Reader',
        avatarUrl: null,
        pdsUrl: 'https://pds.test',
      };
    },
  },
}));

const addSembleConnection = vi.fn();
vi.mock('$lib/stores/mentionLaneItems.svelte', () => ({
  mentionLaneItemsStore: {
    addSembleConnection: (...args: unknown[]) => addSembleConnection(...args),
  },
}));

const { sembleConnectionStore } = await import('./sembleConnection.svelte');
const { toastStore } = await import('./toast.svelte');

const ARTICLE = 'https://example.test/the-article';
const SLASHED = 'https://example.test/the-article/';
const TARGET = 'https://other.test/the-rebuttal';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const OK = { uri: 'at://did:plc:reader/network.cosmik.connection/abc', cid: 'bafy', rkey: 'abc' };

beforeEach(() => {
  createSembleConnection.mockReset();
  addSembleConnection.mockReset();
  sembleConnectionStore.close();
  for (const toast of [...toastStore.toasts]) toastStore.remove(toast.id);
});

afterEach(() => vi.useRealTimers());

describe('sembleConnectionStore', () => {
  it('writes the edge in the direction the reader chose', async () => {
    createSembleConnection.mockResolvedValue(OK);
    sembleConnectionStore.openFor({ url: ARTICLE, title: 'The Article' });

    await sembleConnectionStore.submit({
      targetUrl: TARGET,
      connectionType: 'SUPPORTS',
      note: '  Worth reading.  ',
      reversed: false,
    });

    expect(createSembleConnection).toHaveBeenCalledWith({
      source: ARTICLE,
      target: TARGET,
      connectionType: 'SUPPORTS',
      note: 'Worth reading.',
    });
    expect(sembleConnectionStore.open).toBe(false);
  });

  it('swaps the endpoints when the reader flipped the arrow', async () => {
    createSembleConnection.mockResolvedValue(OK);
    sembleConnectionStore.openFor({ url: ARTICLE });

    await sembleConnectionStore.submit({
      targetUrl: TARGET,
      connectionType: 'LEADS_TO',
      reversed: true,
    });

    expect(createSembleConnection).toHaveBeenCalledWith(
      expect.objectContaining({ source: TARGET, target: ARTICLE })
    );
  });

  it('names the URL variant Semble actually holds, out of the card page', async () => {
    createSembleConnection.mockResolvedValue(OK);
    sembleConnectionStore.openFor({
      url: ARTICLE,
      cardUrl: `https://semble.so/url/${encodeURIComponent(SLASHED)}`,
    });

    await sembleConnectionStore.submit({
      targetUrl: TARGET,
      connectionType: 'RELATED',
      reversed: false,
    });

    expect(createSembleConnection).toHaveBeenCalledWith(
      expect.objectContaining({ source: SLASHED })
    );
  });

  it('omits an empty note rather than writing one', async () => {
    createSembleConnection.mockResolvedValue(OK);
    sembleConnectionStore.openFor({ url: ARTICLE });

    await sembleConnectionStore.submit({
      targetUrl: TARGET,
      connectionType: 'RELATED',
      note: '   ',
      reversed: false,
    });

    expect(createSembleConnection).toHaveBeenCalledWith(
      expect.objectContaining({ note: undefined })
    );
  });

  it('blocks a second submit while the first is in flight', async () => {
    // Semble dedupes identical edges through its own API; a direct PDS write
    // does not, so a double-click would mint two records.
    const gate = deferred<typeof OK>();
    createSembleConnection.mockReturnValue(gate.promise);
    sembleConnectionStore.openFor({ url: ARTICLE });

    const first = sembleConnectionStore.submit({
      targetUrl: TARGET,
      connectionType: 'RELATED',
      reversed: false,
    });
    flushSync();
    expect(sembleConnectionStore.submitting).toBe(true);

    await sembleConnectionStore.submit({
      targetUrl: TARGET,
      connectionType: 'RELATED',
      reversed: false,
    });
    expect(createSembleConnection).toHaveBeenCalledTimes(1);

    gate.resolve(OK);
    await first;
    expect(createSembleConnection).toHaveBeenCalledTimes(1);
    expect(sembleConnectionStore.submitting).toBe(false);
  });

  it('will not close out from under an in-flight write', async () => {
    const gate = deferred<typeof OK>();
    createSembleConnection.mockReturnValue(gate.promise);
    sembleConnectionStore.openFor({ url: ARTICLE });

    const inFlight = sembleConnectionStore.submit({
      targetUrl: TARGET,
      connectionType: 'RELATED',
      reversed: false,
    });
    sembleConnectionStore.close();
    expect(sembleConnectionStore.open).toBe(true);

    gate.resolve(OK);
    await inFlight;
  });

  it('echoes the new edge into the panel, since Semble will not serve it back yet', async () => {
    createSembleConnection.mockResolvedValue(OK);
    sembleConnectionStore.openFor({ url: ARTICLE });

    await sembleConnectionStore.submit({
      targetUrl: TARGET,
      targetTitle: 'The Rebuttal',
      connectionType: 'LEADS_TO',
      reversed: false,
    });

    expect(addSembleConnection).toHaveBeenCalledTimes(1);
    const [url, connection] = addSembleConnection.mock.calls[0];
    expect(url).toBe(ARTICLE);
    expect(connection).toMatchObject({
      id: OK.uri,
      direction: 'out',
      // Rendered the way the panel already renders relations.
      type: 'leads to',
      curator: { did: 'did:plc:reader', handle: 'reader.bsky.social' },
      other: { url: TARGET, title: 'The Rebuttal' },
    });
  });

  it('echoes a reversed edge as incoming', async () => {
    createSembleConnection.mockResolvedValue(OK);
    sembleConnectionStore.openFor({ url: ARTICLE });

    await sembleConnectionStore.submit({
      targetUrl: TARGET,
      connectionType: 'SUPPORTS',
      reversed: true,
    });

    expect(addSembleConnection.mock.calls[0][1]).toMatchObject({ direction: 'in' });
  });

  it('leaves the re-login banner to say it: no second, vaguer toast', async () => {
    createSembleConnection.mockRejectedValue(new FakeScopeUpgradeError());
    sembleConnectionStore.openFor({ url: ARTICLE });

    await sembleConnectionStore.submit({
      targetUrl: TARGET,
      connectionType: 'RELATED',
      reversed: false,
    });

    expect(toastStore.toasts).toHaveLength(0);
    expect(sembleConnectionStore.open).toBe(false);
    expect(addSembleConnection).not.toHaveBeenCalled();
  });

  it('keeps the dialog open on an ordinary failure so the reader can retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    createSembleConnection.mockRejectedValue(new Error('PDS unavailable'));
    sembleConnectionStore.openFor({ url: ARTICLE });

    await sembleConnectionStore.submit({
      targetUrl: TARGET,
      connectionType: 'RELATED',
      reversed: false,
    });

    expect(sembleConnectionStore.open).toBe(true);
    expect(sembleConnectionStore.submitting).toBe(false);
    expect(toastStore.toasts[0]).toMatchObject({
      state: 'error',
      message: "Couldn't connect on Semble — PDS unavailable",
    });
    expect(addSembleConnection).not.toHaveBeenCalled();
  });
});
