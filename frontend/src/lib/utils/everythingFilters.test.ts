// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { isEverythingUrl, loadEverythingFilters, saveEverythingFilters } from './everythingFilters';

const NONE = { feed: null, saved: null, sharer: null, following: null, feeds: null };

describe('everythingFilters', () => {
  beforeEach(() => localStorage.clear());

  it('recognizes the plain Everything URL only', () => {
    expect(isEverythingUrl(NONE)).toBe(true);
    expect(isEverythingUrl({ ...NONE, view: null, category: null, contentType: null })).toBe(true);
    expect(isEverythingUrl({ ...NONE, feed: '3' })).toBe(false);
    expect(isEverythingUrl({ ...NONE, view: 'abc' })).toBe(false);
    expect(isEverythingUrl({ ...NONE, category: 'Tech' })).toBe(false);
    expect(isEverythingUrl({ ...NONE, contentType: 'documents' })).toBe(false);
  });

  it('round-trips for the same owner', () => {
    saveEverythingFilters('did:plc:a', {
      sourceMode: 'exclude',
      sourceKeys: ['rss~3kfeedaaaaaaa'],
      showOnlyUnread: false,
    });
    expect(loadEverythingFilters('did:plc:a')).toEqual({
      sourceMode: 'exclude',
      sourceKeys: ['rss~3kfeedaaaaaaa'],
      showOnlyUnread: false,
    });
  });

  it("ignores another owner's filters, and stores nothing without an owner", () => {
    saveEverythingFilters('did:plc:a', {
      sourceMode: 'include',
      sourceKeys: ['rss~3kfeedaaaaaaa'],
      showOnlyUnread: true,
    });
    expect(loadEverythingFilters('did:plc:b')).toBeNull();
    expect(loadEverythingFilters('guest')).toBeNull();
    expect(loadEverythingFilters(null)).toBeNull();

    localStorage.clear();
    saveEverythingFilters(null, { sourceMode: 'all', sourceKeys: [], showOnlyUnread: false });
    expect(localStorage.length).toBe(0);
  });

  it('ignores a corrupt stored value', () => {
    localStorage.setItem('skyreader-everything-filters', 'not json');
    expect(loadEverythingFilters('did:plc:a')).toBeNull();
    localStorage.setItem(
      'skyreader-everything-filters',
      JSON.stringify({ owner: 'did:plc:a', sourceMode: 'sideways', sourceKeys: [] })
    );
    expect(loadEverythingFilters('did:plc:a')).toBeNull();
    localStorage.setItem(
      'skyreader-everything-filters',
      JSON.stringify({ owner: 'did:plc:a', sourceMode: 'include', sourceKeys: ['ok', 3] })
    );
    expect(loadEverythingFilters('did:plc:a')).toEqual({
      sourceMode: 'include',
      sourceKeys: ['ok'],
      showOnlyUnread: true,
    });
  });
});
