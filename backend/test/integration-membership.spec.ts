import { describe, it, expect, vi } from 'vitest';
import {
  findMemberships,
  editMemberships,
  MembershipEditError,
} from '../src/services/integration-membership';
import type { PDSClient } from '../src/services/pds-client';

const DID = 'did:plc:membertest';
const CARD = 'network.cosmik.card';
const LINK = 'network.cosmik.collectionLink';
const NOTE = 'at.margin.note';
const ITEM = 'at.margin.collectionItem';

const COL_A = `at://${DID}/network.cosmik.collection/a`;
const COL_B = `at://${DID}/network.cosmik.collection/b`;
const MCOL_A = `at://${DID}/at.margin.collection/a`;

const URL_A = 'https://example.test/posts/one';

type Records = Record<string, Array<{ uri: string; cid: string; value: Record<string, unknown> }>>;

/**
 * Fake PDSClient serving canned listRecords per collection. `truncatedFor` marks
 * collections whose listing hit the page cap.
 */
function fakeClient(
  records: Records,
  overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {},
  truncatedFor: string[] = []
) {
  return {
    listAllRecords: vi.fn(async (collection: string) => ({
      success: true,
      data: records[collection] ?? [],
      truncated: truncatedFor.includes(collection),
    })),
    getRecord: vi.fn(async (collection: string, rkey: string) => ({
      success: true,
      data: { uri: `at://${DID}/${collection}/${rkey}`, cid: `cid-${rkey}`, value: {} },
    })),
    putRecord: vi.fn(async (collection: string, rkey: string) => ({
      success: true,
      data: { uri: `at://${DID}/${collection}/${rkey}`, cid: `cid-${rkey}` },
    })),
    deleteRecord: vi.fn(async () => ({ success: true, data: undefined })),
    applyWrites: vi.fn(async (writes: Array<{ collection: string; rkey: string }>) => ({
      success: true,
      data: {
        commit: { cid: 'c', rev: 'r' },
        results: writes.map((w) => ({
          uri: `at://${DID}/${w.collection}/${w.rkey}`,
          cid: `cid-${w.rkey}`,
        })),
      },
    })),
    ...overrides,
  } as unknown as PDSClient;
}

const card = (rkey: string, url: string, createdAt?: string) => ({
  uri: `at://${DID}/${CARD}/${rkey}`,
  cid: `cid-${rkey}`,
  value: { type: 'URL', content: { url }, url, createdAt },
});

const link = (rkey: string, cardRkey: string, collectionUri: string) => ({
  uri: `at://${DID}/${LINK}/${rkey}`,
  cid: `cid-${rkey}`,
  value: {
    card: { uri: `at://${DID}/${CARD}/${cardRkey}`, cid: `cid-${cardRkey}` },
    collection: { uri: collectionUri, cid: 'stale-cid' },
  },
});

const note = (rkey: string, source: string, motivation = 'bookmarking') => ({
  uri: `at://${DID}/${NOTE}/${rkey}`,
  cid: `cid-${rkey}`,
  value: { motivation, target: { source } },
});

const collectionItem = (rkey: string, noteRkey: string, collectionUri: string) => ({
  uri: `at://${DID}/${ITEM}/${rkey}`,
  cid: `cid-${rkey}`,
  value: { annotation: `at://${DID}/${NOTE}/${noteRkey}`, collection: collectionUri },
});

describe('findMemberships — Semble', () => {
  it('matches cards by normalized URL and returns only their links', async () => {
    const pds = fakeClient({
      [CARD]: [
        card('c1', `${URL_A}/?utm_source=newsletter#intro`),
        card('c2', 'https://example.test/posts/two'),
      ],
      [LINK]: [link('l1', 'c1', COL_A), link('l2', 'c2', COL_B)],
    });

    const res = await findMemberships(pds, 'semble', URL_A);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.items.map((i) => i.uri)).toEqual([`at://${DID}/${CARD}/c1`]);
    expect(res.data.memberships).toEqual([
      {
        collectionUri: COL_A,
        linkUri: `at://${DID}/${LINK}/l1`,
        itemUri: `at://${DID}/${CARD}/c1`,
      },
    ]);
    expect(res.data.truncated).toBe(false);
  });

  it('aggregates collections across duplicate cards, newest item first', async () => {
    const pds = fakeClient({
      [CARD]: [
        card('c1', URL_A, '2026-01-01T00:00:00.000Z'),
        card('c2', URL_A, '2026-05-01T00:00:00.000Z'),
      ],
      [LINK]: [link('l1', 'c1', COL_A), link('l2', 'c2', COL_B)],
    });

    const res = await findMemberships(pds, 'semble', URL_A);
    if (!res.success) throw new Error('expected success');
    expect(res.data.items[0].uri).toBe(`at://${DID}/${CARD}/c2`);
    expect(res.data.memberships.map((m) => m.collectionUri).sort()).toEqual([COL_A, COL_B].sort());
  });

  it('skips a free-text NOTE card and never lists links when no card matched', async () => {
    const pds = fakeClient({
      [CARD]: [
        {
          uri: `at://${DID}/${CARD}/n1`,
          cid: 'cid-n1',
          value: { type: 'NOTE', content: { url: URL_A } },
        },
      ],
      [LINK]: [link('l1', 'n1', COL_A)],
    });

    const res = await findMemberships(pds, 'semble', URL_A);
    if (!res.success) throw new Error('expected success');
    expect(res.data.items).toEqual([]);
    expect(res.data.memberships).toEqual([]);
    expect(pds.listAllRecords).toHaveBeenCalledTimes(1);
  });

  it('propagates truncation from either listing', async () => {
    const pds = fakeClient({ [CARD]: [card('c1', URL_A)], [LINK]: [link('l1', 'c1', COL_A)] }, {}, [
      LINK,
    ]);
    const res = await findMemberships(pds, 'semble', URL_A);
    if (!res.success) throw new Error('expected success');
    expect(res.data.truncated).toBe(true);
  });

  it('rejects a URL that cannot be normalized', async () => {
    const res = await findMemberships(fakeClient({}), 'semble', 'not-a-url');
    expect(res).toEqual({ success: false, error: expect.stringContaining('url') });
  });
});

describe('findMemberships — Margin', () => {
  it('only treats bookmarking notes as saves, not highlights on the same URL', async () => {
    const pds = fakeClient({
      [NOTE]: [note('b1', URL_A), note('h1', URL_A, 'highlighting')],
      [ITEM]: [collectionItem('i1', 'b1', MCOL_A), collectionItem('i2', 'h1', MCOL_A)],
    });

    const res = await findMemberships(pds, 'margin', URL_A);
    if (!res.success) throw new Error('expected success');
    expect(res.data.items.map((i) => i.uri)).toEqual([`at://${DID}/${NOTE}/b1`]);
    expect(res.data.memberships).toEqual([
      {
        collectionUri: MCOL_A,
        linkUri: `at://${DID}/${ITEM}/i1`,
        itemUri: `at://${DID}/${NOTE}/b1`,
      },
    ]);
  });
});

describe('editMemberships — removal validation', () => {
  const cases: Array<[string, string, number]> = [
    ['another repo', `at://did:plc:someoneelse/${LINK}/l1`, 403],
    ['the item lexicon, not the membership one', `at://${DID}/${CARD}/c1`, 400],
    ['a non-at-uri', 'https://example.test/nope', 400],
  ];

  for (const [label, uri, status] of cases) {
    it(`refuses to delete ${label}`, async () => {
      const pds = fakeClient({});
      await expect(
        editMemberships(pds, DID, 'semble', { url: URL_A, add: [], remove: [uri] })
      ).rejects.toMatchObject({ status });
      expect(pds.deleteRecord).not.toHaveBeenCalled();
    });
  }

  it('rejects the whole batch before deleting anything', async () => {
    const pds = fakeClient({ [CARD]: [card('c1', URL_A)], [LINK]: [link('l1', 'c1', COL_A)] });
    await expect(
      editMemberships(pds, DID, 'semble', {
        url: URL_A,
        add: [],
        remove: [`at://${DID}/${LINK}/l1`, `at://did:plc:other/${LINK}/l2`],
      })
    ).rejects.toBeInstanceOf(MembershipEditError);
    expect(pds.deleteRecord).not.toHaveBeenCalled();
  });

  it('refuses a valid membership URI that belongs to another URL', async () => {
    const pds = fakeClient({
      [CARD]: [card('c1', URL_A), card('c2', 'https://example.test/posts/two')],
      [LINK]: [link('l1', 'c1', COL_A), link('l2', 'c2', COL_B)],
    });

    await expect(
      editMemberships(pds, DID, 'semble', {
        url: URL_A,
        add: [],
        remove: [`at://${DID}/${LINK}/l2`],
      })
    ).rejects.toMatchObject({ status: 403 });
    expect(pds.deleteRecord).not.toHaveBeenCalled();
  });

  it('treats a membership missing before authorization as already removed and still adds', async () => {
    const gone = `at://${DID}/${LINK}/gone`;
    const pds = fakeClient(
      { [CARD]: [card('c1', URL_A)], [LINK]: [] },
      {
        getRecord: vi.fn(async (collection: string, rkey: string) =>
          collection === LINK && rkey === 'gone'
            ? { success: false, error: 'Could not locate record', retryable: false }
            : {
                success: true,
                data: { uri: `at://${DID}/${collection}/${rkey}`, cid: `cid-${rkey}`, value: {} },
              }
        ),
      }
    );

    const res = await editMemberships(pds, DID, 'semble', {
      url: URL_A,
      add: [{ uri: COL_A, cid: 'x' }],
      remove: [gone],
    });

    expect(pds.deleteRecord).not.toHaveBeenCalled();
    expect(res.removed).toEqual([{ linkUri: gone }]);
    expect(res.added).toEqual([{ collectionUri: COL_A, linkUri: expect.stringContaining(LINK) }]);
  });
});

describe('editMemberships — Semble', () => {
  it('deletes unchecked links and adds new ones with a freshly resolved collection cid', async () => {
    const pds = fakeClient({
      [CARD]: [card('c1', URL_A)],
      [LINK]: [link('l1', 'c1', COL_A)],
    });

    const res = await editMemberships(pds, DID, 'semble', {
      url: URL_A,
      add: [{ uri: COL_B, cid: 'stale-client-cid' }],
      remove: [`at://${DID}/${LINK}/l1`],
    });

    expect(pds.deleteRecord).toHaveBeenCalledWith(LINK, 'l1');
    expect(res.removed).toEqual([{ linkUri: `at://${DID}/${LINK}/l1` }]);
    // the card is NEVER deleted, only the membership
    expect((pds.deleteRecord as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);

    const put = (pds.putRecord as ReturnType<typeof vi.fn>).mock.calls;
    expect(put).toHaveLength(1);
    expect(put[0][0]).toBe(LINK);
    expect(put[0][2].collection).toEqual({ uri: COL_B, cid: 'cid-b' });
    expect(put[0][2].card).toEqual({ uri: `at://${DID}/${CARD}/c1`, cid: 'cid-c1' });
    expect(res.item).toEqual({ uri: `at://${DID}/${CARD}/c1`, cid: 'cid-c1', created: false });
    expect(res.added).toEqual([{ collectionUri: COL_B, linkUri: expect.stringContaining(LINK) }]);
  });

  it('creates the card when the URL has never been saved', async () => {
    const pds = fakeClient({ [CARD]: [], [LINK]: [] });

    const res = await editMemberships(pds, DID, 'semble', {
      url: URL_A,
      title: 'One',
      add: [{ uri: COL_A, cid: 'x' }],
      remove: [],
    });

    const put = (pds.putRecord as ReturnType<typeof vi.fn>).mock.calls;
    expect(put[0][0]).toBe(CARD);
    expect(put[0][2].content).toEqual({ url: URL_A, metadata: { title: 'One' } });
    expect(put[1][0]).toBe(LINK);
    expect(res.item?.created).toBe(true);
  });

  it('does not duplicate a link for a collection the card is already in', async () => {
    const pds = fakeClient({
      [CARD]: [card('c1', URL_A)],
      [LINK]: [link('l1', 'c1', COL_A)],
    });

    const res = await editMemberships(pds, DID, 'semble', {
      url: URL_A,
      add: [{ uri: COL_A, cid: 'x' }],
      remove: [],
    });

    expect(pds.putRecord).not.toHaveBeenCalled();
    expect(res.added).toEqual([]);
  });

  it('can replace a removed membership in the same collection', async () => {
    const pds = fakeClient({
      [CARD]: [card('c1', URL_A)],
      [LINK]: [link('l1', 'c1', COL_A)],
    });

    const res = await editMemberships(pds, DID, 'semble', {
      url: URL_A,
      add: [{ uri: COL_A, cid: 'x' }],
      remove: [`at://${DID}/${LINK}/l1`],
    });

    expect(pds.deleteRecord).toHaveBeenCalledWith(LINK, 'l1');
    expect(pds.putRecord).toHaveBeenCalledWith(LINK, expect.any(String), expect.any(Object));
    expect(res.added).toEqual([{ collectionUri: COL_A, linkUri: expect.stringContaining(LINK) }]);
  });

  it('treats a link that is already gone as removed', async () => {
    const pds = fakeClient(
      { [CARD]: [card('c1', URL_A)], [LINK]: [link('gone', 'c1', COL_A)] },
      {
        deleteRecord: vi.fn(async () => ({
          success: false,
          error: 'Could not locate record',
          retryable: false,
        })),
      }
    );

    const res = await editMemberships(pds, DID, 'semble', {
      url: URL_A,
      add: [],
      remove: [`at://${DID}/${LINK}/gone`],
    });
    expect(res.removed).toEqual([{ linkUri: `at://${DID}/${LINK}/gone` }]);
  });

  it('reports a failed link write instead of hiding it', async () => {
    const pds = fakeClient(
      { [CARD]: [card('c1', URL_A)], [LINK]: [] },
      { putRecord: vi.fn(async () => ({ success: false, error: 'boom', retryable: true })) }
    );

    const res = await editMemberships(pds, DID, 'semble', {
      url: URL_A,
      add: [{ uri: COL_A, cid: 'x' }],
      remove: [],
    });
    expect(res.added).toEqual([{ collectionUri: COL_A, error: 'boom' }]);
  });
});

describe('editMemberships — Margin', () => {
  it('batches collectionItem creates and deletes only membership records', async () => {
    const pds = fakeClient({
      [NOTE]: [note('b1', URL_A)],
      [ITEM]: [collectionItem('i1', 'b1', MCOL_A)],
    });
    const COL_C = `at://${DID}/at.margin.collection/c`;

    const res = await editMemberships(pds, DID, 'margin', {
      url: URL_A,
      add: [{ uri: COL_C }],
      remove: [`at://${DID}/${ITEM}/i1`],
    });

    expect(pds.deleteRecord).toHaveBeenCalledWith(ITEM, 'i1');
    const writes = (pds.applyWrites as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(writes).toHaveLength(1);
    expect(writes[0].collection).toBe(ITEM);
    expect(writes[0].value).toMatchObject({
      collection: COL_C,
      annotation: `at://${DID}/${NOTE}/b1`,
    });
    expect(res.added[0].linkUri).toContain(ITEM);
  });

  it('creates a bookmarking note when the URL has none', async () => {
    const pds = fakeClient({ [NOTE]: [note('h1', URL_A, 'highlighting')], [ITEM]: [] });

    const res = await editMemberships(pds, DID, 'margin', {
      url: URL_A,
      title: 'One',
      add: [{ uri: MCOL_A }],
      remove: [],
    });

    const put = (pds.putRecord as ReturnType<typeof vi.fn>).mock.calls;
    expect(put[0][0]).toBe(NOTE);
    expect(put[0][2].motivation).toBe('bookmarking');
    expect(res.item?.created).toBe(true);
  });
});
