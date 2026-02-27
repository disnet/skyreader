export interface TierLimits {
  maxSubscriptions: number;
  maxUrlSavesPerMonth: number;
}

const TIER_MAP: Record<string, TierLimits> = {
  free: { maxSubscriptions: 100, maxUrlSavesPerMonth: 100 },
  supporter: { maxSubscriptions: 1000, maxUrlSavesPerMonth: 1000 },
};

export const ALL_TIERS = Object.keys(TIER_MAP);

export function isValidTier(tier: string): boolean {
  return tier in TIER_MAP;
}

export function getLimitsForTier(tier: string): TierLimits {
  return TIER_MAP[tier] ?? TIER_MAP.free;
}
