import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Subscription, Article, FilteredView } from '$lib/types';
import {
  isValidAutoRule,
  computeSourceKeys,
  getArticleFrequencyByFeed,
  getAvgContentLengthByFeed,
  isAlreadyCovered,
  getCategorySuggestions,
  getTypeSuggestions,
  getTagSuggestions,
  getPeopleSuggestion,
  getDomainSuggestions,
  getFrequencySuggestions,
  getLongReadsSuggestion,
  getRecentSuggestion,
  generateAllSuggestions,
  getSuggestionPriority,
  MIN_SOURCES_FOR_SUGGESTION,
  type SuggestionContext,
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

function makeView(overrides: Partial<FilteredView> & { id: number }): FilteredView {
  return {
    name: `View ${overrides.id}`,
    readFilter: 'all',
    sortOrder: 'newest',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    position: 0,
    ...overrides,
  };
}

function emptyCtx(): SuggestionContext {
  return { subscriptions: [], articles: [], views: [] };
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
      expect(keys).toEqual(['rss~1', 'rss~2']);
    });

    it('includes atproto subscriptions with matching category', () => {
      const subs = [
        makeSub({
          id: 1,
          category: 'Social',
          sourceType: 'atproto.shares',
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
      expect(keys).toEqual(['did:plc:a~shares', 'did:plc:b~documents']);
    });

    it('skips subscriptions without id', () => {
      const subs = [{ ...makeSub({ id: 1, category: 'Tech' }), id: undefined }];
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
      expect(keys).toEqual(['rss~1', 'rss~2']);
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
      expect(keys).toEqual(['rss~1', 'rss~3']);
    });

    it('skips non-RSS subscriptions', () => {
      const subs = [
        makeSub({
          id: 1,
          feedUrl: 'https://substack.com/feed',
          sourceType: 'atproto.shares',
          subjectDid: 'did:plc:a',
        }),
      ];
      const keys = computeSourceKeys({ type: 'domain', patterns: ['substack.com'] }, subs, []);
      expect(keys).toEqual([]);
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
        makeSub({ id: 1, sourceType: 'atproto.shares', subjectDid: 'did:plc:a' }),
        makeSub({ id: 2, sourceType: 'atproto.documents', subjectDid: 'did:plc:b' }),
        makeSub({ id: 3 }), // RSS, no subjectDid
      ];
      const keys = computeSourceKeys({ type: 'people' }, subs, []);
      expect(keys).toEqual(['did:plc:a~shares', 'did:plc:b~documents']);
    });

    it('skips subscriptions without subjectDid', () => {
      const subs = [makeSub({ id: 1, sourceType: 'atproto.shares' })];
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
        makeArticle({ subscriptionId: 1, guid: `a${i}`, publishedAt: recentDate })
      );
      // 2 articles for sub 2 = ~0.14/day
      articles.push(makeArticle({ subscriptionId: 2, guid: 'b1', publishedAt: recentDate }));
      articles.push(makeArticle({ subscriptionId: 2, guid: 'b2', publishedAt: recentDate }));

      const keys = computeSourceKeys({ type: 'frequency', threshold: 'high' }, subs, articles);
      expect(keys).toEqual(['rss~1']);
    });

    it('selects low-frequency feeds (0 < rate < 0.3/day)', () => {
      const subs = [makeSub({ id: 1 }), makeSub({ id: 2 })];
      // 2 articles in 14 days = ~0.14/day → low freq
      const articles = [
        makeArticle({ subscriptionId: 1, guid: 'a1', publishedAt: recentDate }),
        makeArticle({ subscriptionId: 1, guid: 'a2', publishedAt: recentDate }),
        // 30 articles for sub 2 → high freq, not low
        ...Array.from({ length: 30 }, (_, i) =>
          makeArticle({ subscriptionId: 2, guid: `b${i}`, publishedAt: recentDate })
        ),
      ];

      const keys = computeSourceKeys({ type: 'frequency', threshold: 'low' }, subs, articles);
      expect(keys).toEqual(['rss~1']);
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
        makeArticle({ subscriptionId: 1, guid: 'a1', content: 'x'.repeat(6000) }),
        makeArticle({ subscriptionId: 1, guid: 'a2', content: 'x'.repeat(7000) }),
        makeArticle({ subscriptionId: 2, guid: 'b1', content: 'x'.repeat(100) }),
        makeArticle({ subscriptionId: 2, guid: 'b2', content: 'x'.repeat(200) }),
      ];
      const keys = computeSourceKeys({ type: 'longReads', minLength: 5000 }, subs, articles);
      expect(keys).toEqual(['rss~1']);
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
          sourceType: 'atproto.shares',
          subjectDid: 'did:plc:a',
        }),
      ];
      const keys = computeSourceKeys({ type: 'recent', withinDays: 14 }, subs, []);
      expect(keys).toEqual(['rss~1', 'did:plc:a~shares']);
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

// ─── isAlreadyCovered ──────────────────────────────────────────────────

describe('isAlreadyCovered', () => {
  it('returns true when a view with sourceMode all and no type filter exists', () => {
    const views = [makeView({ id: 1, sourceMode: 'all' })];
    expect(isAlreadyCovered([], [], views)).toBe(true);
  });

  it('returns true when a view covers the type filter', () => {
    const views = [makeView({ id: 1, sourceMode: 'all', typeFilter: ['rss'] })];
    expect(isAlreadyCovered([], ['rss'], views)).toBe(true);
  });

  it('returns false when type filters do not match', () => {
    const views = [makeView({ id: 1, sourceMode: 'all', typeFilter: ['rss'] })];
    expect(isAlreadyCovered([], ['atproto.shares'], views)).toBe(false);
  });

  it('returns true when 70%+ of source keys overlap', () => {
    const views = [
      makeView({
        id: 1,
        sourceMode: 'include',
        sourceKeys: ['rss~1', 'rss~2', 'rss~3'],
      }),
    ];
    // 2 out of 2 overlap (100%) with the view
    expect(isAlreadyCovered(['rss~1', 'rss~2'], [], views)).toBe(true);
  });

  it('returns false when less than 70% overlap', () => {
    const views = [
      makeView({
        id: 1,
        sourceMode: 'include',
        sourceKeys: ['rss~1'],
      }),
    ];
    // 1 out of 4 overlap (25%)
    expect(isAlreadyCovered(['rss~1', 'rss~2', 'rss~3', 'rss~4'], [], views)).toBe(false);
  });

  it('returns false when no views exist', () => {
    expect(isAlreadyCovered(['rss~1'], [], [])).toBe(false);
  });
});

// ─── Suggestion generators ─────────────────────────────────────────────

describe('getCategorySuggestions', () => {
  it('suggests channels for categories with 3+ feeds', () => {
    const ctx: SuggestionContext = {
      subscriptions: [
        makeSub({ id: 1, category: 'Tech' }),
        makeSub({ id: 2, category: 'Tech' }),
        makeSub({ id: 3, category: 'Tech' }),
        makeSub({ id: 4, category: 'News' }),
      ],
      articles: [],
      views: [],
    };
    const suggestions = getCategorySuggestions(ctx);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].name).toBe('Tech');
    expect(suggestions[0].autoRule).toEqual({ type: 'category', value: 'Tech' });
    expect(suggestions[0].sourceKeys).toEqual(['rss~1', 'rss~2', 'rss~3']);
  });

  it('skips categories with fewer than 3 feeds', () => {
    const ctx: SuggestionContext = {
      subscriptions: [makeSub({ id: 1, category: 'Tech' }), makeSub({ id: 2, category: 'Tech' })],
      articles: [],
      views: [],
    };
    expect(getCategorySuggestions(ctx)).toHaveLength(0);
  });

  it('skips categories already covered by existing channels', () => {
    const ctx: SuggestionContext = {
      subscriptions: [
        makeSub({ id: 1, category: 'Tech' }),
        makeSub({ id: 2, category: 'Tech' }),
        makeSub({ id: 3, category: 'Tech' }),
      ],
      articles: [],
      views: [
        makeView({
          id: 1,
          sourceMode: 'include',
          sourceKeys: ['rss~1', 'rss~2', 'rss~3'],
        }),
      ],
    };
    expect(getCategorySuggestions(ctx)).toHaveLength(0);
  });
});

describe('getTypeSuggestions', () => {
  it('suggests Articles and Social when both types present', () => {
    const ctx: SuggestionContext = {
      subscriptions: [
        makeSub({ id: 1 }),
        makeSub({ id: 2 }),
        makeSub({ id: 3, sourceType: 'atproto.shares', subjectDid: 'did:plc:a' }),
        makeSub({ id: 4, sourceType: 'atproto.documents', subjectDid: 'did:plc:b' }),
      ],
      articles: [],
      views: [],
    };
    const suggestions = getTypeSuggestions(ctx);
    expect(suggestions.map((s) => s.id)).toContain('type:articles');
    expect(suggestions.map((s) => s.id)).toContain('type:social');
  });

  it('does not suggest when only RSS feeds exist', () => {
    const ctx: SuggestionContext = {
      subscriptions: [makeSub({ id: 1 }), makeSub({ id: 2 })],
      articles: [],
      views: [],
    };
    expect(getTypeSuggestions(ctx)).toHaveLength(0);
  });
});

describe('getTagSuggestions', () => {
  it('suggests channels for tags with 3+ subscriptions', () => {
    const ctx: SuggestionContext = {
      subscriptions: [
        makeSub({ id: 1, tags: ['dev'] }),
        makeSub({ id: 2, tags: ['dev'] }),
        makeSub({ id: 3, tags: ['dev'] }),
      ],
      articles: [],
      views: [],
    };
    const suggestions = getTagSuggestions(ctx);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].name).toBe('Dev');
    expect(suggestions[0].id).toBe('tag:dev');
  });
});

describe('getPeopleSuggestion', () => {
  it('suggests People I Follow with 3+ atproto subscriptions', () => {
    const ctx: SuggestionContext = {
      subscriptions: [
        makeSub({ id: 1, sourceType: 'atproto.shares', subjectDid: 'did:plc:a' }),
        makeSub({ id: 2, sourceType: 'atproto.shares', subjectDid: 'did:plc:b' }),
        makeSub({ id: 3, sourceType: 'atproto.documents', subjectDid: 'did:plc:c' }),
      ],
      articles: [],
      views: [],
    };
    const suggestions = getPeopleSuggestion(ctx);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].id).toBe('people:all');
    expect(suggestions[0].sourceKeys).toHaveLength(3);
  });

  it('returns empty with fewer than 3 atproto subscriptions', () => {
    const ctx: SuggestionContext = {
      subscriptions: [makeSub({ id: 1, sourceType: 'atproto.shares', subjectDid: 'did:plc:a' })],
      articles: [],
      views: [],
    };
    expect(getPeopleSuggestion(ctx)).toHaveLength(0);
  });
});

describe('getDomainSuggestions', () => {
  it('clusters substack feeds as Newsletters', () => {
    const ctx: SuggestionContext = {
      subscriptions: [
        makeSub({ id: 1, feedUrl: 'https://blog1.substack.com/feed' }),
        makeSub({ id: 2, feedUrl: 'https://blog2.substack.com/feed' }),
        makeSub({ id: 3, feedUrl: 'https://blog3.substack.com/feed' }),
      ],
      articles: [],
      views: [],
    };
    const suggestions = getDomainSuggestions(ctx);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].id).toBe('domain:newsletters');
    expect(suggestions[0].name).toBe('Newsletters');
  });

  it('clusters github feeds', () => {
    const ctx: SuggestionContext = {
      subscriptions: [
        makeSub({ id: 1, feedUrl: 'https://github.com/org/repo/releases.atom' }),
        makeSub({ id: 2, feedUrl: 'https://github.com/org/repo2/releases.atom' }),
        makeSub({ id: 3, siteUrl: 'https://user.github.io' }),
      ],
      articles: [],
      views: [],
    };
    const suggestions = getDomainSuggestions(ctx);
    expect(suggestions.some((s) => s.id === 'domain:github')).toBe(true);
  });
});

describe('getFrequencySuggestions', () => {
  const now = Date.now();
  const recentDate = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();

  it('suggests Daily Digest for high-frequency feeds', () => {
    const subs = [makeSub({ id: 1 }), makeSub({ id: 2 }), makeSub({ id: 3 }), makeSub({ id: 4 })];
    // 30+ articles each for subs 1-3 in last 14 days
    const articles = [1, 2, 3].flatMap((subId) =>
      Array.from({ length: 30 }, (_, i) =>
        makeArticle({ subscriptionId: subId, guid: `${subId}-${i}`, publishedAt: recentDate })
      )
    );
    const ctx: SuggestionContext = { subscriptions: subs, articles, views: [] };
    const suggestions = getFrequencySuggestions(ctx);
    expect(suggestions.some((s) => s.id === 'frequency:high')).toBe(true);
  });

  it("suggests Don't Miss for low-frequency feeds", () => {
    const subs = [makeSub({ id: 1 }), makeSub({ id: 2 }), makeSub({ id: 3 }), makeSub({ id: 4 })];
    // 1-3 articles each → low freq
    const articles = [1, 2, 3].flatMap((subId) => [
      makeArticle({ subscriptionId: subId, guid: `${subId}-0`, publishedAt: recentDate }),
      makeArticle({ subscriptionId: subId, guid: `${subId}-1`, publishedAt: recentDate }),
    ]);
    const ctx: SuggestionContext = { subscriptions: subs, articles, views: [] };
    const suggestions = getFrequencySuggestions(ctx);
    expect(suggestions.some((s) => s.id === 'frequency:low')).toBe(true);
  });

  it('returns empty when fewer than 4 feeds', () => {
    const ctx: SuggestionContext = {
      subscriptions: [makeSub({ id: 1 }), makeSub({ id: 2 })],
      articles: [],
      views: [],
    };
    expect(getFrequencySuggestions(ctx)).toHaveLength(0);
  });
});

describe('getLongReadsSuggestion', () => {
  it('suggests Long Reads when 3+ feeds have high avg content length', () => {
    const subs = [makeSub({ id: 1 }), makeSub({ id: 2 }), makeSub({ id: 3 })];
    const articles = subs.flatMap((sub) => [
      makeArticle({ subscriptionId: sub.id!, guid: `${sub.id}-a`, content: 'x'.repeat(6000) }),
      makeArticle({ subscriptionId: sub.id!, guid: `${sub.id}-b`, content: 'x'.repeat(7000) }),
    ]);
    const ctx: SuggestionContext = { subscriptions: subs, articles, views: [] };
    const suggestions = getLongReadsSuggestion(ctx);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].id).toBe('content:longreads');
  });

  it('returns empty when feeds have short content', () => {
    const subs = [makeSub({ id: 1 }), makeSub({ id: 2 }), makeSub({ id: 3 })];
    const articles = subs.flatMap((sub) => [
      makeArticle({ subscriptionId: sub.id!, guid: `${sub.id}-a`, content: 'x'.repeat(100) }),
      makeArticle({ subscriptionId: sub.id!, guid: `${sub.id}-b`, content: 'x'.repeat(200) }),
    ]);
    const ctx: SuggestionContext = { subscriptions: subs, articles, views: [] };
    expect(getLongReadsSuggestion(ctx)).toHaveLength(0);
  });
});

describe('getRecentSuggestion', () => {
  it('suggests New Sources for recently added subscriptions', () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const subs = [
      makeSub({ id: 1, createdAt: recent }),
      makeSub({ id: 2, createdAt: recent }),
      makeSub({ id: 3, createdAt: recent }),
    ];
    const ctx: SuggestionContext = { subscriptions: subs, articles: [], views: [] };
    const suggestions = getRecentSuggestion(ctx);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].id).toBe('recent:new');
  });

  it('returns empty when all subscriptions are old', () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const subs = [
      makeSub({ id: 1, createdAt: old }),
      makeSub({ id: 2, createdAt: old }),
      makeSub({ id: 3, createdAt: old }),
    ];
    const ctx: SuggestionContext = { subscriptions: subs, articles: [], views: [] };
    expect(getRecentSuggestion(ctx)).toHaveLength(0);
  });
});

// ─── getSuggestionPriority ─────────────────────────────────────────────

describe('getSuggestionPriority', () => {
  it('assigns known priorities', () => {
    expect(getSuggestionPriority('frequency:high')).toBe(1);
    expect(getSuggestionPriority('frequency:low')).toBe(2);
    expect(getSuggestionPriority('people:all')).toBe(4);
    expect(getSuggestionPriority('recent:new')).toBe(7);
  });

  it('assigns group priorities for dynamic IDs', () => {
    expect(getSuggestionPriority('category:tech')).toBe(10);
    expect(getSuggestionPriority('tag:news')).toBe(11);
    expect(getSuggestionPriority('domain:newsletters')).toBe(12);
  });

  it('defaults to 20 for unknown IDs', () => {
    expect(getSuggestionPriority('unknown:something')).toBe(20);
  });
});

// ─── generateAllSuggestions ────────────────────────────────────────────

describe('generateAllSuggestions', () => {
  it('filters out dismissed suggestions', () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const ctx: SuggestionContext = {
      subscriptions: [
        makeSub({ id: 1, category: 'Tech', createdAt: recent }),
        makeSub({ id: 2, category: 'Tech', createdAt: recent }),
        makeSub({ id: 3, category: 'Tech', createdAt: recent }),
      ],
      articles: [],
      views: [],
    };
    const dismissed = new Set(['category:tech']);
    const suggestions = generateAllSuggestions(ctx, dismissed);
    expect(suggestions.find((s) => s.id === 'category:tech')).toBeUndefined();
  });

  it('sorts by priority', () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const ctx: SuggestionContext = {
      subscriptions: [
        // Category suggestion
        makeSub({ id: 1, category: 'Tech', createdAt: recent }),
        makeSub({ id: 2, category: 'Tech', createdAt: recent }),
        makeSub({ id: 3, category: 'Tech', createdAt: recent }),
        // Recent suggestion (also these 3 are recent)
      ],
      articles: [],
      views: [],
    };
    const suggestions = generateAllSuggestions(ctx, new Set());
    if (suggestions.length >= 2) {
      // recent:new (priority 7) should come before category:tech (priority 10)
      const recentIdx = suggestions.findIndex((s) => s.id === 'recent:new');
      const categoryIdx = suggestions.findIndex((s) => s.id === 'category:tech');
      if (recentIdx >= 0 && categoryIdx >= 0) {
        expect(recentIdx).toBeLessThan(categoryIdx);
      }
    }
  });

  it('returns empty for empty context', () => {
    expect(generateAllSuggestions(emptyCtx(), new Set())).toHaveLength(0);
  });
});
