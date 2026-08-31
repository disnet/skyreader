import type { Env } from '../types';
import { getLimitsForTier, type TierLimits } from '../config/tier-limits';

/**
 * Where users.tier came from (migration 0073), plus the tier the user keeps for
 * free if Polar ever stops paying for them (migration 0075). 'admin' and null
 * both mean a hand-granted tier; only the 'polar_' sources are paid.
 */
export type TierSource = 'admin' | 'polar_order' | 'polar_subscription' | null;

export interface UserTierInfo {
  tier: string;
  tierSource: TierSource;
  /** Non-null when the user keeps this tier at no charge, paid plan or not. */
  grantedTier: string | null;
}

export async function getUserTierInfo(env: Env, did: string): Promise<UserTierInfo> {
  const row = await env.DB.prepare(
    'SELECT tier, tier_source, granted_tier FROM users WHERE did = ?'
  )
    .bind(did)
    .first<{ tier: string | null; tier_source: string | null; granted_tier: string | null }>();
  return {
    tier: row?.tier ?? 'free',
    tierSource: (row?.tier_source ?? null) as TierSource,
    grantedTier: row?.granted_tier ?? null,
  };
}

export async function getUserTier(env: Env, did: string): Promise<string> {
  const row = await env.DB.prepare('SELECT tier FROM users WHERE did = ?')
    .bind(did)
    .first<{ tier: string }>();
  return row?.tier ?? 'free';
}

export async function getUserTierLimits(env: Env, did: string): Promise<TierLimits> {
  const tier = await getUserTier(env, did);
  return getLimitsForTier(tier);
}
