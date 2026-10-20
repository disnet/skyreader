import { describe, it, expect } from 'vitest';
import type { FilteredView, SavedItem } from '$lib/types';
import { foldSavedChannel, isSavesChannel, savedItemArticle } from './savesChannel';
import { CHANNEL_FILTER_VERSION } from './sourceFilter';

function view(overrides: Partial<FilteredView>): FilteredView {
  return {
    uuid: 'u1',
    name: 'Channel',
    readFilter: 'unread',
    sortOrder: 'newest',
    createdAt: 0,
    updatedAt: 0,
    position: 0,
    ...overrides,
  };
}

describe('isSavesChannel', () => {
  it('is a channel whose only source is your saves', () => {
    const saves = {
      sourceMode: 'include' as const,
      sourceKeys: [],
      librarySources: ['saves' as const],
    };
    expect(isSavesChannel(view(saves))).toBe(true);
    expect(isSavesChannel(view({ ...saves, librarySources: ['saves', 'shelf'] }))).toBe(true);
    expect(isSavesChannel(view({ mode: 'saved' }))).toBe(true);
  });

  it('is not one with feeds, a search, a rule, or only the Shelf', () => {
    const saves = {
      sourceMode: 'include' as const,
      sourceKeys: [],
      librarySources: ['saves' as const],
    };
    expect(isSavesChannel(view({ ...saves, sourceKeys: ['rss~abc'] }))).toBe(false);
    expect(isSavesChannel(view({ ...saves, sourceMode: 'all' }))).toBe(false);
    expect(isSavesChannel(view({ ...saves, query: 'heat pump' }))).toBe(false);
    expect(isSavesChannel(view({ ...saves, librarySources: ['shelf'] }))).toBe(false);
    expect(
      isSavesChannel(view({ ...saves, autoRule: { type: 'frequency', threshold: 'high' } }))
    ).toBe(false);
    expect(isSavesChannel(null)).toBe(false);
  });
});

describe('foldSavedChannel', () => {
  it('turns a Saved channel into one of your saves, keeping its filters', () => {
    const old = view({
      mode: 'saved',
      readFilter: 'read',
      sortOrder: 'longest',
      savedSourceFilter: ['feed'],
      savedDateFilter: 'last-month',
      savedReadingLength: ['long'],
      savedDomainFilter: ['example.com'],
      tagFilter: ['later'],
    });
    const folded = { ...old, ...foldSavedChannel(old) };
    expect(folded).toMatchObject({
      mode: 'feed',
      sourceMode: 'include',
      sourceKeys: [],
      librarySources: ['saves'],
      filterVersion: CHANNEL_FILTER_VERSION,
      readFilter: 'read',
      sortOrder: 'longest',
      savedSourceFilter: ['feed'],
      savedDateFilter: 'last-month',
      savedReadingLength: ['long'],
      savedDomainFilter: ['example.com'],
      tagFilter: ['later'],
    });
    expect(isSavesChannel(folded)).toBe(true);
  });

  it('leaves every other channel alone', () => {
    expect(foldSavedChannel(view({ mode: 'feed' }))).toBeNull();
    expect(foldSavedChannel(view({}))).toBeNull();
  });
});

describe('savedItemArticle', () => {
  const save: SavedItem = {
    rkey: 'r1',
    uri: 'at://did:plc:me/app.skyreader.feed.saved/r1',
    url: 'https://example.com/a',
    title: null,
    author: 'Ann',
    description: 'A plain guide',
    content: null,
    contentType: 'webpage',
    domain: 'example.com',
    image: null,
    wordCount: 1200,
    publishedAt: '2026-01-01T00:00:00.000Z',
    savedAt: '2026-10-19T12:00:00.000Z',
  };

  it('keys the card by the row key and dates it by when it was saved', () => {
    const article = savedItemArticle(save, save.uri);
    expect(article.guid).toBe(save.uri);
    expect(article.publishedAt).toBe(save.savedAt);
    expect(article.subscriptionId).toBe(-1);
    expect(article.summary).toBe('A plain guide');
    expect(article.content).toBeUndefined();
  });

  it('falls back to the URL for an untitled save', () => {
    expect(savedItemArticle(save, save.uri).title).toBe(save.url);
  });
});
