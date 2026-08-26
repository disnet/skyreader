import { describe, it, expect } from 'vitest';
import { readerUrl, resolveReaderItem, fetchReaderDocument } from './readerLink';
import type { Article, SavedItem, SocialDocument } from '$lib/types';

function save(partial: Partial<SavedItem>): SavedItem {
  return {
    rkey: '3kaaaaaaaaaaa',
    uri: 'at://did:plc:me/app.skyreader.feed.saved/3kaaaaaaaaaaa',
    url: 'https://example.com/piece',
    title: 'A Piece',
    author: null,
    description: null,
    content: null,
    contentType: 'article',
    domain: 'example.com',
    image: null,
    wordCount: null,
    publishedAt: null,
    savedAt: '2026-08-01T00:00:00.000Z',
    ...partial,
  };
}

function article(partial: Partial<Article> = {}): Article {
  return {
    guid: 'https://example.com/feed-item',
    subscriptionId: 1,
    title: 'A Feed Item',
    url: 'https://example.com/feed-item',
    publishedAt: '2026-08-01T00:00:00.000Z',
    ...partial,
  } as Article;
}

function doc(partial: Partial<SocialDocument> = {}): SocialDocument {
  return {
    authorDid: 'did:plc:author',
    recordUri: 'at://did:plc:author/com.example.doc/abc',
    siteUri: 'at://did:plc:author/com.example.site/self',
    title: 'A Document',
    publishedAt: '2026-08-01T00:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
    ...partial,
  };
}

const empty = { saves: [], getArticle: () => undefined, documents: [] };

describe('readerUrl', () => {
  it('adds read to the current path and query', () => {
    const url = new URL('https://app.test/feeds?feed=12&view=abc');
    expect(readerUrl(url, 'https://example.com/a?b=c')).toBe(
      '/feeds?feed=12&view=abc&read=https%3A%2F%2Fexample.com%2Fa%3Fb%3Dc'
    );
  });

  it('replaces an existing read rather than appending a second one', () => {
    const url = new URL('https://app.test/saved?read=one');
    expect(readerUrl(url, 'two')).toBe('/saved?read=two');
  });

  it('removes read for null, leaving the other params intact', () => {
    const url = new URL('https://app.test/feeds?feed=12&read=one');
    expect(readerUrl(url, null)).toBe('/feeds?feed=12');
  });

  it('keeps a bare path bare on close', () => {
    expect(readerUrl(new URL('https://app.test/saved?read=one'), null)).toBe('/saved');
  });
});

describe('resolveReaderItem', () => {
  it('matches a save by any of its keys and re-keys it to the current one', () => {
    const item = save({ itemGuid: 'guid-1' });
    const sources = { ...empty, saves: [item] };

    for (const key of [item.uri, 'guid-1', item.rkey]) {
      const resolved = resolveReaderItem(key, sources);
      expect(resolved).toEqual({ type: 'saved', item, key: item.uri });
    }
  });

  it('falls back to itemGuid when a save has no uri yet', () => {
    const item = save({ uri: '', itemGuid: 'guid-1' });
    expect(resolveReaderItem('guid-1', { ...empty, saves: [item] })).toEqual({
      type: 'saved',
      item,
      key: 'guid-1',
    });
  });

  it('prefers a save over a feed article with the same key', () => {
    const saved = save({ itemGuid: 'https://example.com/feed-item' });
    const feedItem = article();
    const resolved = resolveReaderItem('https://example.com/feed-item', {
      saves: [saved],
      getArticle: () => feedItem,
      documents: [],
    });
    expect(resolved?.type).toBe('saved');
  });

  it('resolves a feed article by guid', () => {
    const feedItem = article();
    const resolved = resolveReaderItem(feedItem.guid, {
      ...empty,
      getArticle: (guid) => (guid === feedItem.guid ? feedItem : undefined),
    });
    expect(resolved).toEqual({ type: 'article', item: feedItem, key: feedItem.guid });
  });

  it('resolves a loaded document by record uri', () => {
    const document = doc();
    const resolved = resolveReaderItem(document.recordUri, { ...empty, documents: [document] });
    expect(resolved).toEqual({ type: 'document', item: document, key: document.recordUri });
  });

  it('returns null for a key nothing knows', () => {
    expect(resolveReaderItem('https://example.com/never-seen', empty)).toBeNull();
  });
});

describe('fetchReaderDocument', () => {
  it('fetches an at:// key that no store had', async () => {
    const document = doc();
    const resolved = await fetchReaderDocument(document.recordUri, async () => document);
    expect(resolved).toEqual({ type: 'document', item: document, key: document.recordUri });
  });

  it('does not go to the network for a non-at:// key', async () => {
    let called = false;
    const resolved = await fetchReaderDocument('https://example.com/a', async () => {
      called = true;
      return doc();
    });
    expect(resolved).toBeNull();
    expect(called).toBe(false);
  });

  it('treats a missing document as unresolved', async () => {
    expect(await fetchReaderDocument('at://did:plc:x/c/1', async () => null)).toBeNull();
  });

  it('treats a failed fetch as unresolved rather than throwing', async () => {
    const resolved = await fetchReaderDocument('at://did:plc:x/c/1', async () => {
      throw new Error('offline');
    });
    expect(resolved).toBeNull();
  });
});
