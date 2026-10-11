import { describe, it, expect } from 'vitest';
import {
  canUseSearch,
  formatResultCount,
  lastTouched,
  resolveSearchHit,
  type SearchHitSources,
} from './search';
import type { SearchHit } from '$lib/services/api';
import type { Article, SavedItem, User } from '$lib/types';

function hit(partial: Partial<SearchHit> = {}): SearchHit {
  return {
    itemKey: 'guid-1',
    itemType: 'article',
    url: 'https://blog.example/post',
    title: 'A post',
    feedTitle: 'Blog',
    feedUrl: 'https://blog.example/feed.xml',
    read: true,
    saved: false,
    highlighted: false,
    readAt: 1_000,
    savedAt: null,
    highlightedAt: null,
    snippet: [],
    ...partial,
  };
}

function sources(partial: Partial<SearchHitSources> = {}): SearchHitSources {
  return {
    saves: [],
    getArticle: () => undefined,
    documents: [],
    subscriptionIdFor: () => undefined,
    ...partial,
  };
}

describe('canUseSearch', () => {
  const base = { did: 'did:plc:x', handle: 'x', pdsUrl: 'https://pds' } as User;

  it('needs both the plan and the operator switch', () => {
    expect(canUseSearch(null)).toBe(false);
    expect(canUseSearch(base)).toBe(false);
    expect(canUseSearch({ ...base, limits: { fullTextSearch: true } as User['limits'] })).toBe(
      false
    );
    expect(canUseSearch({ ...base, searchEnabled: true })).toBe(false);
    expect(
      canUseSearch({
        ...base,
        searchEnabled: true,
        limits: { fullTextSearch: true } as User['limits'],
      })
    ).toBe(true);
  });
});

describe('resolveSearchHit', () => {
  it('prefers the local article', () => {
    const local = { guid: 'guid-1', subscriptionId: 4, title: 'Local' } as Article;
    const item = resolveSearchHit(
      hit(),
      sources({ getArticle: (g) => (g === 'guid-1' ? local : undefined) })
    );
    expect(item).toEqual({ type: 'article', item: local, key: 'guid-1' });
  });

  it('prefers a save over an article with the same guid', () => {
    const save = {
      rkey: '3kaaaaaaaaaaa',
      uri: 'at://did:plc:me/app.skyreader.feed.saved/3kaaaaaaaaaaa',
      itemGuid: 'guid-1',
    } as SavedItem;
    expect(resolveSearchHit(hit(), sources({ saves: [save] }))?.type).toBe('saved');
  });

  it('builds a truncated stub for an aged-out article of a followed feed', () => {
    const item = resolveSearchHit(
      hit(),
      sources({
        subscriptionIdFor: (url) => (url === 'https://blog.example/feed.xml' ? 7 : undefined),
      }),
      42
    );
    expect(item).toEqual({
      type: 'article',
      key: 'guid-1',
      item: {
        subscriptionId: 7,
        guid: 'guid-1',
        url: 'https://blog.example/post',
        title: 'A post',
        publishedAt: '',
        fetchedAt: 42,
        contentTruncated: true,
      },
    });
  });

  it('gives up on an item from a feed the reader left, or a document not loaded here', () => {
    expect(resolveSearchHit(hit(), sources())).toBeNull();
    expect(
      resolveSearchHit(
        hit({ itemType: 'document', itemKey: 'at://did:plc:a/site.standard.document/x' }),
        sources({ subscriptionIdFor: () => 1 })
      )
    ).toBeNull();
  });
});

describe('formatResultCount', () => {
  it('pluralizes and marks a capped count', () => {
    expect(formatResultCount(1, false)).toBe('1 result');
    expect(formatResultCount(3, false)).toBe('3 results');
    expect(formatResultCount(1000, true)).toBe('1,000+ results');
  });
});

describe('lastTouched', () => {
  it('picks the most recent of read, saved and highlighted', () => {
    expect(lastTouched(hit({ readAt: 10, savedAt: 30, highlightedAt: 20 }))).toEqual({
      verb: 'Saved',
      at: 30,
    });
    expect(lastTouched(hit({ readAt: null }))).toBeNull();
  });
});
