import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCurrentsSaveRecord } from '../src/routes/integrations';
import { fetchImageForCurrents, ImageFetchError } from '../src/services/image-fetch';
import type { BlobRef } from '../src/services/pds-client';

const blob: BlobRef = {
  $type: 'blob',
  ref: { $link: 'bafkreitest' },
  mimeType: 'image/png',
  size: 8,
};

describe('Currents save records', () => {
  it('builds the third-party record shape and trims its caption', () => {
    expect(
      buildCurrentsSaveRecord(
        {
          pageUrl: 'https://example.com/article',
          caption: '  A calm image  ',
          collection: { uri: 'at://did:plc:test/is.currents.feed.collection/one', cid: 'cid' },
        },
        blob,
        '2026-09-02T00:00:00.000Z'
      )
    ).toEqual({
      $type: 'is.currents.feed.save',
      content: blob,
      createdAt: '2026-09-02T00:00:00.000Z',
      originUrl: 'https://example.com/article',
      text: 'A calm image',
      collection: { uri: 'at://did:plc:test/is.currents.feed.collection/one', cid: 'cid' },
    });
  });

  it('omits optional fields', () => {
    expect(buildCurrentsSaveRecord({}, blob, 'now')).toEqual({
      $type: 'is.currents.feed.save',
      content: blob,
      createdAt: 'now',
    });
  });
});

describe('Currents image fetching', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['http://localhost/image.png', 'http://127.0.0.1/image.png', 'ftp://example.com/a.png'])(
    'blocks unsafe address %s',
    async (url) => {
      await expect(fetchImageForCurrents(url)).rejects.toMatchObject<ImageFetchError>({
        code: 'blocked',
      });
    }
  );

  it('sniffs a PNG served as octet-stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
          headers: { 'content-type': 'application/octet-stream' },
        })
      )
    );
    const result = await fetchImageForCurrents('https://images.example/a');
    expect(result.contentType).toBe('image/png');
  });
});
