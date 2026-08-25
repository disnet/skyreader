import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { feedViewStore } from './feedView.svelte';
import { savedSearchStore } from './savedSearch.svelte';

const emptyFilters = {
  feed: null,
  saved: null,
  sharer: null,
  following: null,
  feeds: null,
};

afterEach(() => {
  savedSearchStore.releaseSurface('saved');
  savedSearchStore.releaseSurface('home');
  savedSearchStore.reset();
  vi.useRealTimers();
});

describe('feed view saved-search transitions', () => {
  it('preserves a Home query through Saved filter initialization', () => {
    vi.useFakeTimers();
    savedSearchStore.claimSurface('home');
    savedSearchStore.openSearch();
    savedSearchStore.setQuery('needle');
    vi.advanceTimersByTime(150);

    savedSearchStore.beginHandoff();
    savedSearchStore.releaseSurface('home');
    feedViewStore.setFilters({ ...emptyFilters, saved: 'true' });
    savedSearchStore.claimSurface('saved');

    expect(savedSearchStore.query).toBe('needle');
    expect(savedSearchStore.appliedQuery).toBe('needle');
    expect(savedSearchStore.open).toBe(true);
  });

  it('resets search on an ordinary saved-surface change', () => {
    savedSearchStore.claimSurface('saved');
    savedSearchStore.openSearch();
    savedSearchStore.setQuery('stale');

    feedViewStore.setFilters({ ...emptyFilters, saved: 'true', view: 'another-channel' });

    expect(savedSearchStore.query).toBe('');
    expect(savedSearchStore.open).toBe(false);
  });
});
