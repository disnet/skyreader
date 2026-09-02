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
  it('wraps the blob in the typed image content and trims its text', () => {
    expect(
      buildCurrentsSaveRecord(
        {
          pageUrl: 'https://example.com/article',
          alt: '  A calm image  ',
          note: '  Worth revisiting  ',
          collection: { uri: 'at://did:plc:test/is.currents.feed.collection/one', cid: 'cid' },
        },
        blob,
        '2026-09-02T00:00:00.000Z'
      )
    ).toEqual({
      $type: 'is.currents.feed.save',
      content: { $type: 'is.currents.content.image', image: blob, alt: 'A calm image' },
      createdAt: '2026-09-02T00:00:00.000Z',
      originUrl: 'https://example.com/article',
      text: 'Worth revisiting',
      collection: { uri: 'at://did:plc:test/is.currents.feed.collection/one', cid: 'cid' },
    });
  });

  it('omits optional fields', () => {
    expect(buildCurrentsSaveRecord({}, blob, 'now')).toEqual({
      $type: 'is.currents.feed.save',
      content: { $type: 'is.currents.content.image', image: blob },
      createdAt: 'now',
    });
  });

  it('caps alt and text at the lexicon graphemes limits', () => {
    const record = buildCurrentsSaveRecord(
      { alt: 'a'.repeat(2500), note: 'n'.repeat(1200) },
      blob,
      'now'
    );
    expect(record.content.alt).toHaveLength(2000);
    expect(record.text).toHaveLength(1000);
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
