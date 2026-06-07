import { describe, it, expect } from 'vitest';
import { toUnifiedReadItem } from './readSync';
import type { SocialReadingPayload } from './sync-queue';

function payload(overrides: Partial<SocialReadingPayload> = {}): SocialReadingPayload {
  return {
    type: 'document',
    rkey: 'rk-1',
    itemUri: 'at://did:plc:author/app.skyreader/doc1',
    authorDid: 'did:plc:author',
    itemUrl: 'https://example.com/doc1',
    itemTitle: 'Doc One',
    ...overrides,
  };
}

describe('toUnifiedReadItem', () => {
  it('maps a queued document read onto the unified read-writer shape', () => {
    expect(toUnifiedReadItem(payload())).toEqual({
      itemGuid: 'at://did:plc:author/app.skyreader/doc1',
      itemType: 'document',
      rkey: 'rk-1',
      authorDid: 'did:plc:author',
      itemUrl: 'https://example.com/doc1',
      itemTitle: 'Doc One',
    });
  });

  it('keys the read by itemUri (item_key on the unified table), not rkey', () => {
    const item = toUnifiedReadItem(payload({ itemUri: 'at://x', rkey: 'rk-x' }));
    expect(item.itemGuid).toBe('at://x');
  });

  it('forwards http and https urls', () => {
    expect(toUnifiedReadItem(payload({ itemUrl: 'http://a.test' })).itemUrl).toBe('http://a.test');
    expect(toUnifiedReadItem(payload({ itemUrl: 'https://a.test' })).itemUrl).toBe(
      'https://a.test'
    );
  });

  // The URL guard: a non-http(s) value (e.g. an at:// uri leaking into itemUrl)
  // or empty string must not be forwarded as a read url.
  it('drops a non-http(s) or empty itemUrl', () => {
    expect(
      toUnifiedReadItem(payload({ itemUrl: 'at://did:plc:author/doc' })).itemUrl
    ).toBeUndefined();
    expect(toUnifiedReadItem(payload({ itemUrl: '' })).itemUrl).toBeUndefined();
    expect(toUnifiedReadItem(payload({ itemUrl: undefined })).itemUrl).toBeUndefined();
  });

  it('collapses an empty title to undefined', () => {
    expect(toUnifiedReadItem(payload({ itemTitle: '' })).itemTitle).toBeUndefined();
    expect(toUnifiedReadItem(payload({ itemTitle: undefined })).itemTitle).toBeUndefined();
  });
});
