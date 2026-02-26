import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { getLimitsForTier, isValidTier, ALL_TIERS } from '../src/config/tier-limits';
import { getUserTier, getUserTierLimits } from '../src/services/user-tier';

const TEST_DID = 'did:plc:tiertest123';

describe('Tier Limits Config', () => {
  describe('getLimitsForTier', () => {
    it('returns free tier limits', () => {
      const limits = getLimitsForTier('free');
      expect(limits).toEqual({ maxSubscriptions: 100, maxUrlSavesPerMonth: 100 });
    });

    it('returns supporter tier limits', () => {
      const limits = getLimitsForTier('supporter');
      expect(limits).toEqual({
        maxSubscriptions: 1000,
        maxUrlSavesPerMonth: 1000,
      });
    });

    it('falls back to free for unknown tier', () => {
      const limits = getLimitsForTier('unknown');
      expect(limits).toEqual({ maxSubscriptions: 100, maxUrlSavesPerMonth: 100 });
    });

    it('falls back to free for empty string', () => {
      const limits = getLimitsForTier('');
      expect(limits).toEqual({ maxSubscriptions: 100, maxUrlSavesPerMonth: 100 });
    });
  });

  describe('isValidTier', () => {
    it('returns true for free', () => {
      expect(isValidTier('free')).toBe(true);
    });

    it('returns true for supporter', () => {
      expect(isValidTier('supporter')).toBe(true);
    });

    it('returns false for unknown tier', () => {
      expect(isValidTier('premium')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isValidTier('')).toBe(false);
    });
  });

  describe('ALL_TIERS', () => {
    it('contains free and supporter', () => {
      expect(ALL_TIERS).toContain('free');
      expect(ALL_TIERS).toContain('supporter');
    });

    it('has exactly 2 tiers', () => {
      expect(ALL_TIERS).toHaveLength(2);
    });
  });
});

describe('User Tier Service', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM users').run();
  });

  describe('getUserTier', () => {
    it('returns free for a user with default tier', async () => {
      await env.DB.prepare(
        `INSERT INTO users (did, handle, pds_url, created_at) VALUES (?, ?, ?, unixepoch())`
      )
        .bind(TEST_DID, 'test.bsky.social', 'https://test.pds.example')
        .run();

      const tier = await getUserTier(env, TEST_DID);
      expect(tier).toBe('free');
    });

    it('returns supporter for a user with supporter tier', async () => {
      await env.DB.prepare(
        `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, ?, ?, ?, unixepoch())`
      )
        .bind(TEST_DID, 'test.bsky.social', 'https://test.pds.example', 'supporter')
        .run();

      const tier = await getUserTier(env, TEST_DID);
      expect(tier).toBe('supporter');
    });

    it('returns free for a non-existent user', async () => {
      const tier = await getUserTier(env, 'did:plc:nonexistent');
      expect(tier).toBe('free');
    });
  });

  describe('getUserTierLimits', () => {
    it('returns free limits for a default user', async () => {
      await env.DB.prepare(
        `INSERT INTO users (did, handle, pds_url, created_at) VALUES (?, ?, ?, unixepoch())`
      )
        .bind(TEST_DID, 'test.bsky.social', 'https://test.pds.example')
        .run();

      const limits = await getUserTierLimits(env, TEST_DID);
      expect(limits).toEqual({ maxSubscriptions: 100, maxUrlSavesPerMonth: 100 });
    });

    it('returns supporter limits for a supporter user', async () => {
      await env.DB.prepare(
        `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, ?, ?, ?, unixepoch())`
      )
        .bind(TEST_DID, 'test.bsky.social', 'https://test.pds.example', 'supporter')
        .run();

      const limits = await getUserTierLimits(env, TEST_DID);
      expect(limits).toEqual({
        maxSubscriptions: 1000,
        maxUrlSavesPerMonth: 1000,
      });
    });

    it('returns free limits for a non-existent user', async () => {
      const limits = await getUserTierLimits(env, 'did:plc:nonexistent');
      expect(limits).toEqual({ maxSubscriptions: 100, maxUrlSavesPerMonth: 100 });
    });
  });

  describe('tier updates', () => {
    it('reflects tier change after UPDATE', async () => {
      await env.DB.prepare(
        `INSERT INTO users (did, handle, pds_url, created_at) VALUES (?, ?, ?, unixepoch())`
      )
        .bind(TEST_DID, 'test.bsky.social', 'https://test.pds.example')
        .run();

      // Initially free
      expect(await getUserTier(env, TEST_DID)).toBe('free');

      // Upgrade to supporter
      await env.DB.prepare('UPDATE users SET tier = ? WHERE did = ?')
        .bind('supporter', TEST_DID)
        .run();

      expect(await getUserTier(env, TEST_DID)).toBe('supporter');
      const limits = await getUserTierLimits(env, TEST_DID);
      expect(limits.maxSubscriptions).toBe(1000);

      // Downgrade back to free
      await env.DB.prepare('UPDATE users SET tier = ? WHERE did = ?').bind('free', TEST_DID).run();

      expect(await getUserTier(env, TEST_DID)).toBe('free');
      const freeLimits = await getUserTierLimits(env, TEST_DID);
      expect(freeLimits.maxSubscriptions).toBe(100);
    });
  });
});
