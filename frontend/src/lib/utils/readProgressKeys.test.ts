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

  it('keeps a feed article to its own key, since its body is not the save’s', () => {
    const item = {
      type: 'article',
      item: { guid: 'guid-1', url: 'https://example.com/post' },
      key: 'guid-1',
    } as FeedDisplayItem;
    expect(readProgressKeys(item, () => save)).toEqual(['guid-1']);
  });

  it('is just the document’s own key', () => {
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
