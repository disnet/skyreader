import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDocumentApplyContext,
  createQueryLedger,
  inflateLeafletBlobPages,
  MAX_INFLATED_DOCUMENT_BYTES,
} from '../src/services/document-store';

const AUTHOR = 'did:plc:leafletauthor';

function record() {
  return {
    $type: 'site.standard.document',
    content: {
      $type: 'pub.leaflet.content',
      pages: [],
      blobPages: { ref: { $link: 'bafkreipages' } },
    },
  };
}

const DID_DOCUMENT = JSON.stringify({
  service: [
    {
      id: '#atproto_pds',
      type: 'AtprotoPersonalDataServer',
      serviceEndpoint: 'https://pds.example',
    },
  ],
});

/** A PDS serving the DID document and `pages` as the offloaded blob. */
function mockPds(pages: unknown[]) {
  const fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('getBlob')) return new Response(JSON.stringify(pages));
    return new Response(DID_DOCUMENT);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe('inflateLeafletBlobPages', () => {
  it('resolves the author PDS and replaces the blob stub with pages', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            service: [
              {
                id: '#atproto_pds',
                type: 'AtprotoPersonalDataServer',
                serviceEndpoint: 'https://pds.example',
              },
            ],
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              $type: 'pub.leaflet.pages.linearDocument',
              blocks: [{ block: { $type: 'pub.leaflet.blocks.text', plaintext: 'Full body' } }],
            },
          ])
        )
      );
    vi.stubGlobal('fetch', fetch);

    const inflated = await inflateLeafletBlobPages(record(), AUTHOR);
    const content = inflated.content as Record<string, unknown>;
    expect(content.pages).toHaveLength(1);
    expect(content).not.toHaveProperty('blobPages');
    expect(fetch.mock.calls[1][0]).toContain('com.atproto.sync.getBlob');
  });

  it('keeps the original stub when fetching fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const original = record();
    expect(await inflateLeafletBlobPages(original, AUTHOR)).toBe(original);
  });

  // The author's DID document is an uncached plc.directory fetch, so resolving it per
  // record is how a hundred-document back catalogue quietly spent a hundred
  // subrequests nothing had budgeted.
  it('resolves the author once per run and charges what it spends', async () => {
    const fetch = mockPds([{ $type: 'pub.leaflet.pages.linearDocument', blocks: [] }]);
    const ctx = createDocumentApplyContext(createQueryLedger());

    await inflateLeafletBlobPages(record(), AUTHOR, ctx);
    // The DID document and the blob.
    expect(ctx.ledger.spent).toBe(2);

    await inflateLeafletBlobPages(record(), AUTHOR, ctx);
    // The second record pays for its blob alone.
    expect(ctx.ledger.spent).toBe(3);
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('plc.directory'))).toHaveLength(
      1
    );
  });

  it('stores the stub untouched once the run is out of inflations', async () => {
    const fetch = mockPds([{ $type: 'pub.leaflet.pages.linearDocument', blocks: [] }]);
    const ctx = createDocumentApplyContext(createQueryLedger());
    ctx.blobInflations = 0;

    const original = record();
    expect(await inflateLeafletBlobPages(original, AUTHOR, ctx)).toBe(original);
    expect(fetch).not.toHaveBeenCalled();
    expect(ctx.ledger.spent).toBe(0);
  });

  describe('over the row budget', () => {
    const textBlock = (i: number) => ({
      block: { $type: 'pub.leaflet.blocks.text', plaintext: `${i} ${'x'.repeat(10_000)}` },
    });

    it('keeps a leading prefix and says it is truncated', async () => {
      mockPds([
        { $type: 'pub.leaflet.pages.linearDocument', blocks: [textBlock(0)] },
        {
          $type: 'pub.leaflet.pages.linearDocument',
          blocks: Array.from({ length: 300 }, (_, i) => textBlock(i + 1)),
        },
      ]);

      const inflated = await inflateLeafletBlobPages(record(), AUTHOR);
      const content = inflated.content as {
        truncated?: boolean;
        blobPages?: unknown;
        pages: Array<{ blocks: unknown[] }>;
      };

      expect(content.truncated).toBe(true);
      expect(content.blobPages).toBeUndefined();
      expect(content.pages[0].blocks).toHaveLength(1);
      expect(content.pages[1].blocks.length).toBeGreaterThan(0);
      expect(content.pages[1].blocks.length).toBeLessThan(300);
      expect(new TextEncoder().encode(JSON.stringify(inflated)).length).toBeLessThanOrEqual(
        MAX_INFLATED_DOCUMENT_BYTES
      );
    });

    // A canvas page has no `blocks` array to cut. Skipping it used to leave `kept`
    // empty, which read as "this page didn't fit" and stopped the walk — so one
    // freeform page truncated everything after it.
    it('keeps a page that has no block list instead of stopping there', async () => {
      mockPds([
        { $type: 'pub.leaflet.pages.canvas', id: 'canvas' },
        {
          $type: 'pub.leaflet.pages.linearDocument',
          blocks: Array.from({ length: 300 }, (_, i) => textBlock(i)),
        },
      ]);

      const content = (await inflateLeafletBlobPages(record(), AUTHOR)).content as {
        pages: Array<{ $type: string; blocks?: unknown[] }>;
      };

      expect(content.pages[0].$type).toBe('pub.leaflet.pages.canvas');
      expect(content.pages[1].blocks?.length).toBeGreaterThan(0);
    });
  });
});
