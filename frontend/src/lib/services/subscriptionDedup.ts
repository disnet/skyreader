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
