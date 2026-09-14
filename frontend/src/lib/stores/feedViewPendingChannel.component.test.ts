// Named `.component.test.ts` so it runs in the project that compiles runes —
// feedView is a `.svelte.ts` module and its derivations need the Svelte plugin.
//
// A channel link is read out of the URL before the channel store has hydrated
// from Dexie (and long before the backend sync supplies a channel created on
// another device). The lookup missed, the toolbar reset to "all sources", and
// nothing ever re-ran it — so a saved filter looked like it had never saved.
// Worse, once the channel did hydrate the toolbar disagreed with it, Update lit
// up, and one click wrote the reset state over the user's filter.
//
// These pin the recovery: the miss is remembered, applied when the channel
// arrives, reported as "no unsaved changes" while it is waiting, and abandoned
// if the user edits the toolbar themselves in the meantime.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilteredView } from '$lib/types';
import { channels, resetChannels } from '../../../test/stubs/pending-channel-fixtures.svelte';

vi.mock('./filteredViews.svelte', () => ({
  filteredViewsStore: {
    get views() {
      return channels.list;
    },
    getById: (id: number) => channels.list.find((v) => v.id === id),
    getByUuid: (uuid: string) => channels.list.find((v) => v.uuid === uuid),
    update: (id: number, changes: Partial<FilteredView>) => {
      channels.updates = [...channels.updates, { id, changes }];
    },
  },
}));

vi.mock('./articles.svelte', () => ({ articlesStore: { allArticles: [] } }));
vi.mock('./social.svelte', () => ({ socialStore: { documents: [], isLoading: false } }));
vi.mock('./myLinkblog.svelte', () => ({ myLinkblogStore: { documents: [] } }));
vi.mock('./saves.svelte', () => ({
  savesStore: {
    articles: [],
    find: () => undefined,
    getByGuid: () => undefined,
    getByUrl: () => undefined,
  },
}));
vi.mock('./subscriptions.svelte', () => ({
  subscriptionsStore: { subscriptions: [], getById: () => undefined, getByRkey: () => undefined },
}));
vi.mock('./itemLabels.svelte', () => ({
  itemLabelsStore: {
    isSaved: () => false,
    isArchived: () => false,
    isRead: () => false,
    isSocialRead: () => false,
    itemHasAnyTag: () => true,
    get tagsByItem() {
      return {};
    },
    markAsRead: () => {},
    markSocialAsRead: () => {},
  },
}));
vi.mock('./savedSearch.svelte', () => ({
  savedSearchStore: {
    terms: [],
    bodyMatchTerms: [],
    active: false,
    reset: () => {},
    setSurfaceActive: () => {},
  },
}));
vi.mock('./preferences.svelte', () => ({
  preferences: { sortOrder: 'newest', toggleSortOrder: () => {} },
}));
vi.mock('$lib/services/liveDb.svelte', () => ({
  liveDb: { articlesVersion: 0, getArticleBodies: async () => new Map() },
}));

const { feedViewStore } = await import('./feedView.svelte');

const CHANNEL_UUID = 'e6e2c0f4-0000-4000-8000-000000000001';

function excludeChannel(overrides: Partial<FilteredView> = {}): FilteredView {
  return {
    id: 7,
    uuid: CHANNEL_UUID,
    name: 'Quiet Feeds',
    position: 0,
    createdAt: 1,
    updatedAt: 1,
    mode: 'feed',
    sourceMode: 'exclude',
    sourceKeys: ['rss~3knoisyfeedaaa'],
    readFilter: 'unread',
    sortOrder: 'newest',
    ...overrides,
  } as FilteredView;
}

/** The cold-load sequence: URL read while the channel store is still empty. */
function enterChannelBeforeHydration(view = CHANNEL_UUID) {
  feedViewStore.setFilters({
    feed: null,
    saved: null,
    sharer: null,
    following: null,
    feeds: null,
    view,
  });
}

describe('a channel link read before the channel store has hydrated', () => {
  beforeEach(() => {
    resetChannels();
    // Leave the previous case's channel — otherwise `setFilters` sees an
    // unchanged filter set and no-ops (the `?read=` contract's early return).
    feedViewStore.setFilters({
      feed: null,
      saved: null,
      sharer: null,
      following: null,
      feeds: null,
    });
  });

  it('applies the channel config once the store hydrates', () => {
    enterChannelBeforeHydration();

    // The miss shows honest defaults rather than a filter it can't prove.
    expect(feedViewStore.effectiveFilters.sourceMode).toBe('all');

    channels.list = [excludeChannel()];
    feedViewStore.applyPendingViewConfig();

    expect(feedViewStore.effectiveFilters.sourceMode).toBe('exclude');
    expect(feedViewStore.effectiveFilters.sourceKeys).toEqual(['rss~3knoisyfeedaaa']);
  });

  it('reports no unsaved changes while the channel is unresolved', () => {
    enterChannelBeforeHydration();

    // The channel arrives, so `activeFilteredView` resolves — but the toolbar
    // still says "all sources". This is the window in which Update used to be
    // enabled, and clicking it overwrote the saved filter with the reset state.
    channels.list = [excludeChannel()];
    expect(feedViewStore.hasUnsavedChanges).toBe(false);

    // A write attempted in that window is refused outright.
    feedViewStore.syncToolbarToSavedView();
    expect(channels.updates).toEqual([]);

    feedViewStore.applyPendingViewConfig();
    expect(feedViewStore.hasUnsavedChanges).toBe(false);
  });

  it('re-enables Update once the user actually changes something', () => {
    enterChannelBeforeHydration();
    channels.list = [excludeChannel()];
    feedViewStore.applyPendingViewConfig();

    feedViewStore.toggleToolbarSourceKey('rss~3kotherfeedaaa');

    expect(feedViewStore.hasUnsavedChanges).toBe(true);
  });

  it("keeps the user's own edit when the channel lands late", () => {
    enterChannelBeforeHydration();

    // The cross-device window is seconds long, so a gesture can beat the sync.
    feedViewStore.setToolbarSourceFilter('include', ['rss~3kchosenfeedaa']);
    channels.list = [excludeChannel()];
    feedViewStore.applyPendingViewConfig();

    expect(feedViewStore.effectiveFilters.sourceMode).toBe('include');
    expect(feedViewStore.effectiveFilters.sourceKeys).toEqual(['rss~3kchosenfeedaa']);
  });

  it('resolves a legacy numeric `?view=` bookmark the same way', () => {
    enterChannelBeforeHydration('7');

    channels.list = [excludeChannel()];
    feedViewStore.applyPendingViewConfig();

    expect(feedViewStore.effectiveFilters.sourceMode).toBe('exclude');
  });

  it('is a no-op when nothing is pending', () => {
    channels.list = [excludeChannel()];
    enterChannelBeforeHydration();
    expect(feedViewStore.effectiveFilters.sourceMode).toBe('exclude');

    feedViewStore.setToolbarSourceFilter('all', []);
    feedViewStore.applyPendingViewConfig();

    // The channel was found on the first pass, so there is nothing to re-apply
    // and the (now genuinely unsaved) toolbar edit stands.
    expect(feedViewStore.effectiveFilters.sourceMode).toBe('all');
    expect(feedViewStore.hasUnsavedChanges).toBe(true);
  });
});
