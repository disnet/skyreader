import { describe, expect, it } from 'vitest';
import type { Subscription } from '$lib/types';
import { FOLLOWS_CHANNEL_NAME, FOLLOWS_SOURCE_KEY } from './sourceKeys';
import { GROUP_NEWSLETTERS, categoryGroupKey } from './sourceFilter';
import { sourceFilterName, uniqueChannelName } from './channelName';

const subs = [
  { rkey: 'a', sourceType: 'rss', feedUrl: 'https://a.example/feed', title: 'Alpha', tags: [] },
  {
    rkey: 'b',
    sourceType: 'rss',
    feedUrl: 'https://b.example/feed',
    title: 'B',
    customTitle: 'Beta',
    tags: [],
  },
] as unknown as Subscription[];

describe('sourceFilterName', () => {
  it('names the sources a channel takes', () => {
    expect(sourceFilterName({ sourceMode: 'include', sourceKeys: ['rss~a'] }, subs, false)).toBe(
      'Alpha'
    );
    expect(
      sourceFilterName({ sourceMode: 'include', sourceKeys: ['rss~a', 'rss~b'] }, subs, false)
    ).toBe('Alpha & Beta');
  });

  it('names groups and folders', () => {
    expect(
      sourceFilterName(
        { sourceMode: 'include', sourceKeys: [GROUP_NEWSLETTERS, categoryGroupKey('Tech')] },
        subs,
        false
      )
    ).toBe('Newsletters & Tech');
  });

  it('names what an exclude filter leaves out', () => {
    expect(sourceFilterName({ sourceMode: 'exclude', sourceKeys: ['rss~a'] }, subs, true)).toBe(
      'Without Alpha'
    );
    expect(
      sourceFilterName({ sourceMode: 'exclude', sourceKeys: [FOLLOWS_SOURCE_KEY] }, subs, false)
    ).toBe(`Everything + ${FOLLOWS_CHANNEL_NAME}`);
  });

  it('has no name for Everything or nothing picked', () => {
    expect(sourceFilterName({ sourceMode: 'all', sourceKeys: [] }, subs, false)).toBe('');
    expect(sourceFilterName({ sourceMode: 'include', sourceKeys: [] }, subs, false)).toBe('');
  });
});

describe('uniqueChannelName', () => {
  it('numbers a name that is taken', () => {
    expect(uniqueChannelName('Tech', [])).toBe('Tech');
    expect(uniqueChannelName('Tech', ['Tech', 'Tech 2'])).toBe('Tech 3');
  });
});
