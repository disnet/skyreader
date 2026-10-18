import { describe, it, expect } from 'vitest';
import {
  canUseSavedSearches,
  channelQuery,
  classifyChannelItemsError,
  hasSearchableTerm,
  matchToRow,
  searchChannelUnread,
} from './searchChannels';
import { ApiError, OfflineError, type ChannelMatch } from '$lib/services/api';
import type { SocialDocument, User } from '$lib/types';

const base = {
  itemKey: 'guid-1',
  publishedAt: Date.UTC(2026, 9, 1),
  matchedAt: Date.UTC(2026, 9, 1),
  read: false,
  snippet: [{ text: 'heat', match: true }],
  sharedBy: [],
  sharedByCount: 0,
};

function feedMatch(partial: Partial<ChannelMatch> = {}): ChannelMatch {
  return {
    ...base,
    kind: 'feed',
    item: {
      guid: 'guid-1',
      url: 'https://a.example/1',
      title: 'One',
      publishedAt: '2026-10-01T00:00:00.000Z',
      feedUrl: 'https://a.example/feed',
      seq: 7,
    },
    ...partial,
  } as ChannelMatch;
}

describe('canUseSavedSearches', () => {
  const user = { did: 'did:plc:a', handle: 'a', pdsUrl: '' } as User;

  it('needs both the switch and a plan with some', () => {
    expect(canUseSavedSearches(null)).toBe(false);
    expect(canUseSavedSearches({ ...user, savedSearchEnabled: true })).toBe(false);
    expect(
      canUseSavedSearches({
        ...user,
        savedSearchEnabled: false,
        limits: { maxSavedSearches: 25 } as User['limits'],
      })
    ).toBe(false);
    expect(
      canUseSavedSearches({
        ...user,
        savedSearchEnabled: true,
        limits: { maxSavedSearches: 25 } as User['limits'],
      })
    ).toBe(true);
  });
});

describe('channelQuery', () => {
  it('is the trimmed query of a feed channel', () => {
    expect(channelQuery({ mode: 'feed', query: '  heat pump ' })).toBe('heat pump');
    expect(channelQuery({ query: 'x' })).toBe('x');
  });

  it('is null for no query, a blank one, or a saved-articles channel', () => {
    expect(channelQuery({ mode: 'feed' })).toBeNull();
    expect(channelQuery({ mode: 'feed', query: '   ' })).toBeNull();
    expect(channelQuery({ mode: 'saved', query: 'heat' })).toBeNull();
    expect(channelQuery(null)).toBeNull();
  });
});

describe('hasSearchableTerm', () => {
  it('wants a word or phrase that is not an exclusion', () => {
    expect(hasSearchableTerm('heat pump')).toBe(true);
    expect(hasSearchableTerm('"heat pump" -podcast')).toBe(true);
    expect(hasSearchableTerm('-podcast')).toBe(false);
    expect(hasSearchableTerm('-"a phrase"')).toBe(false);
    expect(hasSearchableTerm('""')).toBe(false);
    expect(hasSearchableTerm('— …')).toBe(false);
  });
});

describe('classifyChannelItemsError', () => {
  it('reads the endpoint’s answers', () => {
    expect(classifyChannelItemsError(new OfflineError())).toBe('offline');
    expect(classifyChannelItemsError(new ApiError('x', 403, 'upgrade_required'))).toBe('upgrade');
    expect(classifyChannelItemsError(new ApiError('x', 404, 'not_saved_search'))).toBe('not_ready');
    expect(classifyChannelItemsError(new ApiError('Not found', 404))).toBe('off');
    expect(classifyChannelItemsError(new ApiError('boom', 500))).toBe('failed');
    expect(classifyChannelItemsError(new Error('?'))).toBe('failed');
  });
});

describe('matchToRow', () => {
  const ctx = {
    subscriptionIdFor: (url: string) => (url === 'https://a.example/feed' ? 3 : undefined),
  };

  it('files a feed match under its guid and local subscription', () => {
    const row = matchToRow(feedMatch(), ctx);
    expect(row?.type).toBe('article');
    expect(row?.key).toBe('guid-1');
    expect(row?.type === 'article' && row.item.subscriptionId).toBe(3);
  });

  it('drops a feed match from a feed the reader has left', () => {
    const match = feedMatch();
    if (match.kind === 'feed') match.item.feedUrl = 'https://gone.example/feed';
    expect(matchToRow(match, ctx)).toBeNull();
  });

  it('prefers this device’s copy of a document', () => {
    const local = { recordUri: 'at://d/doc/1', title: 'Local' } as SocialDocument;
    const match = {
      ...base,
      itemKey: 'at://d/doc/1',
      kind: 'document',
      document: {
        uri: 'at://d/doc/1',
        authorDid: 'did:plc:d',
        siteUri: 'at://d/site',
        url: 'https://d.example/1',
        title: 'Served',
        description: '',
      },
    } as ChannelMatch;
    expect(matchToRow(match, { ...ctx, localDocument: () => local })?.item).toBe(local);
    const served = matchToRow(match, ctx);
    expect(served?.type === 'document' && served.item.title).toBe('Served');
    expect(served?.type === 'document' && served.item.canonicalUrl).toBe('https://d.example/1');
  });

  it('turns a follows match into a link keyed by its normalized URL, with its sharers', () => {
    const match = {
      ...base,
      itemKey: 'https://b.example/post',
      kind: 'follows',
      sharedBy: [
        { did: 'did:plc:m', postUri: 'at://m/p/1', handle: 'm', name: 'Maya', avatar: null },
      ],
      sharedByCount: 3,
      link: {
        url: 'https://www.b.example/post/',
        urlNormalized: 'https://b.example/post',
        title: 'Post',
      },
    } as ChannelMatch;
    const row = matchToRow(match, ctx);
    expect(row?.type).toBe('link');
    expect(row?.key).toBe('https://b.example/post');
    if (row?.type !== 'link') return;
    expect(row.item.site).toBe('b.example');
    expect(row.item.sharerCount).toBe(3);
    expect(row.item.sharers[0].name).toBe('Maya');
  });
});

describe('searchChannelUnread', () => {
  it('corrects the served count for what has been read or unread here since', () => {
    const served = [
      feedMatch({ itemKey: 'a', read: false }),
      feedMatch({ itemKey: 'b', read: false }),
      feedMatch({ itemKey: 'c', read: true }),
    ];
    const readNow = new Set(['a', 'c']);
    expect(searchChannelUnread(5, served, (m) => readNow.has(m.itemKey))).toBe(4);
    readNow.delete('c');
    expect(searchChannelUnread(5, served, (m) => readNow.has(m.itemKey))).toBe(5);
    expect(searchChannelUnread(0, served, () => true)).toBe(0);
  });
});
