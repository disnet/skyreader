import type { Subscription } from '$lib/types';

/**
 * Subscription de-duplication helpers.
 *
 * Two distinct duplicate classes can arise when adding subscriptions:
 *
 *  1. Same rkey — the user's own add() and a background sync both insert the
 *     same AT Protocol record (which share an rkey) off stale snapshots.
 *  2. Same feed, different rkey — two concurrent adds of the same feed each
 *     mint their own rkey before either has persisted locally.
 *
 * These helpers are pure / framework-free so they can be unit tested and
 * reused by the liveDb cache and the subscriptions store.
 */

/**
 * Remove subscriptions that share an rkey, keeping the first occurrence and
 * reporting the ids of the rows that should be deleted. rkey is the canonical
 * AT Protocol record identity, so two rows with the same rkey are always the
 * same subscription. Rows without an rkey are always kept.
 */
export function dedupeSubscriptionsByRkey<T extends Pick<Subscription, 'rkey' | 'id'>>(
  subs: T[]
): { kept: T[]; dupeIds: number[] } {
  const seen = new Set<string>();
  const kept: T[] = [];
  const dupeIds: number[] = [];
  for (const sub of subs) {
    if (sub.rkey && seen.has(sub.rkey)) {
      if (sub.id != null) dupeIds.push(sub.id);
      continue;
    }
    if (sub.rkey) seen.add(sub.rkey);
    kept.push(sub);
  }
  return { kept, dupeIds };
}

/**
 * Stable identity key for an add request, used to detect a duplicate while the
 * first add is still in flight (before it has been persisted locally).
 *
 * RSS feeds are keyed by their (case-insensitive) URL; AT Protocol streams by
 * sourceType + subjectDid + publication URI.
 */
export function subscriptionDedupKey(input: {
  sourceType?: string;
  subjectDid?: string;
  feedUrl?: string;
}): string {
  const isAtProto = !!input.sourceType && input.sourceType.startsWith('atproto.');
  if (isAtProto) {
    return `atproto:${input.sourceType}:${input.subjectDid}:${input.feedUrl || ''}`;
  }
  return `rss:${(input.feedUrl || '').toLowerCase()}`;
}

type FeedIdentity = {
  sourceType?: string;
  subjectDid?: string;
  feedUrl?: string;
};

/**
 * Feed identity for a subscription, or null when it has none (an RSS row with
 * no feedUrl that isn't an atproto stream). Rows without an identity can never
 * be proven duplicates of each other, so they're left untouched.
 */
function feedIdentity(sub: FeedIdentity): string | null {
  const isAtProto = !!sub.sourceType && sub.sourceType.startsWith('atproto.');
  if (!isAtProto && !sub.feedUrl) return null;
  return subscriptionDedupKey({
    sourceType: sub.sourceType,
    subjectDid: sub.subjectDid,
    feedUrl: sub.feedUrl,
  });
}

/**
 * True when `a` is older than `b`, by createdAt and then by ascending id. Used
 * to pick the original row to keep among same-feed duplicates — the later
 * (racing) add is the one we drop.
 */
function isOlder(
  a: { createdAt?: string; id?: number },
  b: { createdAt?: string; id?: number }
): boolean {
  const ta = a.createdAt ? Date.parse(a.createdAt) : NaN;
  const tb = b.createdAt ? Date.parse(b.createdAt) : NaN;
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta < tb;
  return (a.id ?? Infinity) < (b.id ?? Infinity);
}

/**
 * Remove subscriptions that point at the same underlying feed but carry
 * different rkeys — the "same feed, different rkey" class (bug 2). These slip
 * past dedupeSubscriptionsByRkey because each duplicate is a distinct AT
 * Protocol record. They arise when two adds of one feed each mint their own
 * rkey: a concurrent add the in-flight guard didn't serialize, or the same feed
 * added on two devices (two PDS records).
 *
 * Identity is `feedIdentity`; the row kept per feed is the oldest (the original
 * add), with later duplicates reported for deletion. Original array order is
 * preserved for the kept rows. Rows without a feed identity are always kept.
 */
export function dedupeSubscriptionsByFeed<
  T extends Pick<
    Subscription,
    'rkey' | 'id' | 'createdAt' | 'sourceType' | 'subjectDid' | 'feedUrl'
  >,
>(subs: T[]): { kept: T[]; dupeIds: number[] } {
  // Pass 1: pick the canonical (oldest) row for each feed identity.
  const canonical = new Map<string, T>();
  for (const sub of subs) {
    const key = feedIdentity(sub);
    if (!key) continue;
    const current = canonical.get(key);
    if (!current || isOlder(sub, current)) canonical.set(key, sub);
  }

  // Pass 2: emit canonical + identity-less rows in original order; drop the rest.
  const kept: T[] = [];
  const dupeIds: number[] = [];
  for (const sub of subs) {
    const key = feedIdentity(sub);
    if (!key || canonical.get(key) === sub) {
      kept.push(sub);
    } else if (sub.id != null) {
      dupeIds.push(sub.id);
    }
  }
  return { kept, dupeIds };
}

/**
 * Collapse PDS subscription records that point at the same feed but carry
 * different rkeys, keeping the oldest record and reporting the rkeys of the
 * redundant ones so the caller can delete them from the PDS. Deterministic:
 * ties on createdAt break by ascending rkey (no clock dependency).
 */
export function dedupeRemoteSubscriptionRecords<V extends FeedIdentity & { createdAt?: string }>(
  records: Array<{ rkey: string; value: V }>
): { duplicateRkeys: string[] } {
  const canonical = new Map<string, { rkey: string; value: V }>();
  const duplicateRkeys: string[] = [];
  for (const rec of records) {
    const key = feedIdentity(rec.value);
    if (!key) continue;
    const current = canonical.get(key);
    if (!current) {
      canonical.set(key, rec);
      continue;
    }
    const recIsOlder =
      isOlder({ createdAt: rec.value.createdAt }, { createdAt: current.value.createdAt }) ||
      (rec.value.createdAt === current.value.createdAt && rec.rkey < current.rkey);
    const [keep, drop] = recIsOlder ? [rec, current] : [current, rec];
    canonical.set(key, keep);
    duplicateRkeys.push(drop.rkey);
  }
  return { duplicateRkeys };
}

/**
 * Normalize a site URL to a comparable host: lowercased hostname with a leading
 * `www.` stripped. Returns null for a missing or unparseable URL (which can
 * never match anything).
 */
export function normalizeSiteHost(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

export interface CrossTypeDuplicate {
  /** The RSS subscription (sourceType undefined or 'rss'). */
  rss: Subscription;
  /** The standard.site document stream (sourceType 'atproto.documents'). */
  standard: Subscription;
  /** A shared normalized host that links the two. */
  host: string;
}

/** Cross-type bucket a subscription belongs to, or null if it never cross-matches. */
type CrossTypeKind = 'rss' | 'standard' | null;

/**
 * Which side of a cross-type duplicate a subscription can be. RSS feeds
 * (sourceType undefined or 'rss') and standard.site document streams
 * (`atproto.documents`) are the only two that describe the same publication
 * from different sources; every other atproto stream type (collections,
 * linkblogs, …) never cross-matches.
 */
function crossTypeKind(sub: Pick<Subscription, 'sourceType'>): CrossTypeKind {
  if (sub.sourceType === 'atproto.documents') return 'standard';
  if (!sub.sourceType || sub.sourceType === 'rss') return 'rss';
  return null;
}

/**
 * Every normalized host a subscription occupies — the single source of truth
 * for cross-type matching. A subscription "is" all of these hosts at once:
 *
 *  - `siteUrl` host: the resolved public website. Both an RSS feed (once its
 *    metadata resolves) and a standard.site publication carry one.
 *  - `feedUrl` host: an RSS feed's URL host. Present the instant the sub is
 *    created — before its feed resolves a `siteUrl` — so it's the only bridge
 *    for feeds added before siteUrl tracking existed. (A standard.site stream's
 *    feedUrl is an `at://` publication URI, which has no web host, so it
 *    contributes nothing here and the type matches purely on `siteUrl`.)
 *
 * Because BOTH the add-time check and the /sources scan derive hosts from this
 * one function, they can never disagree about what counts as a duplicate.
 */
export function subscriptionHosts(sub: Pick<Subscription, 'siteUrl' | 'feedUrl'>): Set<string> {
  const hosts = new Set<string>();
  for (const host of [normalizeSiteHost(sub.siteUrl), normalizeSiteHost(sub.feedUrl)]) {
    if (host) hosts.add(host);
  }
  return hosts;
}

/** First host present in both sets, or null. The shared host of a duplicate. */
function sharedHost(a: Set<string>, b: Set<string>): string | null {
  for (const host of a) {
    if (b.has(host)) return host;
  }
  return null;
}

/**
 * Find publications the user follows twice: once by RSS and once as a
 * standard.site document stream. The two carry disjoint feed identities — an
 * http `feedUrl` vs an `at://` publication URI — so dedupeSubscriptionsByFeed
 * never relates them. Their bridge is a shared web host (see subscriptionHosts).
 *
 * Matching is full-host equality (not apex): per-author subdomains
 * (foo.substack.com vs bar.substack.com) stay distinct, so shared hosting
 * platforms don't false-positive. Apex-shared hosts remain a small residual
 * risk, which is why callers must confirm before unifying.
 *
 * Each standard.site stream is paired with the oldest matching RSS sub (the one
 * a racing add wouldn't have replaced).
 */
export function findCrossTypeDuplicates(subs: Subscription[]): CrossTypeDuplicate[] {
  // Index every RSS sub under each host it occupies; oldest wins per host.
  const rssByHost = new Map<string, Subscription>();
  for (const s of subs) {
    if (crossTypeKind(s) !== 'rss') continue;
    for (const host of subscriptionHosts(s)) {
      const current = rssByHost.get(host);
      if (!current || isOlder(s, current)) rssByHost.set(host, s);
    }
  }

  const pairs: CrossTypeDuplicate[] = [];
  for (const s of subs) {
    if (crossTypeKind(s) !== 'standard') continue;
    // A standard sub may share more than one host with the same RSS sub; emit
    // the first match only, so each standard sub yields at most one pair.
    for (const host of subscriptionHosts(s)) {
      const rss = rssByHost.get(host);
      if (rss) {
        pairs.push({ rss, standard: s, host });
        break;
      }
    }
  }
  return pairs;
}

/**
 * Cross-type duplicates a freshly-added subscription forms with existing subs.
 * Uses the same host-set definition (subscriptionHosts) and the same kind/host
 * matching as findCrossTypeDuplicates, so the add-time warning and the /sources
 * notice can never disagree.
 *
 * `added` is matched by its OWN hosts — its feedUrl host is set the moment it's
 * created, even before siteUrl resolves — so no host needs to be passed in.
 * Returns one pair per existing subscription of the opposite type that shares a
 * host; `added` itself is excluded by id.
 */
export function crossTypeDuplicatesForAdded(
  subs: Subscription[],
  added: Subscription
): CrossTypeDuplicate[] {
  const addedKind = crossTypeKind(added);
  if (addedKind === null) return [];
  const addedHosts = subscriptionHosts(added);
  if (addedHosts.size === 0) return [];

  const pairs: CrossTypeDuplicate[] = [];
  for (const s of subs) {
    if (s.id != null && s.id === added.id) continue;
    const kind = crossTypeKind(s);
    if (kind === null || kind === addedKind) continue; // need the opposite type
    const host = sharedHost(addedHosts, subscriptionHosts(s));
    if (!host) continue;
    pairs.push(
      addedKind === 'standard'
        ? { rss: s, standard: added, host }
        : { rss: added, standard: s, host }
    );
  }
  return pairs;
}

/** Raised when a second operation for an already-in-flight key is attempted. */
export class DuplicateInFlightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateInFlightError';
  }
}

/**
 * Guard that serializes/rejects concurrent operations sharing a key. The first
 * call for a key runs; a second call while the first is still in flight throws
 * `DuplicateInFlightError` before any side effects occur. The key is released
 * once the operation settles (success or failure).
 */
export function createInFlightGuard() {
  const inFlight = new Set<string>();
  return {
    isInFlight(key: string): boolean {
      return inFlight.has(key);
    },
    async run<T>(key: string, error: string, fn: () => Promise<T>): Promise<T> {
      if (inFlight.has(key)) {
        throw new DuplicateInFlightError(error);
      }
      inFlight.add(key);
      try {
        return await fn();
      } finally {
        inFlight.delete(key);
      }
    },
  };
}
