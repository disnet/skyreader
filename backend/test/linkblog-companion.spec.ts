import { describe, it, expect, vi } from 'vitest';
import {
  syncCompanionRecord,
  PCKT_DOCUMENT_COLLECTION,
  PCKT_PUBLICATION_COLLECTION,
  OFFPRINT_ARTICLE_COLLECTION,
} from '../src/services/linkblog-sync';
import type { PDSClient } from '../src/services/pds-client';

// pckt and Offprint don't index site.standard.document directly: a post only
// appears on those hosts once a companion record in the app's own collection
// points at it. These tests pin the shape of each companion.

const DID = 'did:plc:companiontest';
const SITE_URI = `at://${DID}/site.standard.publication/3mstjwen4cdex`;
const PCKT_SITE_URI = `at://${DID}/${PCKT_PUBLICATION_COLLECTION}/3mstjwen4cdex`;
const RKEY = '3mstlogplj2sq';
const DOCUMENT = {
  uri: `at://${DID}/site.standard.document/${RKEY}`,
  cid: 'bafyreiawspkmwn7d3gt4iz5iad7elifwb3rit2dhxex2k2iinzh6s4dmxm',
};

function fakeClient(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  return {
    // By default the paired-rkey lookup finds a publication whose backref agrees.
    getRecord: vi.fn(async () => ({
      success: true,
      data: { uri: PCKT_SITE_URI, cid: 'pubcid', value: { publication: { uri: SITE_URI } } },
    })),
    listRecords: vi.fn(async () => ({ success: true, data: { records: [] } })),
    putRecord: vi.fn(async (collection: string, rkey: string) => ({
      success: true,
      data: { uri: `at://${DID}/${collection}/${rkey}`, cid: `cid-${rkey}` },
    })),
    ...overrides,
  } as unknown as PDSClient;
}

const putCalls = (pds: PDSClient) => (pds.putRecord as unknown as ReturnType<typeof vi.fn>).mock;

describe('syncCompanionRecord — pckt', () => {
  it('writes the companion at the document rkey, naming the pckt-side publication', async () => {
    const pds = fakeClient();
    await syncCompanionRecord(pds, DID, 'pckt', SITE_URI, RKEY, DOCUMENT);

    expect(putCalls(pds).calls).toHaveLength(1);
    const [collection, rkey, record] = putCalls(pds).calls[0];
    // Same rkey as the document, so later edits and deletes can address it directly.
    expect(collection).toBe(PCKT_DOCUMENT_COLLECTION);
    expect(rkey).toBe(RKEY);
    expect(record).toEqual({
      $type: PCKT_DOCUMENT_COLLECTION,
      // The pckt-side publication, not the standard.site one.
      site: PCKT_SITE_URI,
      document: { uri: DOCUMENT.uri, cid: DOCUMENT.cid },
    });
  });

  it('falls back to scanning when the same-rkey publication is not the right one', async () => {
    const pds = fakeClient({
      // A record exists at the paired rkey but fronts a different publication,
      // so the convention does not hold in this repo.
      getRecord: vi.fn(async () => ({
        success: true,
        data: { uri: 'x', cid: 'c', value: { publication: { uri: `at://${DID}/other/1` } } },
      })),
      listRecords: vi.fn(async () => ({
        success: true,
        data: {
          records: [
            { uri: `at://${DID}/${PCKT_PUBLICATION_COLLECTION}/nope`, cid: 'c', value: {} },
            {
              uri: `at://${DID}/${PCKT_PUBLICATION_COLLECTION}/found`,
              cid: 'c',
              value: { publication: { uri: SITE_URI } },
            },
          ],
        },
      })),
    });

    await syncCompanionRecord(pds, DID, 'pckt', SITE_URI, RKEY, DOCUMENT);

    expect(putCalls(pds).calls[0][2]).toMatchObject({
      site: `at://${DID}/${PCKT_PUBLICATION_COLLECTION}/found`,
    });
  });

  it('writes nothing when the repo has no matching pckt publication', async () => {
    const pds = fakeClient({
      getRecord: vi.fn(async () => ({ success: false, error: 'RecordNotFound', retryable: false })),
      listRecords: vi.fn(async () => ({ success: true, data: { records: [] } })),
    });

    await syncCompanionRecord(pds, DID, 'pckt', SITE_URI, RKEY, DOCUMENT);

    // A dangling companion is worse than none: it would point pckt at a
    // publication that isn't the user's.
    expect(putCalls(pds).calls).toHaveLength(0);
  });

  it('swallows a failed companion write — the share itself already landed', async () => {
    const pds = fakeClient({
      putRecord: vi.fn(async () => ({
        success: false,
        error: 'scope not granted',
        retryable: false,
      })),
    });

    await expect(
      syncCompanionRecord(pds, DID, 'pckt', SITE_URI, RKEY, DOCUMENT)
    ).resolves.toBeUndefined();
  });
});

describe('syncCompanionRecord — Offprint', () => {
  it('writes a bare strongRef companion, with no publication lookup', async () => {
    const pds = fakeClient();
    await syncCompanionRecord(pds, DID, 'offprint', SITE_URI, RKEY, DOCUMENT);

    const [collection, rkey, record] = putCalls(pds).calls[0];
    expect(collection).toBe(OFFPRINT_ARTICLE_COLLECTION);
    expect(rkey).toBe(RKEY);
    expect(record).toEqual({
      $type: OFFPRINT_ARTICLE_COLLECTION,
      // Offprint spells out the strongRef's own $type; the publication is left to
      // the document's `site`, so nothing needs resolving first.
      document: {
        $type: 'com.atproto.repo.strongRef',
        uri: DOCUMENT.uri,
        cid: DOCUMENT.cid,
      },
    });
    expect((pds.getRecord as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});

describe('syncCompanionRecord — formats without a companion', () => {
  it.each(['leaflet', 'markpub'] as const)('writes nothing for %s', async (format) => {
    const pds = fakeClient();
    await syncCompanionRecord(pds, DID, format, SITE_URI, RKEY, DOCUMENT);
    expect(putCalls(pds).calls).toHaveLength(0);
  });
});
