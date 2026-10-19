import { describe, expect, it } from 'vitest';
import { readProgressKeys } from './readProgressKeys';
import type { FeedDisplayItem } from '$lib/stores/feedView.svelte';
import type { SavedItem } from '$lib/types';

const save = {
  uri: 'at://did:plc:me/app.skyreader.feed.saved/3k',
  itemGuid: 'guid-1',
  url: 'https://example.com/post',
  rkey: '3k',
} as SavedItem;

describe('readProgressKeys', () => {
  it('covers every identity of a save, including the live row’s new uri', () => {
    // Opened right after saving: the reader's copy has no uri yet.
    const pending = { ...save, uri: '' };
    const item: FeedDisplayItem = { type: 'saved', item: pending, key: 'guid-1' };
    const keys = readProgressKeys(item, (k) => (k === 'guid-1' ? save : undefined));
    expect(keys).toEqual(expect.arrayContaining(['guid-1', save.uri, save.url, save.rkey]));
    expect(keys[0]).toBe('guid-1');
  });

  it('reaches the save behind a feed article', () => {
    const item = {
      type: 'article',
      item: { guid: 'guid-1', url: 'https://example.com/post' },
      key: 'guid-1',
    } as FeedDisplayItem;
    const keys = readProgressKeys(item, (k) =>
      k === 'https://example.com/post' ? save : undefined
    );
    expect(keys).toEqual(expect.arrayContaining(['guid-1', save.url, save.uri]));
  });

  it('is just the item’s own keys when nothing is saved', () => {
    const item = {
      type: 'document',
      item: { recordUri: 'at://did:plc:a/site.standard.document/1' },
      key: 'at://did:plc:a/site.standard.document/1',
    } as FeedDisplayItem;
    expect(readProgressKeys(item, () => undefined)).toEqual([
      'at://did:plc:a/site.standard.document/1',
    ]);
  });
});
