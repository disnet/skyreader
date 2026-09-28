export interface TierLimits {
  /** Feeds Skyreader actively services (polls + shows). Overflow is parked. */
  maxSubscriptions: number;
  /**
   * Hard ceiling on total mirrored rows (active + parked) we'll materialize in
   * D1 for one user. Parked feeds are otherwise unbounded — a user with a huge
   * PDS subscription collection could mirror tens of thousands of rows — so this
   * caps storage/write cost. Records beyond it are dropped (not mirrored); they
   * still live on the PDS and re-appear if the user frees room or upgrades.
   */
  maxMirroredSubscriptions: number;
  maxUrlSavesPerMonth: number;
  /**
   * A private email address whose mail lands in the reader as newsletter
   * subscriptions (services/newsletters.ts). Checked when the address is issued
   * and again on every inbound message, so a lapsed plan stops ingesting.
   */
  newsletterInbox: boolean;
}

const TIER_MAP: Record<string, TierLimits> = {
  free: {
    maxSubscriptions: 100,
    maxMirroredSubscriptions: 1000,
    maxUrlSavesPerMonth: 100,
    newsletterInbox: false,
  },
  supporter: {
    maxSubscriptions: 1000,
    maxMirroredSubscriptions: 5000,
    maxUrlSavesPerMonth: 1000,
    newsletterInbox: true,
  },
};

export const ALL_TIERS = Object.keys(TIER_MAP);

export function isValidTier(tier: string): boolean {
  return tier in TIER_MAP;
}

export function getLimitsForTier(tier: string): TierLimits {
  return TIER_MAP[tier] ?? TIER_MAP.free;
}
