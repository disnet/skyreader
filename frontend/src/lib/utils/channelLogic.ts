/**
 * Pure functions for channel auto-update logic.
 * Extracted from stores so they can be unit-tested without Svelte reactivity.
 */

import { isArchiveFeedSource, isNewsletterSubscription } from '$lib/utils/newsletters';
import type { Subscription, Article, ChannelAutoRule } from '$lib/types';
import { rssSourceKey, documentsSourceKey } from '$lib/utils/sourceKeys';

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
    // Prefer the precomputed length — the body is stripped from in-memory rows.
    const len = article.contentLength ?? (article.content || article.summary || '').length;
    if (!len) continue;
    const existing = totals.get(article.subscriptionId) || { sum: 0, count: 0 };
    existing.sum += len;
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
          if (isArchiveFeedSource(sub.sourceType)) {
            keys.push(rssSourceKey(sub.rkey));
          } else if (sub.sourceType === 'atproto.documents' && sub.subjectDid) {
            keys.push(documentsSourceKey(sub.rkey));
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
          if (isArchiveFeedSource(sub.sourceType)) {
            keys.push(rssSourceKey(sub.rkey));
          } else if (sub.sourceType === 'atproto.documents' && sub.subjectDid) {
            keys.push(documentsSourceKey(sub.rkey));
          }
        }
      }
      break;
    }
    case 'domain': {
      for (const sub of subscriptions) {
        if (!sub.rkey) continue;
        if (!isArchiveFeedSource(sub.sourceType)) continue;
        if (matchesDomainPatterns(sub, rule.patterns)) keys.push(rssSourceKey(sub.rkey));
      }
      break;
    }
    case 'people': {
      for (const sub of subscriptions) {
        if (!sub.rkey || !sub.subjectDid) continue;
        if (sub.sourceType === 'atproto.documents') {
          keys.push(documentsSourceKey(sub.rkey));
        }
      }
      break;
    }
    case 'frequency': {
      const stats = getArticleFrequencyByFeed(articles);
      for (const sub of subscriptions) {
        if (!sub.rkey || sub.id == null) continue;
        if (!isArchiveFeedSource(sub.sourceType)) continue;
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
        if (!isArchiveFeedSource(sub.sourceType)) continue;
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
          if (isArchiveFeedSource(sub.sourceType)) {
            keys.push(rssSourceKey(sub.rkey));
          } else if (sub.sourceType === 'atproto.documents' && sub.subjectDid) {
            keys.push(documentsSourceKey(sub.rkey));
          }
        }
      }
      break;
    }
  }

  return keys;
}

// ─── Domain rule matching ─────────────────────────────────────────────

// In a domain rule's patterns, stands for "every email newsletter": a newsletter
// has no feed host to match, and whatever platform it's sent from, it belongs
// in the Newsletters channel.
export const NEWSLETTER_EMAIL_PATTERN = 'newsletter:';

/**
 * Does this subscription belong to a domain cluster? A feed matches on its feed
 * (or site) host; an email newsletter on its sender's site, or on the
 * newsletter pattern itself.
 */
function matchesDomainPatterns(sub: Subscription, patterns: readonly string[]): boolean {
  const newsletter = isNewsletterSubscription(sub);
  if (newsletter && patterns.includes(NEWSLETTER_EMAIL_PATTERN)) return true;
  const url = newsletter ? sub.siteUrl : sub.feedUrl || sub.siteUrl;
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname;
    return (
      !!hostname && patterns.some((p) => p !== NEWSLETTER_EMAIL_PATTERN && hostname.includes(p))
    );
  } catch {
    return false;
  }
}
