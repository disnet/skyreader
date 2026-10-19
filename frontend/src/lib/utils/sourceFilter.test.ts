import { describe, expect, it } from 'vitest';
import type { Subscription } from '$lib/types';
import { FOLLOWS_SOURCE_KEY } from './sourceKeys';
import {
  GROUP_BOOKMARKS,
  GROUP_DOCUMENTS,
  GROUP_FEEDS,
  GROUP_LIKES,
  GROUP_NEWSLETTERS,
  GROUP_PUBLICATIONS,
  CHANNEL_FILTER_VERSION,
  buildSourceGroups,
  categoryGroupKey,
  checkStateOf,
  everySourceFilter,
  expandSourceKeys,
  groupLabel,
  keysOfTypes,
  onlySource,
  setSourceChecked,
  showsNoSource,
  upgradeChannelFilter,
  type PickerContext,
  type SourceFilter,
} from './sourceFilter';

function sub(rkey: string, sourceType: Subscription['sourceType'], feedUrl: string): Subscription {
  return { rkey, sourceType, feedUrl, title: rkey, tags: [] } as unknown as Subscription;
}

const subs = [
  sub('feeda', 'rss', 'https://a.example/feed'),
  sub('feedb', undefined, 'https://b.example/rss'),
  sub('doc1', 'atproto.documents', 'at://did:plc:x/site.standard.publication/1'),
  sub('mail1', 'email.newsletter', 'newsletter:inbox/a@b.com'),
  sub('mail2', 'email.newsletter', 'newsletter:inbox/c@d.com'),
  sub('likes', 'bsky.likes', 'bsky-likes:did:plc:me'),
  sub('bms', 'bsky.bookmarks', 'bsky-bookmarks:did:plc:me'),
];

const groups = buildSourceGroups(subs);
const ctx: PickerContext = { groups, followsInEverything: false };
const ctxFollowsIn: PickerContext = { groups, followsInEverything: true };
const ALL: SourceFilter = { sourceMode: 'all', sourceKeys: [] };

describe('buildSourceGroups', () => {
  it('sorts subscriptions into what the reader sees', () => {
    expect(groups.get(GROUP_PUBLICATIONS)).toEqual(['rss~feeda', 'rss~feedb', 'doc1~documents']);
    expect(groups.get(GROUP_FEEDS)).toEqual(['rss~feeda', 'rss~feedb']);
    expect(groups.get(GROUP_DOCUMENTS)).toEqual(['doc1~documents']);
    expect(groups.get(GROUP_NEWSLETTERS)).toEqual(['rss~mail1', 'rss~mail2']);
    expect(groups.get(GROUP_LIKES)).toEqual(['rss~likes']);
    expect(groups.get(GROUP_BOOKMARKS)).toEqual(['rss~bms']);
  });

  it('expands groups at read time', () => {
    expect(expandSourceKeys([GROUP_NEWSLETTERS, FOLLOWS_SOURCE_KEY], groups)).toEqual([
      'rss~mail1',
      'rss~mail2',
      FOLLOWS_SOURCE_KEY,
    ]);
    const later = buildSourceGroups([...subs, sub('mail3', 'email.newsletter', 'newsletter:i/e')]);
    expect(expandSourceKeys([GROUP_NEWSLETTERS], later)).toContain('rss~mail3');
  });
});

describe('folder groups', () => {
  const filed = (rkey: string, category: string) =>
    ({ ...sub(rkey, 'rss', `https://${rkey}.example/feed`), category }) as Subscription;
  const library = [...subs, filed('tech1', 'Tech'), filed('tech2', ' Tech '), filed('art', 'Art')];
  const folders = buildSourceGroups(library);
  const folderCtx: PickerContext = { groups: folders, followsInEverything: false };

  it('groups publications by folder', () => {
    expect(folders.get(categoryGroupKey('Tech'))).toEqual(['rss~tech1', 'rss~tech2']);
    expect(folders.get(categoryGroupKey('Art'))).toEqual(['rss~art']);
    expect(groupLabel(categoryGroupKey('Tech'))).toBe('Tech');
  });

  it('takes in a feed filed there later', () => {
    const filter = onlySource(categoryGroupKey('Tech'));
    const later = buildSourceGroups([...library, filed('tech3', 'Tech')]);
    expect(expandSourceKeys(filter.sourceKeys, later)).toContain('rss~tech3');
  });

  it("checks a folder's feeds, and splits it when one is unchecked", () => {
    const filter = onlySource(categoryGroupKey('Tech'));
    expect(checkStateOf(filter, 'rss~tech1', folderCtx)).toBe('on');
    const less = setSourceChecked(filter, 'rss~tech1', false, folderCtx);
    expect(less).toEqual({ sourceMode: 'include', sourceKeys: ['rss~tech2'] });
  });

  it('reads a folder that no longer exists as empty', () => {
    expect(expandSourceKeys([categoryGroupKey('Gone')], folders)).toEqual([]);
  });
});

describe('checklist', () => {
  it('Everything checks every source, and follows as the setting says', () => {
    expect(checkStateOf(ALL, 'rss~feeda', ctx)).toBe('on');
    expect(checkStateOf(ALL, FOLLOWS_SOURCE_KEY, ctx)).toBe('off');
    expect(checkStateOf(ALL, FOLLOWS_SOURCE_KEY, ctxFollowsIn)).toBe('on');
  });

  it('unchecking in Everything hides that source and keeps follows out', () => {
    const next = setSourceChecked(ALL, 'rss~feeda', false, ctx);
    expect(next).toEqual({ sourceMode: 'exclude', sourceKeys: [FOLLOWS_SOURCE_KEY, 'rss~feeda'] });
    expect(checkStateOf(next, FOLLOWS_SOURCE_KEY, ctx)).toBe('off');
    expect(checkStateOf(next, GROUP_PUBLICATIONS, ctx)).toBe('some');
  });

  it('checking it again returns to Everything', () => {
    const hidden = setSourceChecked(ALL, 'rss~feeda', false, ctx);
    expect(setSourceChecked(hidden, 'rss~feeda', true, ctx)).toEqual(ALL);
  });

  it('checking follows in Everything adds them without touching the setting', () => {
    const next = setSourceChecked(ALL, FOLLOWS_SOURCE_KEY, true, ctx);
    expect(next).toEqual({ sourceMode: 'exclude', sourceKeys: [] });
    expect(checkStateOf(next, FOLLOWS_SOURCE_KEY, ctx)).toBe('on');
    expect(setSourceChecked(next, FOLLOWS_SOURCE_KEY, false, ctx)).toEqual(ALL);
  });

  it('with follows in Everything, unchecking them excludes them', () => {
    const next = setSourceChecked(ALL, FOLLOWS_SOURCE_KEY, false, ctxFollowsIn);
    expect(next).toEqual({ sourceMode: 'exclude', sourceKeys: [FOLLOWS_SOURCE_KEY] });
    expect(setSourceChecked(next, FOLLOWS_SOURCE_KEY, true, ctxFollowsIn)).toEqual(ALL);
  });

  it('a group excluded by name keeps leaving its new members out', () => {
    const next = setSourceChecked(ALL, GROUP_NEWSLETTERS, false, ctx);
    expect(next.sourceKeys).toContain(GROUP_NEWSLETTERS);
    expect(checkStateOf(next, 'rss~mail1', ctx)).toBe('off');
  });

  it('checking one member of an excluded group splits the group', () => {
    const hidden = setSourceChecked(ALL, GROUP_NEWSLETTERS, false, ctx);
    const next = setSourceChecked(hidden, 'rss~mail1', true, ctx);
    expect(next.sourceKeys).not.toContain(GROUP_NEWSLETTERS);
    expect(next.sourceKeys).toContain('rss~mail2');
    expect(checkStateOf(next, 'rss~mail1', ctx)).toBe('on');
    expect(checkStateOf(next, GROUP_NEWSLETTERS, ctx)).toBe('some');
  });

  it('"only" shows one source or group', () => {
    const only = onlySource(GROUP_LIKES);
    expect(checkStateOf(only, GROUP_LIKES, ctx)).toBe('on');
    expect(checkStateOf(only, 'rss~feeda', ctx)).toBe('off');
    const plus = setSourceChecked(only, FOLLOWS_SOURCE_KEY, true, ctx);
    expect(plus).toEqual({ sourceMode: 'include', sourceKeys: [GROUP_LIKES, FOLLOWS_SOURCE_KEY] });
  });

  it('a group added to an include filter absorbs members already listed', () => {
    const one = onlySource('rss~mail1');
    const next = setSourceChecked(one, GROUP_NEWSLETTERS, true, ctx);
    expect(next.sourceKeys).toEqual([GROUP_NEWSLETTERS]);
  });

  it('a category (a list of sources) toggles together', () => {
    const cat = ['rss~feeda', 'doc1~documents'];
    const next = setSourceChecked(ALL, cat, false, ctx);
    expect(checkStateOf(next, cat, ctx)).toBe('off');
    expect(checkStateOf(next, 'rss~feedb', ctx)).toBe('on');
    // Unchecking the last thing in an include filter leaves nothing.
    expect(setSourceChecked(onlySource(cat), cat, false, ctx)).toEqual({
      sourceMode: 'include',
      sourceKeys: [],
    });
  });

  it('unchecking a feed under an included Publications group keeps the rest', () => {
    const next = setSourceChecked(onlySource(GROUP_PUBLICATIONS), 'rss~feeda', false, ctx);
    expect(next.sourceKeys.sort()).toEqual(['doc1~documents', 'rss~feedb']);
  });
});

describe('upgradeChannelFilter', () => {
  const base = { mode: 'feed' as const };

  it('leaves current channels alone', () => {
    const view = {
      ...base,
      sourceMode: 'exclude' as const,
      sourceKeys: ['rss~feeda'],
      filterVersion: CHANNEL_FILTER_VERSION,
    };
    expect(upgradeChannelFilter(view).sourceKeys).toEqual(['rss~feeda']);
  });

  it('keeps old exclude channels free of follows links', () => {
    const up = upgradeChannelFilter({ ...base, sourceMode: 'exclude', sourceKeys: ['rss~feeda'] });
    expect(up).toEqual({
      sourceMode: 'exclude',
      sourceKeys: ['rss~feeda', FOLLOWS_SOURCE_KEY],
      filterVersion: CHANNEL_FILTER_VERSION,
    });
  });

  it('turns "only newsletters" into an include of the group', () => {
    const up = upgradeChannelFilter({
      ...base,
      sourceMode: 'all',
      typeFilter: ['email.newsletter'],
    });
    expect(up.sourceMode).toBe('include');
    expect(up.sourceKeys).toEqual([GROUP_NEWSLETTERS]);
    expect(up.typeFilter).toBeUndefined();
  });

  it('turns "RSS Feeds" into everything but mail, Bluesky and documents', () => {
    const up = upgradeChannelFilter({ ...base, sourceMode: 'all', typeFilter: ['rss'] });
    const shown = (k: string) => checkStateOf(up, k, ctx);
    expect(up.sourceMode).toBe('exclude');
    expect(shown('rss~feeda')).toBe('on');
    expect(shown('doc1~documents')).toBe('off');
    expect(shown('rss~mail1')).toBe('off');
    expect(shown('rss~likes')).toBe('off');
    expect(shown(FOLLOWS_SOURCE_KEY)).toBe('off');
  });

  it('folds a type filter into an exclude channel', () => {
    const up = upgradeChannelFilter({
      ...base,
      sourceMode: 'exclude',
      sourceKeys: ['rss~feeda'],
      typeFilter: ['rss', 'atproto.documents', 'bsky.likes'],
    });
    const shown = (k: string) => checkStateOf(up, k, ctx);
    expect(shown('rss~feeda')).toBe('off');
    expect(shown('rss~feedb')).toBe('on');
    expect(shown('doc1~documents')).toBe('on');
    expect(shown('rss~likes')).toBe('on');
    expect(shown('rss~bms')).toBe('off');
    expect(shown('rss~mail2')).toBe('off');
  });

  it("keeps a smart channel's type filter for its rule", () => {
    const up = upgradeChannelFilter({
      ...base,
      sourceMode: 'include',
      sourceKeys: ['rss~feeda', 'rss~mail1'],
      autoRule: { type: 'category', value: 'Tech' },
      typeFilter: ['email.newsletter'],
    });
    expect(up.typeFilter).toEqual(['email.newsletter']);
    expect(keysOfTypes(up.sourceKeys, up.typeFilter, subs)).toEqual(['rss~mail1']);
  });
});

describe('every source and no source', () => {
  it('checks your follows too when Everything leaves them out', () => {
    expect(everySourceFilter(true, false)).toEqual({ sourceMode: 'exclude', sourceKeys: [] });
    expect(everySourceFilter(true, true)).toEqual({ sourceMode: 'all', sourceKeys: [] });
    expect(everySourceFilter(false, false)).toEqual({ sourceMode: 'all', sourceKeys: [] });
  });

  it('sees an exclude filter that unchecks every group as empty', () => {
    const none: SourceFilter = {
      sourceMode: 'exclude',
      sourceKeys: [GROUP_PUBLICATIONS, GROUP_NEWSLETTERS, GROUP_LIKES, GROUP_BOOKMARKS],
    };
    expect(showsNoSource(none, subs, ctx, false)).toBe(true);
    // Your follows' links are still in it, when they're offered.
    expect(showsNoSource(none, subs, ctx, true)).toBe(false);
    expect(showsNoSource({ sourceMode: 'all', sourceKeys: [] }, subs, ctx, false)).toBe(false);
    expect(showsNoSource({ sourceMode: 'include', sourceKeys: [] }, subs, ctx, true)).toBe(true);
  });
});
