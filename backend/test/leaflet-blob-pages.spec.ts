import { afterEach, describe, expect, it, vi } from 'vitest';
import { inflateLeafletBlobPages } from '../src/services/document-store';

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
});
