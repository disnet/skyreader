/**
 * Pure functions for channel auto-update and suggestion logic.
 * Extracted from stores so they can be unit-tested without Svelte reactivity.
 */

import type {
  Subscription,
  Article,
  FilteredView,
  SubscriptionSourceType,
  SavedItem,
  SavedSourceType,
  ReadingLengthFilter,
  SortOrder,
  DateAddedPreset,
} from '$lib/types';
import type { ChannelAutoRule } from '$lib/types';
import { rssSourceKey, sharesSourceKey, documentsSourceKey } from '$lib/utils/sourceKeys';

// ─── Auto-rule validation ─────────────────────────────────────────────

const VALID_RULE_TYPES = new Set([
  'category',
  'subscriptionTag',
  'domain',
  'people',
  'frequency',
  'longReads',
  'recent',
]);

export function isValidAutoRule(rule: unknown): rule is ChannelAutoRule {
  if (!rule || typeof rule !== 'object' || !('type' in rule)) return false;
  const r = rule as { type: string };
  if (!VALID_RULE_TYPES.has(r.type)) return false;
  switch (r.type) {
    case 'category':
    case 'subscriptionTag':
      return 'value' in r && typeof (r as { value: unknown }).value === 'string';
    case 'domain':
      return 'patterns' in r && Array.isArray((r as { patterns: unknown }).patterns);
    case 'frequency':
      return (
        'threshold' in r &&
        ((r as { threshold: unknown }).threshold === 'high' ||
          (r as { threshold: unknown }).threshold === 'low')
      );
    case 'longReads':
      return 'minLength' in r && typeof (r as { minLength: unknown }).minLength === 'number';
    case 'recent':
      return 'withinDays' in r && typeof (r as { withinDays: unknown }).withinDays === 'number';
    case 'people':
      return true;
    default:
      return false;
  }
}

// ─── Auto-rule source key computation ─────────────────────────────────

export function getArticleFrequencyByFeed(articles: Article[]): Map<number, number> {
  const now = Date.now();
  const windowMs = 14 * 24 * 60 * 60 * 1000;
  const cutoff = now - windowMs;
  const counts = new Map<number, number>();

  for (const article of articles) {
    const pubTime = new Date(article.publishedAt).getTime();
    if (pubTime < cutoff) continue;
    counts.set(article.subscriptionId, (counts.get(article.subscriptionId) || 0) + 1);
  }

  const perDay = new Map<number, number>();
  const days = windowMs / (24 * 60 * 60 * 1000);
  for (const [id, count] of counts) {
    perDay.set(id, count / days);
  }
  return perDay;
}

export function getAvgContentLengthByFeed(articles: Article[]): Map<number, number> {
  const totals = new Map<number, { sum: number; count: number }>();

  for (const article of articles) {
    const text = article.content || article.summary;
    if (!text) continue;
    const existing = totals.get(article.subscriptionId) || { sum: 0, count: 0 };
    existing.sum += text.length;
    existing.count++;
    totals.set(article.subscriptionId, existing);
  }

  const avgs = new Map<number, number>();
  for (const [id, { sum, count }] of totals) {
    if (count > 0) avgs.set(id, sum / count);
  }
  return avgs;
}

/**
 * Compute source keys for a given auto-rule based on provided subscriptions/articles.
 */
export function computeSourceKeys(
  rule: ChannelAutoRule,
  subscriptions: Subscription[],
  articles: Article[]
): string[] {
  const keys: string[] = [];

  switch (rule.type) {
    case 'category': {
      for (const sub of subscriptions) {
        if (!sub.rkey) continue;
        if (sub.category?.trim().toLowerCase() === rule.value.toLowerCase()) {
          if (!sub.sourceType || sub.sourceType === 'rss') {
            keys.push(rssSourceKey(sub.rkey));
          } else if (sub.sourceType === 'atproto.shares' && sub.subjectDid) {
            keys.push(sharesSourceKey(sub.subjectDid));
          } else if (sub.sourceType === 'atproto.documents' && sub.subjectDid) {
            keys.push(documentsSourceKey(sub.subjectDid));
          }
        }
      }
      break;
    }
    case 'subscriptionTag': {
      const tagLower = rule.value.toLowerCase();
      for (const sub of subscriptions) {
        if (!sub.rkey) continue;
        if (sub.tags.some((t) => t.trim().toLowerCase() === tagLower)) {
          if (!sub.sourceType || sub.sourceType === 'rss') {
            keys.push(rssSourceKey(sub.rkey));
          } else if (sub.sourceType === 'atproto.shares' && sub.subjectDid) {
            keys.push(sharesSourceKey(sub.subjectDid));
          } else if (sub.sourceType === 'atproto.documents' && sub.subjectDid) {
            keys.push(documentsSourceKey(sub.subjectDid));
          }
        }
      }
      break;
    }
    case 'domain': {
      for (const sub of subscriptions) {
        if (!sub.rkey) continue;
        if (sub.sourceType && sub.sourceType !== 'rss') continue;
        const url = sub.feedUrl || sub.siteUrl;
        if (!url) continue;
        try {
          const hostname = new URL(url).hostname;
          if (rule.patterns.some((p) => hostname.includes(p))) {
            keys.push(rssSourceKey(sub.rkey));
          }
        } catch {
          continue;
        }
      }
      break;
    }
    case 'people': {
      for (const sub of subscriptions) {
        if (!sub.subjectDid) continue;
        if (sub.sourceType === 'atproto.shares') {
          keys.push(sharesSourceKey(sub.subjectDid));
        } else if (sub.sourceType === 'atproto.documents') {
          keys.push(documentsSourceKey(sub.subjectDid));
        }
      }
      break;
    }
    case 'frequency': {
      const stats = getArticleFrequencyByFeed(articles);
      for (const sub of subscriptions) {
        if (!sub.rkey || sub.id == null) continue;
        if (sub.sourceType && sub.sourceType !== 'rss') continue;
        const perDay = stats.get(sub.id) ?? 0;
        if (rule.threshold === 'high' && perDay >= 2) {
          keys.push(rssSourceKey(sub.rkey));
        } else if (rule.threshold === 'low' && perDay < 0.3 && perDay > 0) {
          keys.push(rssSourceKey(sub.rkey));
        }
      }
      break;
    }
    case 'longReads': {
      const lengths = getAvgContentLengthByFeed(articles);
      for (const sub of subscriptions) {
        if (!sub.rkey || sub.id == null) continue;
        if (sub.sourceType && sub.sourceType !== 'rss') continue;
        const avgLen = lengths.get(sub.id) ?? 0;
        if (avgLen >= rule.minLength) {
          keys.push(rssSourceKey(sub.rkey));
        }
      }
      break;
    }
    case 'recent': {
      const cutoff = Date.now() - rule.withinDays * 24 * 60 * 60 * 1000;
      for (const sub of subscriptions) {
        if (!sub.rkey) continue;
        const created = new Date(sub.createdAt).getTime();
        if (created >= cutoff) {
          if (!sub.sourceType || sub.sourceType === 'rss') {
            keys.push(rssSourceKey(sub.rkey));
          } else if (sub.sourceType === 'atproto.shares' && sub.subjectDid) {
            keys.push(sharesSourceKey(sub.subjectDid));
          } else if (sub.sourceType === 'atproto.documents' && sub.subjectDid) {
            keys.push(documentsSourceKey(sub.subjectDid));
          }
        }
      }
      break;
    }
  }

  return keys;
}

// ─── Channel suggestions (pure logic) ─────────────────────────────────

export interface ChannelSuggestion {
  id: string;
  name: string;
  description: string;
  sourceMode: 'all' | 'include';
  sourceKeys: string[];
  typeFilter: SubscriptionSourceType[];
  autoRule?: ChannelAutoRule;
}

export const MIN_SOURCES_FOR_SUGGESTION = 3;

/**
 * Check if an existing channel already covers a given set of source keys.
 * A channel "covers" sources if 70%+ of suggested sources overlap.
 */
export function isAlreadyCovered(
  sourceKeys: string[],
  typeFilter: SubscriptionSourceType[],
  views: FilteredView[]
): boolean {
  for (const view of views) {
    const viewSourceMode = view.sourceMode ?? 'all';
    const viewTypeFilter = view.typeFilter ?? [];

    if (viewSourceMode === 'all') {
      if (typeFilter.length > 0 && viewTypeFilter.length > 0) {
        if (typeFilter.every((t) => viewTypeFilter.includes(t))) return true;
      }
      if (typeFilter.length === 0 && viewTypeFilter.length === 0) return true;
    }

    if (viewSourceMode === 'include' && view.sourceKeys) {
      const viewKeySet = new Set(view.sourceKeys);
      const overlap = sourceKeys.filter((k) => viewKeySet.has(k));
      if (overlap.length >= sourceKeys.length * 0.7) return true;
    }
  }
  return false;
}

export interface SuggestionContext {
  subscriptions: Subscription[];
  articles: Article[];
  views: FilteredView[];
}

export function getCategorySuggestions(ctx: SuggestionContext): ChannelSuggestion[] {
  const byCategory = new Map<string, string[]>();

  for (const sub of ctx.subscriptions) {
    if (sub.category && sub.rkey) {
      const cat = sub.category.trim();
      if (!cat) continue;
      const existing = byCategory.get(cat) || [];
      existing.push(sub.rkey);
      byCategory.set(cat, existing);
    }
  }

  const suggestions: ChannelSuggestion[] = [];
  for (const [category, rkeys] of byCategory) {
    if (rkeys.length < MIN_SOURCES_FOR_SUGGESTION) continue;
    const sourceKeys = rkeys.map(rssSourceKey);
    if (isAlreadyCovered(sourceKeys, [], ctx.views)) continue;
    suggestions.push({
      id: `category:${category.toLowerCase()}`,
      name: category,
      description: `${rkeys.length} feeds from your "${category}" folder`,
      sourceMode: 'include',
      sourceKeys,
      typeFilter: [],
      autoRule: { type: 'category', value: category },
    });
  }
  return suggestions;
}

export function getTypeSuggestions(ctx: SuggestionContext): ChannelSuggestion[] {
  const suggestions: ChannelSuggestion[] = [];
  const subs = ctx.subscriptions;

  const rssSubs = subs.filter((s) => !s.sourceType || s.sourceType === 'rss');
  const shareSubs = subs.filter((s) => s.sourceType === 'atproto.shares');
  const docSubs = subs.filter((s) => s.sourceType === 'atproto.documents');
  const atprotoSubs = [...shareSubs, ...docSubs];

  if (rssSubs.length >= 2 && atprotoSubs.length >= 2) {
    if (!isAlreadyCovered([], ['rss'], ctx.views)) {
      suggestions.push({
        id: 'type:articles',
        name: 'Articles',
        description: `${rssSubs.length} RSS feeds, without social content`,
        sourceMode: 'all',
        sourceKeys: [],
        typeFilter: ['rss'],
      });
    }

    const socialTypes: SubscriptionSourceType[] = [];
    if (shareSubs.length > 0) socialTypes.push('atproto.shares');
    if (docSubs.length > 0) socialTypes.push('atproto.documents');

    if (socialTypes.length > 0 && !isAlreadyCovered([], socialTypes, ctx.views)) {
      suggestions.push({
        id: 'type:social',
        name: 'Social',
        description: `${atprotoSubs.length} people you follow`,
        sourceMode: 'all',
        sourceKeys: [],
        typeFilter: socialTypes,
      });
    }
  }
  return suggestions;
}

export function getTagSuggestions(ctx: SuggestionContext): ChannelSuggestion[] {
  const byTag = new Map<string, string[]>();

  for (const sub of ctx.subscriptions) {
    if (!sub.rkey) continue;
    for (const tag of sub.tags) {
      const t = tag.trim().toLowerCase();
      if (!t) continue;
      const existing = byTag.get(t) || [];
      existing.push(sub.rkey);
      byTag.set(t, existing);
    }
  }

  const suggestions: ChannelSuggestion[] = [];
  for (const [tag, rkeys] of byTag) {
    if (rkeys.length < MIN_SOURCES_FOR_SUGGESTION) continue;
    const sourceKeys = rkeys.map(rssSourceKey);
    if (isAlreadyCovered(sourceKeys, [], ctx.views)) continue;
    const displayName = tag.charAt(0).toUpperCase() + tag.slice(1);
    suggestions.push({
      id: `tag:${tag}`,
      name: displayName,
      description: `${rkeys.length} sources tagged "${tag}"`,
      sourceMode: 'include',
      sourceKeys,
      typeFilter: [],
      autoRule: { type: 'subscriptionTag', value: tag },
    });
  }
  return suggestions;
}

export function getPeopleSuggestion(ctx: SuggestionContext): ChannelSuggestion[] {
  const atprotoSubs = ctx.subscriptions.filter(
    (s) =>
      s.subjectDid && (s.sourceType === 'atproto.shares' || s.sourceType === 'atproto.documents')
  );
  if (atprotoSubs.length < MIN_SOURCES_FOR_SUGGESTION) return [];

  const sourceKeys: string[] = [];
  const seenDids = new Set<string>();
  for (const sub of atprotoSubs) {
    if (!sub.subjectDid) continue;
    if (sub.sourceType === 'atproto.shares') {
      sourceKeys.push(sharesSourceKey(sub.subjectDid));
    } else if (sub.sourceType === 'atproto.documents') {
      sourceKeys.push(documentsSourceKey(sub.subjectDid));
    }
    seenDids.add(sub.subjectDid);
  }
  if (isAlreadyCovered(sourceKeys, [], ctx.views)) return [];

  return [
    {
      id: 'people:all',
      name: 'People I Follow',
      description: `${seenDids.size} people, all shares and articles`,
      sourceMode: 'include',
      sourceKeys,
      typeFilter: [],
      autoRule: { type: 'people' },
    },
  ];
}

// Known domain patterns for clustering
export const DOMAIN_CLUSTERS = [
  {
    name: 'Newsletters',
    id: 'domain:newsletters',
    description: 'Substack, Buttondown, and other newsletter platforms',
    patterns: [
      'substack.com',
      'buttondown.',
      'newsletter.',
      'mailchi.mp',
      'beehiiv.com',
      'ghost.io',
      'convertkit.com',
    ],
  },
  {
    name: 'Podcasts',
    id: 'domain:podcasts',
    description: 'Podcast feeds',
    patterns: [
      'anchor.fm',
      'transistor.fm',
      'buzzsprout.com',
      'simplecast.com',
      'megaphone.fm',
      'podcast',
      'libsyn.com',
      'podbean.com',
    ],
  },
  {
    name: 'Reddit',
    id: 'domain:reddit',
    description: 'Reddit feeds',
    patterns: ['reddit.com'],
  },
  {
    name: 'GitHub',
    id: 'domain:github',
    description: 'GitHub release and activity feeds',
    patterns: ['github.com', 'github.io'],
  },
] as const;

export function getDomainSuggestions(ctx: SuggestionContext): ChannelSuggestion[] {
  const suggestions: ChannelSuggestion[] = [];
  const subs = ctx.subscriptions.filter(
    (s) => (!s.sourceType || s.sourceType === 'rss') && s.rkey
  );

  for (const cluster of DOMAIN_CLUSTERS) {
    const matchingRkeys: string[] = [];
    for (const sub of subs) {
      const url = sub.feedUrl || sub.siteUrl;
      if (!url) continue;
      try {
        const hostname = new URL(url).hostname;
        if (cluster.patterns.some((p) => hostname.includes(p))) {
          matchingRkeys.push(sub.rkey);
        }
      } catch {
        continue;
      }
    }
    if (matchingRkeys.length < MIN_SOURCES_FOR_SUGGESTION) continue;
    const sourceKeys = matchingRkeys.map(rssSourceKey);
    if (isAlreadyCovered(sourceKeys, [], ctx.views)) continue;
    suggestions.push({
      id: cluster.id,
      name: cluster.name,
      description: `${matchingRkeys.length} ${cluster.description.toLowerCase()}`,
      sourceMode: 'include',
      sourceKeys,
      typeFilter: [],
      autoRule: { type: 'domain', patterns: [...cluster.patterns] },
    });
  }
  return suggestions;
}

export function getFrequencySuggestions(ctx: SuggestionContext): ChannelSuggestion[] {
  const suggestions: ChannelSuggestion[] = [];
  const subs = ctx.subscriptions.filter(
    (s) => (!s.sourceType || s.sourceType === 'rss') && s.rkey && s.id != null
  );
  if (subs.length < 4) return [];

  const now = Date.now();
  const windowMs = 14 * 24 * 60 * 60 * 1000;
  const cutoff = now - windowMs;
  const days = 14;
  const counts = new Map<number, number>();

  for (const article of ctx.articles) {
    const pubTime = new Date(article.publishedAt).getTime();
    if (pubTime < cutoff) continue;
    counts.set(article.subscriptionId, (counts.get(article.subscriptionId) || 0) + 1);
  }

  const highFreqRkeys: string[] = [];
  const lowFreqRkeys: string[] = [];
  for (const sub of subs) {
    const count = counts.get(sub.id!) || 0;
    const perDay = count / days;
    if (perDay >= 2) highFreqRkeys.push(sub.rkey);
    else if (perDay > 0 && perDay < 0.3) lowFreqRkeys.push(sub.rkey);
  }

  if (highFreqRkeys.length >= MIN_SOURCES_FOR_SUGGESTION) {
    const sourceKeys = highFreqRkeys.map(rssSourceKey);
    if (!isAlreadyCovered(sourceKeys, [], ctx.views)) {
      suggestions.push({
        id: 'frequency:high',
        name: 'Daily Digest',
        description: `${highFreqRkeys.length} high-volume feeds that publish multiple times per day`,
        sourceMode: 'include',
        sourceKeys,
        typeFilter: [],
        autoRule: { type: 'frequency', threshold: 'high' },
      });
    }
  }

  if (lowFreqRkeys.length >= MIN_SOURCES_FOR_SUGGESTION) {
    const sourceKeys = lowFreqRkeys.map(rssSourceKey);
    if (!isAlreadyCovered(sourceKeys, [], ctx.views)) {
      suggestions.push({
        id: 'frequency:low',
        name: "Don't Miss",
        description: `${lowFreqRkeys.length} feeds that publish infrequently — every post counts`,
        sourceMode: 'include',
        sourceKeys,
        typeFilter: [],
        autoRule: { type: 'frequency', threshold: 'low' },
      });
    }
  }
  return suggestions;
}

export function getLongReadsSuggestion(ctx: SuggestionContext): ChannelSuggestion[] {
  const MIN_AVG_LENGTH = 5000;
  const subs = ctx.subscriptions.filter(
    (s) => (!s.sourceType || s.sourceType === 'rss') && s.rkey && s.id != null
  );

  const totals = new Map<number, { sum: number; count: number }>();
  for (const article of ctx.articles) {
    const text = article.content || article.summary;
    if (!text) continue;
    const existing = totals.get(article.subscriptionId) || { sum: 0, count: 0 };
    existing.sum += text.length;
    existing.count++;
    totals.set(article.subscriptionId, existing);
  }

  const longReadRkeys: string[] = [];
  for (const sub of subs) {
    const stats = totals.get(sub.id!);
    if (!stats || stats.count < 2) continue;
    if (stats.sum / stats.count >= MIN_AVG_LENGTH) {
      longReadRkeys.push(sub.rkey);
    }
  }

  if (longReadRkeys.length < MIN_SOURCES_FOR_SUGGESTION) return [];
  const sourceKeys = longReadRkeys.map(rssSourceKey);
  if (isAlreadyCovered(sourceKeys, [], ctx.views)) return [];

  return [
    {
      id: 'content:longreads',
      name: 'Long Reads',
      description: `${longReadRkeys.length} feeds with in-depth, long-form articles`,
      sourceMode: 'include',
      sourceKeys,
      typeFilter: [],
      autoRule: { type: 'longReads', minLength: MIN_AVG_LENGTH },
    },
  ];
}

export function getRecentSuggestion(
  ctx: SuggestionContext,
  withinDays: number = 14
): ChannelSuggestion[] {
  const cutoff = Date.now() - withinDays * 24 * 60 * 60 * 1000;
  const recentKeys: string[] = [];

  for (const sub of ctx.subscriptions) {
    if (!sub.rkey) continue;
    const created = new Date(sub.createdAt).getTime();
    if (created < cutoff) continue;
    if (!sub.sourceType || sub.sourceType === 'rss') {
      recentKeys.push(rssSourceKey(sub.rkey));
    } else if (sub.sourceType === 'atproto.shares' && sub.subjectDid) {
      recentKeys.push(sharesSourceKey(sub.subjectDid));
    } else if (sub.sourceType === 'atproto.documents' && sub.subjectDid) {
      recentKeys.push(documentsSourceKey(sub.subjectDid));
    }
  }

  if (recentKeys.length < MIN_SOURCES_FOR_SUGGESTION) return [];
  if (isAlreadyCovered(recentKeys, [], ctx.views)) return [];

  return [
    {
      id: 'recent:new',
      name: 'New Sources',
      description: `${recentKeys.length} sources added in the last 2 weeks`,
      sourceMode: 'include',
      sourceKeys: recentKeys,
      typeFilter: [],
      autoRule: { type: 'recent', withinDays },
    },
  ];
}

/** Priority order for suggestion sorting (lower = shown first). */
const PRIORITY: Record<string, number> = {
  'frequency:high': 1,
  'frequency:low': 2,
  'content:longreads': 3,
  'people:all': 4,
  'type:articles': 5,
  'type:social': 6,
  'recent:new': 7,
};

export function getSuggestionPriority(id: string): number {
  if (PRIORITY[id] != null) return PRIORITY[id];
  if (id.startsWith('category:')) return 10;
  if (id.startsWith('tag:')) return 11;
  if (id.startsWith('domain:')) return 12;
  return 20;
}

/**
 * Generate all channel suggestions, filtering out dismissed ones,
 * sorted by priority.
 */
export function generateAllSuggestions(
  ctx: SuggestionContext,
  dismissedIds: Set<string>
): ChannelSuggestion[] {
  const all = [
    ...getCategorySuggestions(ctx),
    ...getTypeSuggestions(ctx),
    ...getTagSuggestions(ctx),
    ...getPeopleSuggestion(ctx),
    ...getDomainSuggestions(ctx),
    ...getFrequencySuggestions(ctx),
    ...getLongReadsSuggestion(ctx),
    ...getRecentSuggestion(ctx),
  ];

  return all
    .filter((s) => !dismissedIds.has(s.id))
    .sort((a, b) => getSuggestionPriority(a.id) - getSuggestionPriority(b.id));
}

// ─── Saved channel suggestions (pure logic) ─────────────────────────

export interface SavedChannelSuggestion {
  id: string;
  name: string;
  description: string;
  savedSourceFilter?: SavedSourceType[];
  savedDateFilter?: DateAddedPreset;
  savedReadingLength?: ReadingLengthFilter[];
  savedDomainFilter?: string[];
  readFilter?: 'all' | 'unread' | 'read';
  sortOrder?: SortOrder;
}

export interface SavedSuggestionContext {
  savedItems: SavedItem[];
  views: FilteredView[];
}

const MIN_SAVED_FOR_SUGGESTION = 3;

// Reading length thresholds (matches feedView.svelte.ts WPM=200)
const QUICK_MAX_WORDS = 1000; // < 5 min
const LONG_MIN_WORDS = 3000; // >= 15 min

function isSavedSuggestionCovered(
  suggestion: {
    savedSourceFilter?: SavedSourceType[];
    savedReadingLength?: ReadingLengthFilter[];
    savedDomainFilter?: string[];
  },
  views: FilteredView[]
): boolean {
  const savedViews = views.filter((v) => v.mode === 'saved');
  for (const view of savedViews) {
    // Source filter match
    if (suggestion.savedSourceFilter && suggestion.savedSourceFilter.length > 0) {
      const viewSources = view.savedSourceFilter ?? [];
      if (
        viewSources.length > 0 &&
        suggestion.savedSourceFilter.every((s) => viewSources.includes(s))
      ) {
        return true;
      }
    }
    // Reading length match
    if (suggestion.savedReadingLength && suggestion.savedReadingLength.length > 0) {
      const viewLengths = view.savedReadingLength ?? [];
      if (
        viewLengths.length > 0 &&
        suggestion.savedReadingLength.every((l) => viewLengths.includes(l))
      ) {
        return true;
      }
    }
    // Domain match
    if (suggestion.savedDomainFilter && suggestion.savedDomainFilter.length > 0) {
      const viewDomains = new Set(view.savedDomainFilter ?? []);
      if (viewDomains.size > 0) {
        const overlap = suggestion.savedDomainFilter.filter((d) => viewDomains.has(d));
        if (overlap.length >= suggestion.savedDomainFilter.length * 0.7) return true;
      }
    }
    // A generic saved channel with no filters covers a generic suggestion
    if (
      !suggestion.savedSourceFilter?.length &&
      !suggestion.savedReadingLength?.length &&
      !suggestion.savedDomainFilter?.length
    ) {
      const noFilters =
        !view.savedSourceFilter?.length &&
        !view.savedReadingLength?.length &&
        !view.savedDomainFilter?.length;
      if (noFilters) return true;
    }
  }
  return false;
}

export function getSavedSourceTypeSuggestions(
  ctx: SavedSuggestionContext
): SavedChannelSuggestion[] {
  const suggestions: SavedChannelSuggestion[] = [];
  const bySource = new Map<SavedSourceType, number>();

  for (const item of ctx.savedItems) {
    const src = item.source ?? 'url';
    bySource.set(src, (bySource.get(src) ?? 0) + 1);
  }

  // Only suggest source filters if the user saves from multiple source types
  if (bySource.size < 2) return [];

  const sourceConfigs: { source: SavedSourceType; name: string; desc: string }[] = [
    { source: 'feed', name: 'Saved from Feeds', desc: 'articles saved from your RSS feeds' },
    { source: 'url', name: 'Saved from Web', desc: 'pages saved by URL' },
    { source: 'share', name: 'Saved Shares', desc: 'shared articles you bookmarked' },
    { source: 'document', name: 'Saved Documents', desc: 'published documents you bookmarked' },
  ];

  for (const cfg of sourceConfigs) {
    const count = bySource.get(cfg.source) ?? 0;
    if (count < MIN_SAVED_FOR_SUGGESTION) continue;
    const filter = { savedSourceFilter: [cfg.source] };
    if (isSavedSuggestionCovered(filter, ctx.views)) continue;
    suggestions.push({
      id: `saved:source-${cfg.source}`,
      name: cfg.name,
      description: `${count} ${cfg.desc}`,
      savedSourceFilter: [cfg.source],
      readFilter: 'all',
      sortOrder: 'newest',
    });
  }
  return suggestions;
}

export function getSavedReadingLengthSuggestions(
  ctx: SavedSuggestionContext
): SavedChannelSuggestion[] {
  const suggestions: SavedChannelSuggestion[] = [];
  let longCount = 0;
  let quickCount = 0;

  for (const item of ctx.savedItems) {
    if (item.wordCount == null) continue;
    if (item.wordCount >= LONG_MIN_WORDS) longCount++;
    if (item.wordCount < QUICK_MAX_WORDS && item.wordCount > 0) quickCount++;
  }

  if (longCount >= MIN_SAVED_FOR_SUGGESTION) {
    const filter = { savedReadingLength: ['long' as ReadingLengthFilter] };
    if (!isSavedSuggestionCovered(filter, ctx.views)) {
      suggestions.push({
        id: 'saved:long-reads',
        name: 'Saved Long Reads',
        description: `${longCount} saved items with 15+ minute read time`,
        savedReadingLength: ['long'],
        readFilter: 'all',
        sortOrder: 'longest',
      });
    }
  }

  if (quickCount >= MIN_SAVED_FOR_SUGGESTION) {
    const filter = { savedReadingLength: ['quick' as ReadingLengthFilter] };
    if (!isSavedSuggestionCovered(filter, ctx.views)) {
      suggestions.push({
        id: 'saved:quick-reads',
        name: 'Saved Quick Reads',
        description: `${quickCount} saved items you can finish in under 5 minutes`,
        savedReadingLength: ['quick'],
        readFilter: 'all',
        sortOrder: 'shortest',
      });
    }
  }

  return suggestions;
}

export function getSavedDomainSuggestions(ctx: SavedSuggestionContext): SavedChannelSuggestion[] {
  const domainCounts = new Map<string, number>();

  for (const item of ctx.savedItems) {
    if (!item.domain) continue;
    domainCounts.set(item.domain, (domainCounts.get(item.domain) ?? 0) + 1);
  }

  const suggestions: SavedChannelSuggestion[] = [];
  for (const [domain, count] of domainCounts) {
    if (count < MIN_SAVED_FOR_SUGGESTION) continue;
    const filter = { savedDomainFilter: [domain] };
    if (isSavedSuggestionCovered(filter, ctx.views)) continue;
    // Clean up domain for display name
    const displayName = domain.replace(/^www\./, '');
    suggestions.push({
      id: `saved:domain-${domain}`,
      name: `Saved from ${displayName}`,
      description: `${count} saved items from ${displayName}`,
      savedDomainFilter: [domain],
      readFilter: 'all',
      sortOrder: 'newest',
    });
  }

  // Sort by count descending, take top 3
  return suggestions
    .sort((a, b) => {
      const countA = domainCounts.get(a.savedDomainFilter![0]) ?? 0;
      const countB = domainCounts.get(b.savedDomainFilter![0]) ?? 0;
      return countB - countA;
    })
    .slice(0, 3);
}

const SAVED_PRIORITY: Record<string, number> = {
  'saved:source-feed': 1,
  'saved:source-url': 2,
  'saved:long-reads': 3,
  'saved:quick-reads': 4,
  'saved:source-share': 5,
  'saved:source-document': 6,
};

export function getSavedSuggestionPriority(id: string): number {
  if (SAVED_PRIORITY[id] != null) return SAVED_PRIORITY[id];
  if (id.startsWith('saved:domain-')) return 10;
  return 20;
}

export function generateAllSavedSuggestions(
  ctx: SavedSuggestionContext,
  dismissedIds: Set<string>
): SavedChannelSuggestion[] {
  if (ctx.savedItems.length < MIN_SAVED_FOR_SUGGESTION) return [];

  const all = [
    ...getSavedSourceTypeSuggestions(ctx),
    ...getSavedReadingLengthSuggestions(ctx),
    ...getSavedDomainSuggestions(ctx),
  ];

  return all
    .filter((s) => !dismissedIds.has(s.id))
    .sort((a, b) => getSavedSuggestionPriority(a.id) - getSavedSuggestionPriority(b.id));
}
