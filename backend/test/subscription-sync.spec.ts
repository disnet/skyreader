import { env } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { syncSubscriptions } from '../src/services/subscription-sync';
import type { Session } from '../src/types';

// Test DPoP key pair (ES256)
const TEST_DPOP_KEY = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
  d: 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI',
};

const TEST_DID = 'did:plc:testuser123';
const COLLECTION = 'app.skyreader.feed.subscription';

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

describe('Subscription Sync', () => {
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;

    // Clear any existing data
    await env.DB.prepare('DELETE FROM subscriptions_cache').run();
    await env.DB.prepare('DELETE FROM users').run();

    // Create test user
    await env.DB.prepare(
      `INSERT INTO users (did, handle, pds_url, created_at)
			 VALUES (?, ?, ?, unixepoch())`
    )
      .bind(TEST_DID, 'test.bsky.social', 'https://test.pds.example')
      .run();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('pull from PDS', () => {
    it('adds records from PDS that do not exist locally', async () => {
      const session = createTestSession();

      // PDS has two subscriptions
      const pdsRecords = [
        createPdsSubscriptionRecord('rkey1', 'https://example.com/feed1.xml', 'Feed 1'),
        createPdsSubscriptionRecord('rkey2', 'https://example.com/feed2.xml', 'Feed 2'),
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({ records: pdsRecords }),
      });

      const result = await syncSubscriptions(session, env);

      expect(result.success).toBe(true);
      expect(result.pulledFromPds).toBe(2);
      expect(result.pushedToPds).toBe(0);

      // Verify records are in local DB
      const localRecords = await env.DB.prepare(
        `SELECT feed_url, title FROM subscriptions_cache WHERE user_did = ?`
      )
        .bind(TEST_DID)
        .all();

      expect(localRecords.results).toHaveLength(2);
      expect(localRecords.results?.map((r) => r.feed_url)).toContain(
        'https://example.com/feed1.xml'
      );
      expect(localRecords.results?.map((r) => r.feed_url)).toContain(
        'https://example.com/feed2.xml'
      );
    });

    it('does not duplicate records that already exist locally by feedUrl', async () => {
      const session = createTestSession();

      // Add existing local subscription
      await env.DB.prepare(
        `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, created_at)
				 VALUES (?, ?, ?, ?, unixepoch())`
      )
        .bind(
          TEST_DID,
          `at://${TEST_DID}/${COLLECTION}/existing-rkey`,
          'https://example.com/feed1.xml',
          'Existing Feed'
        )
        .run();

      // PDS has same feed with different rkey
      const pdsRecords = [
        createPdsSubscriptionRecord('different-rkey', 'https://example.com/feed1.xml', 'Feed 1'),
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({ records: pdsRecords }),
      });

      const result = await syncSubscriptions(session, env);

      expect(result.success).toBe(true);
      expect(result.pulledFromPds).toBe(0); // Already exists locally

      // Verify only one record exists
      const localRecords = await env.DB.prepare(
        `SELECT feed_url FROM subscriptions_cache WHERE user_did = ?`
      )
        .bind(TEST_DID)
        .all();

      expect(localRecords.results).toHaveLength(1);
    });
  });

  describe('push to PDS', () => {
    it('pushes local records that do not exist in PDS', async () => {
      const session = createTestSession();

      // Add local subscription
      await env.DB.prepare(
        `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, created_at)
				 VALUES (?, ?, ?, ?, unixepoch())`
      )
        .bind(
          TEST_DID,
          `at://${TEST_DID}/${COLLECTION}/local-rkey`,
          'https://example.com/local-feed.xml',
          'Local Feed'
        )
        .run();

      // PDS is empty
      let applyWritesCalled = false;
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('listRecords')) {
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({ records: [] }),
          };
        }
        if (url.includes('applyWrites')) {
          applyWritesCalled = true;
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({
              commit: { cid: 'bafycommit', rev: 'rev1' },
              results: [
                {
                  uri: `at://${TEST_DID}/${COLLECTION}/local-rkey`,
                  cid: 'bafyreipushed',
                },
              ],
            }),
          };
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      const result = await syncSubscriptions(session, env);

      expect(result.success).toBe(true);
      expect(result.pushedToPds).toBe(1);
      expect(applyWritesCalled).toBe(true);
    });

    it('does not push records that already exist in PDS by feedUrl', async () => {
      const session = createTestSession();

      // Add local subscription
      await env.DB.prepare(
        `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, created_at)
				 VALUES (?, ?, ?, ?, unixepoch())`
      )
        .bind(
          TEST_DID,
          `at://${TEST_DID}/${COLLECTION}/local-rkey`,
          'https://example.com/feed.xml',
          'Feed'
        )
        .run();

      // PDS has same feed (different rkey)
      const pdsRecords = [
        createPdsSubscriptionRecord('pds-rkey', 'https://example.com/feed.xml', 'Feed'),
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({ records: pdsRecords }),
      });

      const result = await syncSubscriptions(session, env);

      expect(result.success).toBe(true);
      expect(result.pushedToPds).toBe(0);
    });
  });

  describe('limits', () => {
    it('respects MAX_SUBSCRIPTIONS (100) limit when pulling', async () => {
      const session = createTestSession();

      // Add 95 local subscriptions
      for (let i = 0; i < 95; i++) {
        await env.DB.prepare(
          `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, created_at)
					 VALUES (?, ?, ?, ?, unixepoch())`
        )
          .bind(
            TEST_DID,
            `at://${TEST_DID}/${COLLECTION}/local-${i}`,
            `https://example.com/local-feed-${i}.xml`,
            `Local Feed ${i}`
          )
          .run();
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
          // Local subs need to be pushed to PDS
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
      // Should only pull 5 to reach 100 limit
      expect(result.pulledFromPds).toBe(5);
      expect(result.skipped).toBe(5);

      // Verify total is 100
      const count = await env.DB.prepare(
        `SELECT COUNT(*) as count FROM subscriptions_cache WHERE user_did = ?`
      )
        .bind(TEST_DID)
        .first<{ count: number }>();

      expect(count?.count).toBe(100);
    });

    it('adds warning when PDS has more than MAX_SUBSCRIPTIONS', async () => {
      const session = createTestSession();

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
  });

  describe('batching', () => {
    it('batches writes up to MAX_BATCH_SIZE (50) per call', async () => {
      const session = createTestSession();

      // Add 60 local subscriptions to push
      for (let i = 0; i < 60; i++) {
        await env.DB.prepare(
          `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, created_at)
					 VALUES (?, ?, ?, ?, unixepoch())`
        )
          .bind(
            TEST_DID,
            `at://${TEST_DID}/${COLLECTION}/local-${i}`,
            `https://example.com/feed-${i}.xml`,
            `Feed ${i}`
          )
          .run();
      }

      let applyWritesCount = 0;
      let writesReceived = 0;
      globalThis.fetch = vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
        if (url.includes('listRecords')) {
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({ records: [] }),
          };
        }
        if (url.includes('applyWrites')) {
          applyWritesCount++;
          const body = JSON.parse(options?.body as string);
          writesReceived = body.writes.length;
          // Return results for all writes
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
      // Only 50 pushed due to MAX_BATCH_SIZE limit
      expect(result.pushedToPds).toBe(50);
      expect(result.hasMore).toBe(true); // More records remain
      expect(applyWritesCount).toBe(1);
      expect(writesReceived).toBe(50);
    });
  });

  describe('error handling', () => {
    it('returns error when PDS fetch fails', async () => {
      const session = createTestSession();

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        headers: new Headers(),
        text: async () => 'Internal Server Error',
      });

      const result = await syncSubscriptions(session, env);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to fetch from PDS');
    });

    it('adds warning when batch push fails and fallback also fails', async () => {
      const session = createTestSession();

      // Add 2 local subscriptions
      for (let i = 0; i < 2; i++) {
        await env.DB.prepare(
          `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, created_at)
					 VALUES (?, ?, ?, ?, unixepoch())`
        )
          .bind(
            TEST_DID,
            `at://${TEST_DID}/${COLLECTION}/local-${i}`,
            `https://example.com/feed-${i}.xml`,
            `Feed ${i}`
          )
          .run();
      }

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('listRecords')) {
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({ records: [] }),
          };
        }
        if (url.includes('applyWrites')) {
          // Batch fails
          return {
            ok: false,
            status: 400,
            headers: new Headers(),
            text: async () => JSON.stringify({ error: 'InvalidRecord' }),
          };
        }
        if (url.includes('putRecord')) {
          // Individual fallback also fails
          return {
            ok: false,
            status: 400,
            headers: new Headers(),
            text: async () => JSON.stringify({ error: 'InvalidRecord' }),
          };
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      const result = await syncSubscriptions(session, env);

      // Sync should still succeed overall (failures add warnings, don't fail sync)
      expect(result.success).toBe(true);
      expect(result.pushedToPds).toBe(0);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('Some records failed');
    });
  });

  describe('merge behavior', () => {
    it('handles bidirectional sync correctly', async () => {
      const session = createTestSession();

      // Local has feed A
      await env.DB.prepare(
        `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, created_at)
				 VALUES (?, ?, ?, ?, unixepoch())`
      )
        .bind(
          TEST_DID,
          `at://${TEST_DID}/${COLLECTION}/local-a`,
          'https://example.com/feed-a.xml',
          'Feed A'
        )
        .run();

      // PDS has feed B
      const pdsRecords = [
        createPdsSubscriptionRecord('pds-b', 'https://example.com/feed-b.xml', 'Feed B'),
      ];

      let applyWritesCalled = false;
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('listRecords')) {
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({ records: pdsRecords }),
          };
        }
        if (url.includes('applyWrites')) {
          applyWritesCalled = true;
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({
              commit: { cid: 'bafycommit', rev: 'rev1' },
              results: [
                {
                  uri: `at://${TEST_DID}/${COLLECTION}/local-a`,
                  cid: 'bafyreipushed',
                },
              ],
            }),
          };
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      const result = await syncSubscriptions(session, env);

      expect(result.success).toBe(true);
      expect(result.pulledFromPds).toBe(1); // Feed B pulled
      expect(result.pushedToPds).toBe(1); // Feed A pushed
      expect(applyWritesCalled).toBe(true);

      // Local should now have both feeds
      const localRecords = await env.DB.prepare(
        `SELECT feed_url FROM subscriptions_cache WHERE user_did = ?`
      )
        .bind(TEST_DID)
        .all();

      expect(localRecords.results).toHaveLength(2);
      expect(localRecords.results?.map((r) => r.feed_url)).toContain(
        'https://example.com/feed-a.xml'
      );
      expect(localRecords.results?.map((r) => r.feed_url)).toContain(
        'https://example.com/feed-b.xml'
      );
    });
  });
});
