import type { Env } from '../types';
import { getLimitsForTier, type TierLimits } from '../config/tier-limits';

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
