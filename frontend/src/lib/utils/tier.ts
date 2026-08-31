import type { User } from '$lib/types';

/**
 * Two ways to be a Supporter: a paid Polar plan, or a tier granted by hand.
 * Every supporter from before Skyreader had paid plans is the granted kind, and
 * they keep it: the grant is recorded server-side as `grantedTier` and survives
 * anything Polar does (see backend migration 0075).
 *
 * The distinction is load-bearing in the UI. A granted supporter has no Polar
 * customer, so the billing portal 404s for them, and they must never be sold
 * something they already have for free.
 */

/** The tier was paid for through Polar (subscription or one-time order). */
export function isPaidTier(user: User | null | undefined): boolean {
  return user?.tierSource === 'polar_subscription' || user?.tierSource === 'polar_order';
}

/** Supporter access the user was given, not billed for. */
export function isGrantedSupporter(user: User | null | undefined): boolean {
  return user?.tier === 'supporter' && !isPaidTier(user);
}

/** A paying user who also holds a grant to fall back on if they ever cancel. */
export function hasGrantFallback(user: User | null | undefined): boolean {
  return isPaidTier(user) && !!user?.grantedTier;
}
