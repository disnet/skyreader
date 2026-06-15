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
  /** The shared normalized site host that links the two. */
  host: string;
}

/**
 * Find publications the user follows twice: once by RSS and once as a
 * standard.site document stream. The two carry disjoint feed identities — an
 * http `feedUrl` vs an `at://` publication URI — so dedupeSubscriptionsByFeed
 * never relates them. Their only bridge is the website host (`siteUrl`).
 *
 * Matching is full-host equality on the normalized `siteUrl`. Full-host (not
 * apex) is deliberate: per-author subdomains (foo.substack.com vs
 * bar.substack.com) stay distinct, so shared hosting platforms don't
 * false-positive. Apex-shared hosts remain a small residual risk, which is why
 * callers must confirm before unifying.
 *
 * Each standard.site stream is paired with the oldest matching RSS sub. An RSS
 * sub is indexed by every host it exposes — its resolved site (`siteUrl`) and
 * its feed URL's host (`feedUrl`). The feedUrl host matters because a sub added
 * before siteUrl tracking existed has no `siteUrl`, so its feedUrl is the only
 * bridge; it's also the exact host the add screen matches on (it pairs on the
 * typed feed URL, not the not-yet-resolved siteUrl), so indexing both keeps the
 * /sources notices consistent with what the add flow already warns about.
 */
export function findCrossTypeDuplicates(subs: Subscription[]): CrossTypeDuplicate[] {
  // Index RSS subs by every host they expose, keeping the oldest per host (the
  // one a racing add wouldn't have replaced).
  const rssByHost = new Map<string, Subscription>();
  for (const s of subs) {
    if (s.sourceType && s.sourceType !== 'rss') continue;
    for (const host of [normalizeSiteHost(s.siteUrl), normalizeSiteHost(s.feedUrl)]) {
      if (!host) continue;
      const current = rssByHost.get(host);
      if (!current || isOlder(s, current)) rssByHost.set(host, s);
    }
  }

  const pairs: CrossTypeDuplicate[] = [];
  for (const s of subs) {
    if (s.sourceType !== 'atproto.documents') continue;
    const host = normalizeSiteHost(s.siteUrl);
    if (!host) continue;
    const rss = rssByHost.get(host);
    if (rss) pairs.push({ rss, standard: s, host });
  }
  return pairs;
}

/**
 * Cross-type pairs a freshly-added subscription forms with existing subs on the
 * same `host`. Used at add time, where findCrossTypeDuplicates can't be relied
 * on: an RSS sub is inserted before its feed resolves, so its stored `siteUrl`
 * is still empty and it wouldn't be indexed. The caller supplies `host`
 * explicitly (the host of the URL it just added) instead.
 *
 * Returns one pair per existing subscription of the opposite type on `host`.
 * `added` itself is excluded by id.
 */
export function crossTypePairsForHost(
  subs: Subscription[],
  added: Subscription,
  host: string
): CrossTypeDuplicate[] {
  const addedIsStandard = added.sourceType === 'atproto.documents';
  const pairs: CrossTypeDuplicate[] = [];
  for (const s of subs) {
    if (s.id != null && s.id === added.id) continue;
    if (normalizeSiteHost(s.siteUrl) !== host) continue;
    const sIsStandard = s.sourceType === 'atproto.documents';
    if (sIsStandard === addedIsStandard) continue; // need the opposite type
    pairs.push(
      addedIsStandard ? { rss: s, standard: added, host } : { rss: added, standard: s, host }
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
