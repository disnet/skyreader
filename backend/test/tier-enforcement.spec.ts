import { env } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { syncSubscriptions } from '../src/services/subscription-sync';
import type { Session } from '../src/types';

const TEST_DPOP_KEY = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
  d: 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI',
};

const COLLECTION = 'app.skyreader.feed.subscription';
const TEST_DID = 'did:plc:tierenforce123';

function createTestSession(overrides?: Partial<Session>): Session {
  return {
    did: TEST_DID,
    handle: 'test.bsky.social',
    pdsUrl: 'https://test.pds.example',
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    dpopPrivateKey: JSON.stringify(TEST_DPOP_KEY),
    expiresAt: Date.now() + 3600000,
    ...overrides,
  };
}

function createPdsSubscriptionRecord(rkey: string, feedUrl: string, title?: string) {
  return {
    uri: `at://${TEST_DID}/${COLLECTION}/${rkey}`,
    cid: `bafyrei${rkey}`,
    value: {
      $type: COLLECTION,
      feedUrl,
      title,
      createdAt: new Date().toISOString(),
    },
  };
}

async function insertLocalSubscription(did: string, index: number) {
  await env.DB.prepare(
    `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, created_at)
     VALUES (?, ?, ?, ?, unixepoch())`
  )
    .bind(
      did,
      `at://${did}/${COLLECTION}/local-${index}`,
      `https://example.com/local-feed-${index}.xml`,
      `Local Feed ${index}`
    )
    .run();
}

async function getSubscriptionCount(did: string): Promise<number> {
  const result = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM subscriptions_cache WHERE user_did = ?'
  )
    .bind(did)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

describe('Tier-Aware Enforcement', () => {
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await env.DB.prepare('DELETE FROM subscriptions_cache').run();
    await env.DB.prepare('DELETE FROM users').run();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('subscription sync limits per tier', () => {
    it('free user: caps pull at 100 subscriptions', async () => {
      const session = createTestSession();

      // Create free user
      await env.DB.prepare(
        `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, ?, ?, 'free', unixepoch())`
      )
        .bind(TEST_DID, 'test.bsky.social', 'https://test.pds.example')
        .run();

      // Add 95 local subscriptions
      for (let i = 0; i < 95; i++) {
        await insertLocalSubscription(TEST_DID, i);
      }

      // PDS has 10 different subscriptions
      const pdsRecords = Array.from({ length: 10 }, (_, i) =>
        createPdsSubscriptionRecord(`pds-${i}`, `https://example.com/pds-feed-${i}.xml`, `PDS ${i}`)
      );

      globalThis.fetch = vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
        if (url.includes('listRecords')) {
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({ records: pdsRecords }),
          };
        }
        if (url.includes('applyWrites')) {
          const body = JSON.parse(options?.body as string);
          const results = body.writes.map((_: unknown, i: number) => ({
            uri: `at://${TEST_DID}/${COLLECTION}/pushed-${i}`,
            cid: `bafyreipushed${i}`,
          }));
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({
              commit: { cid: 'bafycommit', rev: 'rev1' },
              results,
            }),
          };
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      const result = await syncSubscriptions(session, env);

      expect(result.success).toBe(true);
      // Should only pull 5 to reach the free limit of 100
      expect(result.pulledFromPds).toBe(5);
      expect(result.skipped).toBe(5);
      expect(await getSubscriptionCount(TEST_DID)).toBe(100);
    });

    it('supporter user: allows pull beyond 100 subscriptions', async () => {
      const session = createTestSession();

      // Create supporter user
      await env.DB.prepare(
        `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, ?, ?, 'supporter', unixepoch())`
      )
        .bind(TEST_DID, 'test.bsky.social', 'https://test.pds.example')
        .run();

      // Add 95 local subscriptions
      for (let i = 0; i < 95; i++) {
        await insertLocalSubscription(TEST_DID, i);
      }

      // PDS has 10 different subscriptions - all 10 should be pulled (total 105 < 3000)
      const pdsRecords = Array.from({ length: 10 }, (_, i) =>
        createPdsSubscriptionRecord(`pds-${i}`, `https://example.com/pds-feed-${i}.xml`, `PDS ${i}`)
      );

      globalThis.fetch = vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
        if (url.includes('listRecords')) {
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({ records: pdsRecords }),
          };
        }
        if (url.includes('applyWrites')) {
          const body = JSON.parse(options?.body as string);
          const results = body.writes.map((_: unknown, i: number) => ({
            uri: `at://${TEST_DID}/${COLLECTION}/pushed-${i}`,
            cid: `bafyreipushed${i}`,
          }));
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({
              commit: { cid: 'bafycommit', rev: 'rev1' },
              results,
            }),
          };
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      const result = await syncSubscriptions(session, env);

      expect(result.success).toBe(true);
      // Supporter can pull all 10 (total 105, well within 3000 limit)
      expect(result.pulledFromPds).toBe(10);
      expect(result.skipped).toBe(0);
      expect(await getSubscriptionCount(TEST_DID)).toBe(105);
    });

    it('free user: warns when PDS has more than 100 subscriptions', async () => {
      const session = createTestSession();

      // Create free user
      await env.DB.prepare(
        `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, ?, ?, 'free', unixepoch())`
      )
        .bind(TEST_DID, 'test.bsky.social', 'https://test.pds.example')
        .run();

      // PDS has 150 subscriptions
      const pdsRecords = Array.from({ length: 150 }, (_, i) =>
        createPdsSubscriptionRecord(`rkey-${i}`, `https://example.com/feed-${i}.xml`, `Feed ${i}`)
      );

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({ records: pdsRecords }),
      });

      const result = await syncSubscriptions(session, env);

      expect(result.success).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('150 subscriptions');
      expect(result.warnings[0]).toContain('only 100 can be synced');
    });

    it('supporter user: no warning for 150 PDS subscriptions', async () => {
      const session = createTestSession();

      // Create supporter user
      await env.DB.prepare(
        `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, ?, ?, 'supporter', unixepoch())`
      )
        .bind(TEST_DID, 'test.bsky.social', 'https://test.pds.example')
        .run();

      // PDS has 150 subscriptions (well within supporter's 3000 limit)
      const pdsRecords = Array.from({ length: 150 }, (_, i) =>
        createPdsSubscriptionRecord(`rkey-${i}`, `https://example.com/feed-${i}.xml`, `Feed ${i}`)
      );

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({ records: pdsRecords }),
      });

      const result = await syncSubscriptions(session, env);

      expect(result.success).toBe(true);
      // No warning about exceeding limit for supporter
      const limitWarnings = result.warnings.filter((w) => w.includes('can be synced'));
      expect(limitWarnings).toHaveLength(0);
      expect(result.pulledFromPds).toBe(150);
    });

    it('tier change is reflected immediately on next sync', async () => {
      const session = createTestSession();

      // Start as free user
      await env.DB.prepare(
        `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, ?, ?, 'free', unixepoch())`
      )
        .bind(TEST_DID, 'test.bsky.social', 'https://test.pds.example')
        .run();

      // Add 98 local subscriptions (2 below free limit)
      for (let i = 0; i < 98; i++) {
        await insertLocalSubscription(TEST_DID, i);
      }

      // PDS has 5 different subscriptions
      const pdsRecords = Array.from({ length: 5 }, (_, i) =>
        createPdsSubscriptionRecord(`pds-${i}`, `https://example.com/pds-feed-${i}.xml`, `PDS ${i}`)
      );

      globalThis.fetch = vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
        if (url.includes('listRecords')) {
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({ records: pdsRecords }),
          };
        }
        if (url.includes('applyWrites')) {
          const body = JSON.parse(options?.body as string);
          const results = body.writes.map((_: unknown, i: number) => ({
            uri: `at://${TEST_DID}/${COLLECTION}/pushed-${i}`,
            cid: `bafyreipushed${i}`,
          }));
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({
              commit: { cid: 'bafycommit', rev: 'rev1' },
              results,
            }),
          };
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      // First sync as free: only pulls 2 of 5
      const result1 = await syncSubscriptions(session, env);
      expect(result1.success).toBe(true);
      expect(result1.pulledFromPds).toBe(2);
      expect(result1.skipped).toBe(3);
      expect(await getSubscriptionCount(TEST_DID)).toBe(100);

      // Upgrade to supporter
      await env.DB.prepare('UPDATE users SET tier = ? WHERE did = ?')
        .bind('supporter', TEST_DID)
        .run();

      // Second sync as supporter: pulls the remaining 3
      const result2 = await syncSubscriptions(session, env);
      expect(result2.success).toBe(true);
      expect(result2.pulledFromPds).toBe(3);
      expect(result2.skipped).toBe(0);
      expect(await getSubscriptionCount(TEST_DID)).toBe(103);
    });
  });
});
