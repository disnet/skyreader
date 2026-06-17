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

  it('maps a description onto the note body (text/plain)', async () => {
    const pds = fakeClient();
    await createMember(pds, DID, 'margin', MARGIN_COL, {
      url: 'https://b.test/y',
      title: 'B',
      description: 'a summary',
    });
    const note = (pds.applyWrites as ReturnType<typeof vi.fn>).mock.calls[0][0][0].value;
    expect(note.body).toEqual({ value: 'a summary', format: 'text/plain' });
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
