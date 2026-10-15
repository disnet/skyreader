import { describe, it, expect } from 'vitest';
import type { Subscription, Article } from '$lib/types';
import {
  isValidAutoRule,
  computeSourceKeys,
  getArticleFrequencyByFeed,
  getAvgContentLengthByFeed,
  NEWSLETTER_EMAIL_PATTERN,
} from './channelLogic';

// ─── Test helpers ──────────────────────────────────────────────────────

function makeSub(overrides: Partial<Subscription> & { id: number }): Subscription {
  return {
    rkey: `rkey-${overrides.id}`,
    title: `Feed ${overrides.id}`,
    tags: [],
    createdAt: '2024-01-01T00:00:00Z',
    localUpdatedAt: 0,
    ...overrides,
  };
}

function makeArticle(
  overrides: Partial<Article> & { subscriptionId: number; guid: string }
): Article {
  return {
    url: `https://example.com/${overrides.guid}`,
    title: `Article ${overrides.guid}`,
    publishedAt: new Date().toISOString(),
    fetchedAt: Date.now(),
    ...overrides,
  };
}

// ─── isValidAutoRule ───────────────────────────────────────────────────

describe('isValidAutoRule', () => {
  it('rejects null/undefined', () => {
    expect(isValidAutoRule(null)).toBe(false);
    expect(isValidAutoRule(undefined)).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isValidAutoRule('category')).toBe(false);
    expect(isValidAutoRule(42)).toBe(false);
  });

  it('rejects objects without type', () => {
    expect(isValidAutoRule({ value: 'Tech' })).toBe(false);
  });

  it('rejects unknown rule types', () => {
    expect(isValidAutoRule({ type: 'unknown' })).toBe(false);
  });

  it('validates category rules', () => {
    expect(isValidAutoRule({ type: 'category', value: 'Tech' })).toBe(true);
    expect(isValidAutoRule({ type: 'category' })).toBe(false);
    expect(isValidAutoRule({ type: 'category', value: 42 })).toBe(false);
  });

  it('validates subscriptionTag rules', () => {
    expect(isValidAutoRule({ type: 'subscriptionTag', value: 'news' })).toBe(true);
    expect(isValidAutoRule({ type: 'subscriptionTag' })).toBe(false);
  });

  it('validates domain rules', () => {
    expect(isValidAutoRule({ type: 'domain', patterns: ['substack.com'] })).toBe(true);
    expect(isValidAutoRule({ type: 'domain' })).toBe(false);
    expect(isValidAutoRule({ type: 'domain', patterns: 'not-array' })).toBe(false);
  });

  it('validates people rules', () => {
    expect(isValidAutoRule({ type: 'people' })).toBe(true);
  });

  it('validates frequency rules', () => {
    expect(isValidAutoRule({ type: 'frequency', threshold: 'high' })).toBe(true);
    expect(isValidAutoRule({ type: 'frequency', threshold: 'low' })).toBe(true);
    expect(isValidAutoRule({ type: 'frequency', threshold: 'medium' })).toBe(false);
    expect(isValidAutoRule({ type: 'frequency' })).toBe(false);
  });

  it('validates longReads rules', () => {
    expect(isValidAutoRule({ type: 'longReads', minLength: 5000 })).toBe(true);
    expect(isValidAutoRule({ type: 'longReads' })).toBe(false);
    expect(isValidAutoRule({ type: 'longReads', minLength: 'many' })).toBe(false);
  });

  it('validates recent rules', () => {
    expect(isValidAutoRule({ type: 'recent', withinDays: 14 })).toBe(true);
    expect(isValidAutoRule({ type: 'recent' })).toBe(false);
    expect(isValidAutoRule({ type: 'recent', withinDays: 'two weeks' })).toBe(false);
  });
});

// ─── computeSourceKeys ─────────────────────────────────────────────────

describe('computeSourceKeys', () => {
  describe('category rule', () => {
    it('matches subscriptions by category (case-insensitive)', () => {
      const subs = [
        makeSub({ id: 1, category: 'Tech' }),
        makeSub({ id: 2, category: 'tech' }),
        makeSub({ id: 3, category: 'News' }),
      ];
      const keys = computeSourceKeys({ type: 'category', value: 'tech' }, subs, []);
      expect(keys).toEqual(['rss~rkey-1', 'rss~rkey-2']);
    });

    it('includes atproto subscriptions with matching category', () => {
      const subs = [
        makeSub({
          id: 1,
          category: 'Social',
          sourceType: 'atproto.documents',
          subjectDid: 'did:plc:a',
        }),
        makeSub({
          id: 2,
          category: 'Social',
          sourceType: 'atproto.documents',
          subjectDid: 'did:plc:b',
        }),
      ];
      const keys = computeSourceKeys({ type: 'category', value: 'Social' }, subs, []);
      expect(keys).toEqual(['rkey-1~documents', 'rkey-2~documents']);
    });

    it('skips subscriptions without rkey', () => {
      const subs = [{ ...makeSub({ id: 1, category: 'Tech' }), rkey: '' }];
      const keys = computeSourceKeys({ type: 'category', value: 'Tech' }, subs as any, []);
      expect(keys).toEqual([]);
    });
  });

  describe('subscriptionTag rule', () => {
    it('matches by tag (case-insensitive, trimmed)', () => {
      const subs = [
        makeSub({ id: 1, tags: ['News', 'tech'] }),
        makeSub({ id: 2, tags: [' Tech '] }),
        makeSub({ id: 3, tags: ['sports'] }),
      ];
      const keys = computeSourceKeys({ type: 'subscriptionTag', value: 'tech' }, subs, []);
      expect(keys).toEqual(['rss~rkey-1', 'rss~rkey-2']);
    });
  });

  describe('domain rule', () => {
    it('matches feeds by URL hostname pattern', () => {
      const subs = [
        makeSub({ id: 1, feedUrl: 'https://blog.substack.com/feed' }),
        makeSub({ id: 2, feedUrl: 'https://example.com/rss' }),
        makeSub({ id: 3, siteUrl: 'https://news.substack.com' }),
      ];
      const keys = computeSourceKeys({ type: 'domain', patterns: ['substack.com'] }, subs, []);
      expect(keys).toEqual(['rss~rkey-1', 'rss~rkey-3']);
    });

    it('skips non-RSS subscriptions', () => {
      const subs = [
        makeSub({
          id: 1,
          feedUrl: 'https://substack.com/feed',
          sourceType: 'atproto.documents',
          subjectDid: 'did:plc:a',
        }),
      ];
      const keys = computeSourceKeys({ type: 'domain', patterns: ['substack.com'] }, subs, []);
      expect(keys).toEqual([]);
    });

    it('matches email newsletters by the newsletter pattern', () => {
      const subs = [
        makeSub({ id: 1, sourceType: 'email.newsletter', feedUrl: 'newsletter:inbox/1@x.com' }),
        makeSub({ id: 2, feedUrl: 'https://example.com/rss' }),
      ];
      const rule = { type: 'domain' as const, patterns: [NEWSLETTER_EMAIL_PATTERN] };
      expect(computeSourceKeys(rule, subs, [])).toEqual(['rss~rkey-1']);
    });

    it('handles invalid URLs gracefully', () => {
      const subs = [makeSub({ id: 1, feedUrl: 'not a url' })];
      const keys = computeSourceKeys({ type: 'domain', patterns: ['example'] }, subs, []);
      expect(keys).toEqual([]);
    });
  });

  describe('people rule', () => {
    it('collects all atproto subscriptions', () => {
      const subs = [
        makeSub({
          id: 1,
          sourceType: 'atproto.documents',
          subjectDid: 'did:plc:a',
        }),
        makeSub({
          id: 2,
          sourceType: 'atproto.documents',
          subjectDid: 'did:plc:b',
        }),
        makeSub({ id: 3 }), // RSS, no subjectDid
      ];
      const keys = computeSourceKeys({ type: 'people' }, subs, []);
      expect(keys).toEqual(['rkey-1~documents', 'rkey-2~documents']);
    });

    it('skips subscriptions without subjectDid', () => {
      const subs = [makeSub({ id: 1, sourceType: 'atproto.documents' })];
      const keys = computeSourceKeys({ type: 'people' }, subs, []);
      expect(keys).toEqual([]);
    });
  });

  describe('frequency rule', () => {
    const now = Date.now();
    const recentDate = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago

    it('selects high-frequency feeds (2+ articles/day)', () => {
      const subs = [makeSub({ id: 1 }), makeSub({ id: 2 })];
      // 30 articles in 14 days = ~2.14/day for sub 1
      const articles = Array.from({ length: 30 }, (_, i) =>
        makeArticle({
          subscriptionId: 1,
          guid: `a${i}`,
          publishedAt: recentDate,
        })
      );
      // 2 articles for sub 2 = ~0.14/day
      articles.push(makeArticle({ subscriptionId: 2, guid: 'b1', publishedAt: recentDate }));
      articles.push(makeArticle({ subscriptionId: 2, guid: 'b2', publishedAt: recentDate }));

      const keys = computeSourceKeys({ type: 'frequency', threshold: 'high' }, subs, articles);
      expect(keys).toEqual(['rss~rkey-1']);
    });

    it('selects low-frequency feeds (0 < rate < 0.3/day)', () => {
      const subs = [makeSub({ id: 1 }), makeSub({ id: 2 })];
      // 2 articles in 14 days = ~0.14/day → low freq
      const articles = [
        makeArticle({ subscriptionId: 1, guid: 'a1', publishedAt: recentDate }),
        makeArticle({ subscriptionId: 1, guid: 'a2', publishedAt: recentDate }),
        // 30 articles for sub 2 → high freq, not low
        ...Array.from({ length: 30 }, (_, i) =>
          makeArticle({
            subscriptionId: 2,
            guid: `b${i}`,
            publishedAt: recentDate,
          })
        ),
      ];

      const keys = computeSourceKeys({ type: 'frequency', threshold: 'low' }, subs, articles);
      expect(keys).toEqual(['rss~rkey-1']);
    });

    it('excludes feeds with zero articles from low-frequency', () => {
      const subs = [makeSub({ id: 1 })];
      const keys = computeSourceKeys({ type: 'frequency', threshold: 'low' }, subs, []);
      expect(keys).toEqual([]);
    });
  });

  describe('longReads rule', () => {
    it('selects feeds with high average content length', () => {
      const subs = [makeSub({ id: 1 }), makeSub({ id: 2 })];
      const articles = [
        makeArticle({
          subscriptionId: 1,
          guid: 'a1',
          content: 'x'.repeat(6000),
        }),
        makeArticle({
          subscriptionId: 1,
          guid: 'a2',
          content: 'x'.repeat(7000),
        }),
        makeArticle({
          subscriptionId: 2,
          guid: 'b1',
          content: 'x'.repeat(100),
        }),
        makeArticle({
          subscriptionId: 2,
          guid: 'b2',
          content: 'x'.repeat(200),
        }),
      ];
      const keys = computeSourceKeys({ type: 'longReads', minLength: 5000 }, subs, articles);
      expect(keys).toEqual(['rss~rkey-1']);
    });
  });

  describe('recent rule', () => {
    it('selects recently added subscriptions', () => {
      const now = new Date();
      const recent = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString(); // 3 days ago
      const old = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago

      const subs = [
        makeSub({ id: 1, createdAt: recent }),
        makeSub({ id: 2, createdAt: old }),
        makeSub({
          id: 3,
          createdAt: recent,
          sourceType: 'atproto.documents',
          subjectDid: 'did:plc:a',
        }),
      ];
      const keys = computeSourceKeys({ type: 'recent', withinDays: 14 }, subs, []);
      expect(keys).toEqual(['rss~rkey-1', 'rkey-3~documents']);
    });
  });
});

// ─── Article frequency & content length helpers ────────────────────────

describe('getArticleFrequencyByFeed', () => {
  it('computes per-day rates over 14-day window', () => {
    const now = Date.now();
    const recentDate = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    const articles = Array.from({ length: 14 }, (_, i) =>
      makeArticle({ subscriptionId: 1, guid: `a${i}`, publishedAt: recentDate })
    );
    const result = getArticleFrequencyByFeed(articles);
    expect(result.get(1)).toBe(1); // 14 articles / 14 days = 1/day
  });

  it('ignores articles older than 14 days', () => {
    const oldDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    const articles = [makeArticle({ subscriptionId: 1, guid: 'old', publishedAt: oldDate })];
    const result = getArticleFrequencyByFeed(articles);
    expect(result.size).toBe(0);
  });
});

describe('getAvgContentLengthByFeed', () => {
  it('computes average content length', () => {
    const articles = [
      makeArticle({ subscriptionId: 1, guid: 'a1', content: 'x'.repeat(1000) }),
      makeArticle({ subscriptionId: 1, guid: 'a2', content: 'x'.repeat(3000) }),
    ];
    const result = getAvgContentLengthByFeed(articles);
    expect(result.get(1)).toBe(2000);
  });

  it('falls back to summary when content is missing', () => {
    const articles = [makeArticle({ subscriptionId: 1, guid: 'a1', summary: 'x'.repeat(500) })];
    const result = getAvgContentLengthByFeed(articles);
    expect(result.get(1)).toBe(500);
  });

  it('skips articles with no content or summary', () => {
    const articles = [makeArticle({ subscriptionId: 1, guid: 'a1' })];
    const result = getAvgContentLengthByFeed(articles);
    expect(result.size).toBe(0);
  });
});
