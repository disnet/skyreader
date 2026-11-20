import { describe, it, expect, vi } from 'vitest';
import {
  createMember,
  removeMember,
  createCollection,
  listCollectionNames,
} from '../src/services/backing/write';
import type { PDSClient } from '../src/services/pds-client';

const DID = 'did:plc:writetest';
const SEMBLE_COL = `at://${DID}/network.cosmik.collection/col1`;
const MARGIN_COL = `at://${DID}/at.margin.collection/col1`;

// Minimal fake PDSClient — only the methods the write path touches.
function fakeClient(overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
  return {
    getRecord: vi.fn(async () => ({
      success: true,
      data: { uri: 'x', cid: 'collectionCid', value: {} },
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

describe('createMember — Semble (sequential: card then link)', () => {
  it('writes card then collectionLink and returns both handles', async () => {
    const pds = fakeClient();
    const handles = await createMember(pds, DID, 'semble', SEMBLE_COL, {
      url: 'https://a.test/x',
      title: 'A',
    });
    const put = (pds.putRecord as ReturnType<typeof vi.fn>).mock.calls;
    expect(put[0][0]).toBe('network.cosmik.card');
    expect(put[1][0]).toBe('network.cosmik.collectionLink');
    // link references the card's uri+cid (strongRef) and the resolved collection cid
    const link = put[1][2];
    expect(link.card.uri).toBe(handles.itemUri);
    expect(link.card.cid).toMatch(/^cid-/);
    expect(link.collection).toEqual({ uri: SEMBLE_COL, cid: 'collectionCid' });
    expect(handles.itemUri).toContain('network.cosmik.card');
    expect(handles.linkUri).toContain('network.cosmik.collectionLink');
  });

  it('stashes a canonical at:// peer ref in card metadata (documents)', async () => {
    const pds = fakeClient();
    await createMember(pds, DID, 'semble', SEMBLE_COL, {
      url: 'https://skyreader.app/blogs/did/rk',
      canonicalAtUri: 'at://did:plc:x/site.standard.document/rk',
    });
    const card = (pds.putRecord as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(card.content.metadata.skyreaderRecord).toBe('at://did:plc:x/site.standard.document/rk');
    expect(card.content.url).toBe('https://skyreader.app/blogs/did/rk');
  });

  it('cleans up the orphan card when the collectionLink write fails', async () => {
    const putRecord = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        data: { uri: `at://${DID}/network.cosmik.card/c1`, cid: 'cc' },
      })
      .mockResolvedValueOnce({ success: false, error: 'boom', retryable: true });
    const deleteRecord = vi.fn(async () => ({ success: true, data: undefined }));
    const pds = fakeClient({ putRecord, deleteRecord });
    await expect(
      createMember(pds, DID, 'semble', SEMBLE_COL, { url: 'https://a.test/x' })
    ).rejects.toThrow();
    // the card is deleted by the SAME rkey it was created with (generated TID)
    const cardRkey = putRecord.mock.calls[0][1];
    expect(deleteRecord).toHaveBeenCalledWith('network.cosmik.card', cardRkey);
  });
});

describe('createMember — Margin (atomic applyWrites)', () => {
  it('creates note + collectionItem in one batch with annotation = note uri', async () => {
    const pds = fakeClient();
    const handles = await createMember(pds, DID, 'margin', MARGIN_COL, {
      url: 'https://b.test/y',
      title: 'B',
    });
    const writes = (pds.applyWrites as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(writes).toHaveLength(2);
    expect(writes[0].collection).toBe('at.margin.note');
    expect(writes[0].value.motivation).toBe('bookmarking');
    expect(writes[0].value.target.source).toBe('https://b.test/y');
    expect(writes[1].collection).toBe('at.margin.collectionItem');
    // collectionItem.annotation points at the note uri; .collection at the collection
    expect(writes[1].value.annotation).toBe(`at://${DID}/at.margin.note/${writes[0].rkey}`);
    expect(writes[1].value.collection).toBe(MARGIN_COL);
    expect(handles.itemUri).toContain('at.margin.note');
    expect(handles.linkUri).toContain('at.margin.collectionItem');
  });

  it("never writes the article's description as the note body", async () => {
    const pds = fakeClient();
    await createMember(pds, DID, 'margin', MARGIN_COL, {
      url: 'https://b.test/y',
      title: 'B',
      description: 'a summary',
    });
    const note = (pds.applyWrites as ReturnType<typeof vi.fn>).mock.calls[0][0][0].value;
    expect(note.body).toBeUndefined();
  });

  it('omits the note body when no description is given', async () => {
    const pds = fakeClient();
    await createMember(pds, DID, 'margin', MARGIN_COL, { url: 'https://b.test/y' });
    const note = (pds.applyWrites as ReturnType<typeof vi.fn>).mock.calls[0][0][0].value;
    expect(note.body).toBeUndefined();
  });
});

describe('createMember — Semble failure modes', () => {
  it('throws when the backing collection cid cannot be resolved', async () => {
    // getRecord fails → resolveCid returns null → cannot build the link strongRef.
    const getRecord = vi.fn(async () => ({ success: false, error: 'not found' }));
    const putRecord = vi.fn();
    const pds = fakeClient({ getRecord, putRecord });
    await expect(
      createMember(pds, DID, 'semble', SEMBLE_COL, { url: 'https://a.test/x' })
    ).rejects.toThrow(/collection cid/);
    expect(putRecord).not.toHaveBeenCalled(); // bailed before writing the card
  });

  it('throws when the card write itself fails', async () => {
    const putRecord = vi.fn(async () => ({ success: false, error: 'boom' }));
    const pds = fakeClient({ putRecord });
    await expect(
      createMember(pds, DID, 'semble', SEMBLE_COL, { url: 'https://a.test/x' })
    ).rejects.toThrow(/card write failed/);
  });
});

describe('createMember — Semble stray cards', () => {
  const STRAY = `at://${DID}/network.cosmik.card/3stray0000000`;

  it('names the card when the link and its cleanup are both refused', async () => {
    const putRecord = vi.fn(async (collection: string, rkey: string) =>
      collection === 'network.cosmik.collectionLink'
        ? { success: false, error: 'Rate Limit Exceeded' }
        : { success: true, data: { uri: `at://${DID}/${collection}/${rkey}`, cid: 'c' } }
    );
    const deleteRecord = vi.fn(async () => ({ success: false, error: 'Rate Limit Exceeded' }));
    const pds = fakeClient({ putRecord, deleteRecord });
    const err = await createMember(pds, DID, 'semble', SEMBLE_COL, {
      url: 'https://a.test/x',
    }).catch((e) => e);
    expect(err.strayCardUri).toMatch(/^at:\/\/did:plc:writetest\/network\.cosmik\.card\//);
  });

  it('names no card when the cleanup went through', async () => {
    const putRecord = vi.fn(async (collection: string, rkey: string) =>
      collection === 'network.cosmik.collectionLink'
        ? { success: false, error: 'boom' }
        : { success: true, data: { uri: `at://${DID}/${collection}/${rkey}`, cid: 'c' } }
    );
    const err = await createMember(fakeClient({ putRecord }), DID, 'semble', SEMBLE_COL, {
      url: 'https://a.test/x',
    }).catch((e) => e);
    expect(err.strayCardUri).toBeUndefined();
  });

  it('links a stray card that is still there instead of writing a new one', async () => {
    const getRecord = vi.fn(async (collection: string) => ({
      success: true,
      data: {
        uri: 'x',
        cid: collection === 'network.cosmik.card' ? 'strayCid' : 'colCid',
        value: {},
      },
    }));
    const pds = fakeClient({ getRecord });
    const handles = await createMember(
      pds,
      DID,
      'semble',
      SEMBLE_COL,
      { url: 'https://a.test/x' },
      { reuseCardUri: STRAY }
    );
    expect(handles.itemUri).toBe(STRAY);
    const puts = (pds.putRecord as ReturnType<typeof vi.fn>).mock.calls;
    expect(puts.map((c) => c[0])).toEqual(['network.cosmik.collectionLink']);
    expect(puts[0][2].card).toEqual({ uri: STRAY, cid: 'strayCid' });
  });

  it('keeps naming the stray card when it is linked and refused again', async () => {
    const getRecord = vi.fn(async () => ({
      success: true,
      data: { uri: 'x', cid: 'c', value: {} },
    }));
    const putRecord = vi.fn(async () => ({ success: false, error: 'Rate Limit Exceeded' }));
    const deleteRecord = vi.fn(async () => ({ success: false, error: 'Rate Limit Exceeded' }));
    const err = await createMember(
      fakeClient({ getRecord, putRecord, deleteRecord }),
      DID,
      'semble',
      SEMBLE_COL,
      { url: 'https://a.test/x' },
      { reuseCardUri: STRAY }
    ).catch((e) => e);
    expect(err.strayCardUri).toBe(STRAY);
  });

  it('keeps the stray card, writing nothing, when it cannot be read', async () => {
    const getRecord = vi.fn(async (collection: string) =>
      collection === 'network.cosmik.card'
        ? { success: false, error: 'HTTP 502', status: 502, retryable: true }
        : { success: true, data: { uri: 'x', cid: 'colCid', value: {} } }
    );
    const pds = fakeClient({ getRecord });
    const err = await createMember(
      pds,
      DID,
      'semble',
      SEMBLE_COL,
      { url: 'https://a.test/x' },
      { reuseCardUri: STRAY }
    ).catch((e) => e);
    expect(err.strayCardUri).toBe(STRAY);
    expect(pds.putRecord).not.toHaveBeenCalled();
  });

  it('writes a new card when the stray one is gone', async () => {
    const getRecord = vi.fn(async (collection: string) =>
      collection === 'network.cosmik.card'
        ? { success: false, error: 'Could not locate record', code: 'RecordNotFound' }
        : { success: true, data: { uri: 'x', cid: 'colCid', value: {} } }
    );
    const pds = fakeClient({ getRecord });
    const handles = await createMember(
      pds,
      DID,
      'semble',
      SEMBLE_COL,
      { url: 'https://a.test/x' },
      { reuseCardUri: STRAY }
    );
    expect(handles.itemUri).not.toBe(STRAY);
    const puts = (pds.putRecord as ReturnType<typeof vi.fn>).mock.calls;
    expect(puts.map((c) => c[0])).toEqual(['network.cosmik.card', 'network.cosmik.collectionLink']);
  });
});

describe('createCollection', () => {
  it('writes a network.cosmik.collection with the Semble shape and returns its uri', async () => {
    const pds = fakeClient();
    const { uri } = await createCollection(pds, 'semble', 'Skyreader Saves');
    const [collection, , record] = (pds.putRecord as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(collection).toBe('network.cosmik.collection');
    expect(record.name).toBe('Skyreader Saves');
    expect(record.accessType).toBe('CLOSED');
    expect(record.collaborators).toEqual([]);
    expect(uri).toContain('network.cosmik.collection');
  });

  it('writes the room settings onto a Semble collection when asked', async () => {
    const pds = fakeClient();
    await createCollection(pds, 'semble', 'Slow Reads', {
      accessType: 'OPEN',
      description: 'Long pieces, read slowly.',
    });
    const [, , record] = (pds.putRecord as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(record.accessType).toBe('OPEN');
    expect(record.description).toBe('Long pieces, read slowly.');
  });

  it('leaves description off the record rather than writing it blank', async () => {
    const pds = fakeClient();
    await createCollection(pds, 'semble', 'Slow Reads', { description: undefined });
    const [, , record] = (pds.putRecord as ReturnType<typeof vi.fn>).mock.calls[0];
    expect('description' in record).toBe(false);
  });

  it('ignores the Semble-only options on a Margin collection', async () => {
    const pds = fakeClient();
    await createCollection(pds, 'margin', 'Slow Reads', {
      accessType: 'OPEN',
      description: 'x',
    });
    const [, , record] = (pds.putRecord as ReturnType<typeof vi.fn>).mock.calls[0];
    expect('accessType' in record).toBe(false);
    expect('description' in record).toBe(false);
  });

  it('writes an at.margin.collection with the Margin shape', async () => {
    const pds = fakeClient();
    await createCollection(pds, 'margin', 'Skyreader Saves');
    const [collection, , record] = (pds.putRecord as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(collection).toBe('at.margin.collection');
    expect(record.name).toBe('Skyreader Saves');
    expect(record.icon).toBe('icon:folder');
  });

  it('throws when the create fails', async () => {
    const putRecord = vi.fn(async () => ({ success: false, error: 'denied' }));
    const pds = fakeClient({ putRecord });
    await expect(createCollection(pds, 'semble', 'X')).rejects.toThrow(/collection create failed/);
  });
});

describe('listCollectionNames', () => {
  it('returns the non-empty names from the provider collection', async () => {
    const listAllRecords = vi.fn(async () => ({
      success: true,
      data: [
        { value: { name: 'Reading' } },
        { value: { name: '  ' } }, // blank → dropped
        { value: {} }, // missing → dropped
        { value: { name: 'Skyreader Saves' } },
      ],
    }));
    const pds = fakeClient({ listAllRecords });
    const names = await listCollectionNames(pds, 'semble');
    expect(names).toEqual(['Reading', 'Skyreader Saves']);
  });

  it('returns [] (best-effort) when the list fails, so enable can still proceed', async () => {
    const listAllRecords = vi.fn(async () => ({ success: false, error: 'boom' }));
    const pds = fakeClient({ listAllRecords });
    expect(await listCollectionNames(pds, 'margin')).toEqual([]);
  });
});

describe('removeMember — membership only', () => {
  it('deletes the link record by its parsed collection+rkey', async () => {
    const pds = fakeClient();
    await removeMember(pds, 'semble', {
      linkUri: `at://${DID}/network.cosmik.collectionLink/link9`,
    });
    expect(pds.deleteRecord).toHaveBeenCalledWith('network.cosmik.collectionLink', 'link9');
  });

  it('throws on a malformed membership uri', async () => {
    const pds = fakeClient();
    await expect(removeMember(pds, 'margin', { linkUri: 'not-an-at-uri' })).rejects.toThrow();
  });
});
