import { describe, it, expect } from 'vitest';
import {
  selectNewArticles,
  computeArticleLimitDeletions,
  computeContentStats,
  toLightArticle,
  MAX_ARTICLES_PER_FEED,
} from './articleMerge';
import type { Article, FeedItem } from '$lib/types';

function item(guid: string, overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    guid,
    url: `https://example.com/${guid}`,
    title: `Title ${guid}`,
    publishedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  } as FeedItem;
}

function article(subscriptionId: number, guid: string, overrides: Partial<Article> = {}): Article {
  return {
    subscriptionId,
    guid,
    url: `https://example.com/${guid}`,
    title: `Title ${guid}`,
    publishedAt: '2024-01-01T00:00:00Z',
    fetchedAt: 0,
    ...overrides,
  } as Article;
}

describe('selectNewArticles', () => {
  const NOW = 1700000000000;

  it('returns all items when nothing exists yet', () => {
    const { newArticles, affected } = selectNewArticles(
      [],
      [{ subscriptionId: 1, items: [item('a'), item('b')] }],
      NOW
    );
    expect(newArticles.map((a) => a.guid)).toEqual(['a', 'b']);
    expect([...affected]).toEqual([1]);
  });

  it('skips items whose (subscriptionId, guid) already exists', () => {
    const existing = [article(1, 'a')];
    const { newArticles } = selectNewArticles(
      existing,
      [{ subscriptionId: 1, items: [item('a'), item('b')] }],
      NOW
    );
    expect(newArticles.map((a) => a.guid)).toEqual(['b']);
  });

  it('treats the same guid in different feeds as distinct', () => {
    const existing = [article(1, 'shared')];
    const { newArticles, affected } = selectNewArticles(
      existing,
      [{ subscriptionId: 2, items: [item('shared')] }],
      NOW
    );
    expect(newArticles).toHaveLength(1);
    expect(newArticles[0]).toMatchObject({ subscriptionId: 2, guid: 'shared' });
    expect([...affected]).toEqual([2]);
  });

  it('dedupes repeated guids within the same payload', () => {
    const { newArticles } = selectNewArticles(
      [],
      [{ subscriptionId: 1, items: [item('a'), item('a'), item('b')] }],
      NOW
    );
    expect(newArticles.map((a) => a.guid)).toEqual(['a', 'b']);
  });

  it('stamps fetchedAt and carries item fields through', () => {
    const { newArticles } = selectNewArticles(
      [],
      [
        {
          subscriptionId: 7,
          items: [item('a', { author: 'Ada', imageUrl: 'img.png' })],
        },
      ],
      NOW
    );
    expect(newArticles[0]).toMatchObject({
      subscriptionId: 7,
      guid: 'a',
      author: 'Ada',
      imageUrl: 'img.png',
      fetchedAt: NOW,
    });
  });

  it('only marks feeds that actually contributed new articles as affected', () => {
    const existing = [article(1, 'a')];
    const { affected } = selectNewArticles(
      existing,
      [
        { subscriptionId: 1, items: [item('a')] }, // all duplicates
        { subscriptionId: 2, items: [item('x')] }, // new
      ],
      NOW
    );
    expect(affected.has(1)).toBe(false);
    expect(affected.has(2)).toBe(true);
  });
});

describe('computeArticleLimitDeletions', () => {
  // Build `count` articles for a feed, newest-first (index 0 is newest),
  // matching the order liveDb keeps `_articles` in.
  function feedArticles(subscriptionId: number, count: number, startId = 0): Article[] {
    return Array.from({ length: count }, (_, i) =>
      article(subscriptionId, `g${i}`, {
        id: startId + i,
        // newest first: larger date for smaller index
        publishedAt: new Date(NOW - i * 1000).toISOString(),
      })
    );
  }
  const NOW = 1700000000000;

  it('keeps feeds at or under the limit untouched', () => {
    const articles = feedArticles(1, 3);
    const { ids, dropByFeed } = computeArticleLimitDeletions(articles, new Set([1]), new Set(), 5);
    expect(ids).toEqual([]);
    expect(dropByFeed.size).toBe(0);
  });

  it('drops the oldest articles beyond the limit', () => {
    const articles = feedArticles(1, 5); // ids 0..4, g0 newest .. g4 oldest
    const { ids, dropByFeed } = computeArticleLimitDeletions(articles, new Set([1]), new Set(), 3);
    // keep g0,g1,g2 (newest); drop g3,g4
    expect(ids.sort((a, b) => a - b)).toEqual([3, 4]);
    expect([...(dropByFeed.get(1) ?? [])].sort()).toEqual(['g3', 'g4']);
  });

  it('preserves starred articles even when they are the oldest', () => {
    const articles = feedArticles(1, 5);
    // star the two oldest
    const saved = new Set(['g3', 'g4']);
    const { ids, dropByFeed } = computeArticleLimitDeletions(articles, new Set([1]), saved, 3);
    // 2 starred kept + 1 newest non-starred (g0) => drop g1, g2
    expect([...(dropByFeed.get(1) ?? [])].sort()).toEqual(['g1', 'g2']);
    expect(ids.sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('keeps all starred even when they exceed the limit on their own', () => {
    const articles = feedArticles(1, 5);
    const saved = new Set(['g0', 'g1', 'g2', 'g3']); // 4 starred, limit 3
    const { dropByFeed } = computeArticleLimitDeletions(articles, new Set([1]), saved, 3);
    // keepCount = max(0, 3-4) = 0 non-starred; only non-starred g4 is dropped
    expect([...(dropByFeed.get(1) ?? [])]).toEqual(['g4']);
  });

  it('only touches feeds in the affected set', () => {
    const articles = [...feedArticles(1, 5, 0), ...feedArticles(2, 5, 100)];
    const { dropByFeed } = computeArticleLimitDeletions(articles, new Set([2]), new Set(), 3);
    expect(dropByFeed.has(1)).toBe(false);
    expect(dropByFeed.has(2)).toBe(true);
  });

  it('enforces the limit independently per feed in one pass', () => {
    const articles = [...feedArticles(1, 4, 0), ...feedArticles(2, 6, 100)];
    const { dropByFeed } = computeArticleLimitDeletions(articles, new Set([1, 2]), new Set(), 3);
    expect([...(dropByFeed.get(1) ?? [])].sort()).toEqual(['g3']);
    expect([...(dropByFeed.get(2) ?? [])].sort()).toEqual(['g3', 'g4', 'g5']);
  });

  it('defaults to MAX_ARTICLES_PER_FEED', () => {
    const articles = feedArticles(1, MAX_ARTICLES_PER_FEED + 2);
    const { ids } = computeArticleLimitDeletions(articles, new Set([1]), new Set());
    expect(ids).toHaveLength(2);
  });
});

describe('computeContentStats', () => {
  it('counts chars and words from content', () => {
    expect(computeContentStats('one two three')).toEqual({ contentLength: 13, wordCount: 3 });
  });

  it('prefers content over summary (matching historical precedence)', () => {
    expect(computeContentStats('full body text', 'short')).toEqual({
      contentLength: 14,
      wordCount: 3,
    });
  });

  it('falls back to summary when content is absent', () => {
    expect(computeContentStats(undefined, 'a b')).toEqual({ contentLength: 3, wordCount: 2 });
  });

  it('returns zeros for empty/whitespace', () => {
    expect(computeContentStats('', '')).toEqual({ contentLength: 0, wordCount: 0 });
    expect(computeContentStats('   ')).toEqual({ contentLength: 3, wordCount: 0 });
  });
});

describe('toLightArticle', () => {
  it('drops content, keeps summary, and attaches stats', () => {
    const full = article(1, 'g1', {
      id: 7,
      content: '<p>hello world body</p>',
      summary: 'a summary',
    });
    const light = toLightArticle(full);

    expect(light.content).toBeUndefined();
    expect(light.summary).toBe('a summary');
    // metadata preserved
    expect(light.id).toBe(7);
    expect(light.guid).toBe('g1');
    expect(light.subscriptionId).toBe(1);
    // stats reflect the original content, not the summary. Word count uses the
    // same naive whitespace split as the historical inline code (HTML tags stay
    // attached to adjacent words), so "<p>hello world body</p>" is 3 words.
    expect(light.contentLength).toBe('<p>hello world body</p>'.length);
    expect(light.wordCount).toBe(3);
  });

  it('is idempotent — re-lightening recomputes the same stats', () => {
    const once = toLightArticle(article(1, 'g1', { content: 'x y z', summary: 'fallback' }));
    const twice = toLightArticle(once);
    // after the first pass content is gone, so stats fall back to summary
    expect(twice.contentLength).toBe('fallback'.length);
    expect(twice.wordCount).toBe(1);
    expect(twice.content).toBeUndefined();
  });
});
