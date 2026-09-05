import { env } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { syncSubscriptions } from '../src/services/subscription-sync';
import { MAX_SYNC_BACKFILLS } from '../src/services/document-store';
import { upsertSubscriptionFromFirehose } from '../src/services/firehose-subscription';
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

    // The restore-from-the-Atmosphere case: the PDS records survived, the local
    // rows didn't. Documents are served from D1 now, so a restored linkblog whose
    // author nobody has listed polls `status:'error'` until something lists them —
    // and this path can restore far more of them at once than a subscribe does,
    // which is why only the first few are warmed here.
    it('warms a bounded number of restored linkblogs and leaves the rest to the reconcile', async () => {
      const session = createTestSession();
      const authors = ['did:plc:author1', 'did:plc:author2', 'did:plc:author3'];
      const pdsRecords = authors.map((did, i) => ({
        uri: `at://${TEST_DID}/${COLLECTION}/doc${i}`,
        cid: `bafyreidoc${i}`,
        value: {
          $type: COLLECTION,
          feedUrl: `at://${did}/site.standard.publication/pub`,
          title: `Linkblog ${i}`,
          sourceType: 'atproto.documents',
          subjectDid: did,
          createdAt: new Date().toISOString(),
        },
      }));

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (String(url).includes('plc.directory')) {
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({
              service: [
                {
                  id: '#atproto_pds',
                  type: 'AtprotoPersonalDataServer',
                  serviceEndpoint: 'https://pds.example',
                },
              ],
            }),
          };
        }
        if (String(url).includes('site.standard.document')) {
          return { ok: true, headers: new Headers(), json: async () => ({ records: [] }) };
        }
        return { ok: true, headers: new Headers(), json: async () => ({ records: pdsRecords }) };
      });

      const scheduled: Promise<unknown>[] = [];
      const result = await syncSubscriptions(session, env, undefined, (p) => scheduled.push(p));
      await Promise.all(scheduled);

      expect(result.pulledFromPds).toBe(3);
      // Two walks ran now; the third author has no bookkeeping row at all, which
      // is what puts them at the front of the reconcile queue.
      const listed = await env.DB.prepare(
        'SELECT author_did FROM document_authors WHERE last_listed_at IS NOT NULL'
      ).all<{ author_did: string }>();
      expect(listed.results?.length).toBe(MAX_SYNC_BACKFILLS);
      expect(scheduled.length).toBe(MAX_SYNC_BACKFILLS);

      await env.DB.prepare('DELETE FROM document_authors').run();
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
      // All 10 are pulled — the 5 over the 100 active limit are PARKED, not dropped.
      expect(result.pulledFromPds).toBe(10);
      expect(result.skipped).toBe(0);

      // Total is 105 (95 + 10): nothing the user owns is dropped under the mirror cap.
      const count = await env.DB.prepare(
        `SELECT COUNT(*) as count FROM subscriptions_cache WHERE user_did = ?`
      )
        .bind(TEST_DID)
        .first<{ count: number }>();
      expect(count?.count).toBe(105);

      // Exactly 100 active (the cap), 5 parked.
      const active = await env.DB.prepare(
        `SELECT COUNT(*) as count FROM subscriptions_cache WHERE user_did = ? AND active = 1`
      )
        .bind(TEST_DID)
        .first<{ count: number }>();
      expect(active?.count).toBe(100);

      const parked = await env.DB.prepare(
        `SELECT COUNT(*) as count FROM subscriptions_cache WHERE user_did = ? AND active = 0`
      )
        .bind(TEST_DID)
        .first<{ count: number }>();
      expect(parked?.count).toBe(5);
    });

    it('parks (not drops) the overflow when PDS exceeds the active limit', async () => {
      const session = createTestSession();

      // PDS has 150 subscriptions, no local rows yet.
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
      // Everything is pulled — 100 active, 50 parked. Well under the 1000 mirror cap.
      expect(result.pulledFromPds).toBe(150);
      const parkedWarning = result.limitNotices.find((n) => n.message.includes('parked'));
      expect(parkedWarning).toBeDefined();
      expect(parkedWarning?.kind).toBe('feeds');
      expect(parkedWarning?.message).toContain('50 feeds');
      expect(parkedWarning?.message).toContain('active limit of 100');
      // A full sync is a loop of these calls, and the client has to add the
      // counts up before it can quote a total. Pinned because the prose alone
      // can't be summed: two batches produce two different sentences.
      expect(parkedWarning?.subject).toBe('feeds');
      expect(parkedWarning?.count).toBe(50);
      expect(parkedWarning?.limit).toBe(100);

      const active = await env.DB.prepare(
        `SELECT COUNT(*) as count FROM subscriptions_cache WHERE user_did = ? AND active = 1`
      )
        .bind(TEST_DID)
        .first<{ count: number }>();
      expect(active?.count).toBe(100);

      const total = await env.DB.prepare(
        `SELECT COUNT(*) as count FROM subscriptions_cache WHERE user_did = ?`
      )
        .bind(TEST_DID)
        .first<{ count: number }>();
      expect(total?.count).toBe(150);
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

  // The reported bug: after a PDS migration the session's pds_url is stale and
  // sync silently stops. Syncing (the same call the Settings toggle makes) must
  // recover on its own — no off/on toggle required.
  describe('PDS migration recovery', () => {
    const OLD_PDS = 'https://old.pds.example';
    const NEW_PDS = 'https://new.pds.example';
    const MIGRATE_SESSION = 'migrate-session-1';

    function plcDoc(pds: string) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          id: TEST_DID,
          service: [
            { id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: pds },
          ],
        }),
        text: async () => '',
      };
    }

    it('recovers a stale endpoint and syncs without a manual toggle', async () => {
      // Session still points at the old PDS host.
      await env.DB.prepare(
        `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          MIGRATE_SESSION,
          TEST_DID,
          'test.bsky.social',
          OLD_PDS,
          'tok',
          'refresh',
          JSON.stringify(TEST_DPOP_KEY),
          Date.now() + 3600000
        )
        .run();
      await env.DB.prepare('DELETE FROM did_pds_cache WHERE did = ?').bind(TEST_DID).run();

      const pdsRecords = [
        createPdsSubscriptionRecord('rkey1', 'https://example.com/feed1.xml', 'Feed 1'),
      ];

      globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const u = url.toString();
        // Old host rejects the now-stale credentials/host.
        if (u.startsWith(`${OLD_PDS}/xrpc/`)) {
          return {
            ok: false,
            status: 403,
            headers: new Headers(),
            text: async () => JSON.stringify({ error: 'AccountDeactivated' }),
          };
        }
        // DID doc now points at the new host.
        if (u.startsWith('https://plc.directory/')) return plcDoc(NEW_PDS);
        // New host serves the user's records.
        if (u.startsWith(`${NEW_PDS}/xrpc/`)) {
          return { ok: true, headers: new Headers(), json: async () => ({ records: pdsRecords }) };
        }
        throw new Error(`Unexpected fetch: ${u}`);
      });

      const session = createTestSession({ pdsUrl: OLD_PDS });
      const result = await syncSubscriptions(session, env, MIGRATE_SESSION);

      expect(result.success).toBe(true);
      expect(result.needsReauth).toBeFalsy();
      expect(result.pulledFromPds).toBe(1);

      // Session host was migrated and persisted.
      const row = await env.DB.prepare('SELECT pds_url FROM sessions WHERE session_id = ?')
        .bind(MIGRATE_SESSION)
        .first<{ pds_url: string }>();
      expect(row?.pds_url).toBe(NEW_PDS);

      // The pulled record landed locally.
      const local = await env.DB.prepare(
        'SELECT feed_url FROM subscriptions_cache WHERE user_did = ?'
      )
        .bind(TEST_DID)
        .all<{ feed_url: string }>();
      expect(local.results?.map((r) => r.feed_url)).toContain('https://example.com/feed1.xml');
    });

    it('reports needsReauth when the migrated host still rejects the tokens', async () => {
      await env.DB.prepare(
        `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          MIGRATE_SESSION,
          TEST_DID,
          'test.bsky.social',
          OLD_PDS,
          'tok',
          'refresh',
          JSON.stringify(TEST_DPOP_KEY),
          Date.now() + 3600000
        )
        .run();
      await env.DB.prepare('DELETE FROM did_pds_cache WHERE did = ?').bind(TEST_DID).run();

      globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const u = url.toString();
        if (u.startsWith(`${OLD_PDS}/xrpc/`) || u.startsWith(`${NEW_PDS}/xrpc/`)) {
          return {
            ok: false,
            status: 401,
            headers: new Headers(),
            text: async () => JSON.stringify({ error: 'invalid_token' }),
          };
        }
        if (u.startsWith('https://plc.directory/')) return plcDoc(NEW_PDS);
        throw new Error(`Unexpected fetch: ${u}`);
      });

      const session = createTestSession({ pdsUrl: OLD_PDS });
      const result = await syncSubscriptions(session, env, MIGRATE_SESSION);

      expect(result.success).toBe(false);
      expect(result.needsReauth).toBe(true);
    });
  });
  describe('pending-write repair (pds_dirty)', () => {
    // The bug this exists for: subscription edits write through to the PDS
    // fire-and-forget, and the push phase used to skip anything already present
    // on the PDS — so a rename whose push failed stayed stale forever, and the
    // manual sync reported everything in step.
    it('repairs a record on the PDS when the local row has an unpaid edit', async () => {
      const session = createTestSession();

      await env.DB.prepare(
        `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, custom_title, created_at, pds_dirty)
         VALUES (?, ?, ?, ?, ?, unixepoch(), 1)`
      )
        .bind(
          TEST_DID,
          `at://${TEST_DID}/${COLLECTION}/rkey1`,
          'https://example.com/feed.xml',
          'Feed',
          'My Renamed Feed'
        )
        .run();

      // The PDS still holds the pre-rename record under the same rkey/feedUrl.
      let written: { rkey: string; customTitle?: string; $type: string } | null = null;
      globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('listRecords')) {
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({
              records: [
                createPdsSubscriptionRecord('rkey1', 'https://example.com/feed.xml', 'Feed'),
              ],
            }),
          };
        }
        if (url.includes('applyWrites')) {
          const body = JSON.parse(String(init?.body)) as {
            writes: Array<{ $type: string; rkey: string; value: { customTitle?: string } }>;
          };
          written = {
            $type: body.writes[0].$type,
            rkey: body.writes[0].rkey,
            customTitle: body.writes[0].value.customTitle,
          };
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({
              commit: { cid: 'bafycommit', rev: 'rev1' },
              results: [{ uri: `at://${TEST_DID}/${COLLECTION}/rkey1`, cid: 'bafyrepaired' }],
            }),
          };
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      const result = await syncSubscriptions(session, env);

      expect(result.success).toBe(true);
      expect(written).not.toBeNull();
      expect(written!.$type).toBe('com.atproto.repo.applyWrites#update');
      expect(written!.rkey).toBe('rkey1');
      expect(written!.customTitle).toBe('My Renamed Feed');

      // Debt settled, so a later sync leaves it alone.
      const row = await env.DB.prepare(
        'SELECT pds_dirty FROM subscriptions_cache WHERE user_did = ? AND record_uri LIKE ?'
      )
        .bind(TEST_DID, '%/rkey1')
        .first<{ pds_dirty: number }>();
      expect(row?.pds_dirty).toBe(0);
    });

    it('leaves the flag set when the repair write fails, so the next sync retries', async () => {
      const session = createTestSession();

      await env.DB.prepare(
        `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, custom_title, created_at, pds_dirty)
         VALUES (?, ?, ?, ?, ?, unixepoch(), 1)`
      )
        .bind(
          TEST_DID,
          `at://${TEST_DID}/${COLLECTION}/rkey1`,
          'https://example.com/feed.xml',
          'Feed',
          'My Renamed Feed'
        )
        .run();

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('listRecords')) {
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({
              records: [
                createPdsSubscriptionRecord('rkey1', 'https://example.com/feed.xml', 'Feed'),
              ],
            }),
          };
        }
        // Both the batch and the individual-put fallback fail.
        return {
          ok: false,
          status: 500,
          headers: new Headers(),
          text: async () => JSON.stringify({ error: 'InternalServerError' }),
        };
      });

      await syncSubscriptions(session, env);

      const row = await env.DB.prepare(
        'SELECT pds_dirty FROM subscriptions_cache WHERE user_did = ? AND record_uri LIKE ?'
      )
        .bind(TEST_DID, '%/rkey1')
        .first<{ pds_dirty: number }>();
      expect(row?.pds_dirty).toBe(1);
    });

    it('clears the flag without a write when the PDS already matches', async () => {
      const session = createTestSession();

      // Flagged, but the push actually landed before the flag could be cleared.
      await env.DB.prepare(
        `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, created_at, pds_dirty)
         VALUES (?, ?, ?, ?, unixepoch(), 1)`
      )
        .bind(
          TEST_DID,
          `at://${TEST_DID}/${COLLECTION}/rkey1`,
          'https://example.com/feed.xml',
          'Feed'
        )
        .run();

      let applyWritesCalled = false;
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('listRecords')) {
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({
              records: [
                createPdsSubscriptionRecord('rkey1', 'https://example.com/feed.xml', 'Feed'),
              ],
            }),
          };
        }
        if (url.includes('applyWrites')) {
          applyWritesCalled = true;
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({ commit: { cid: 'c', rev: 'r' }, results: [] }),
          };
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      await syncSubscriptions(session, env);

      expect(applyWritesCalled).toBe(false);
      const row = await env.DB.prepare(
        'SELECT pds_dirty FROM subscriptions_cache WHERE user_did = ? AND record_uri LIKE ?'
      )
        .bind(TEST_DID, '%/rkey1')
        .first<{ pds_dirty: number }>();
      expect(row?.pds_dirty).toBe(0);
    });

    it('repairs the record under the other rkey rather than dropping the edit', async () => {
      // Same shape as the test below — a local row whose feed the PDS holds under
      // a different rkey — but this one carries a rename. Settling it would clear
      // the flag without paying it: the rename would vanish while settings said
      // everything was in step. The repair has to land on the record the PDS
      // actually has, not on a second one under our rkey.
      const session = createTestSession();

      await env.DB.prepare(
        `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, custom_title, created_at, pds_dirty)
         VALUES (?, ?, ?, ?, ?, unixepoch(), 1)`
      )
        .bind(
          TEST_DID,
          `at://${TEST_DID}/${COLLECTION}/local-rkey`,
          'https://example.com/feed.xml',
          'Feed',
          'My Renamed Feed'
        )
        .run();

      let written: { $type: string; rkey: string; customTitle?: string } | null = null;
      globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('listRecords')) {
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({
              records: [
                createPdsSubscriptionRecord('other-rkey', 'https://example.com/feed.xml', 'Feed'),
              ],
            }),
          };
        }
        if (url.includes('applyWrites')) {
          const body = JSON.parse(String(init?.body)) as {
            writes: Array<{ $type: string; rkey: string; value: { customTitle?: string } }>;
          };
          expect(body.writes).toHaveLength(1);
          written = {
            $type: body.writes[0].$type,
            rkey: body.writes[0].rkey,
            customTitle: body.writes[0].value.customTitle,
          };
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({
              commit: { cid: 'c', rev: 'r' },
              results: [{ uri: `at://${TEST_DID}/${COLLECTION}/other-rkey`, cid: 'bafyrepaired' }],
            }),
          };
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      await syncSubscriptions(session, env);

      // Updated in place on the PDS — no second record for the same feed.
      expect(written).not.toBeNull();
      expect(written!.$type).toBe('com.atproto.repo.applyWrites#update');
      expect(written!.rkey).toBe('other-rkey');
      expect(written!.customTitle).toBe('My Renamed Feed');

      // The flag lives on the local row, whose rkey the write never mentions.
      const row = await env.DB.prepare(
        'SELECT pds_dirty FROM subscriptions_cache WHERE user_did = ? AND record_uri LIKE ?'
      )
        .bind(TEST_DID, '%/local-rkey')
        .first<{ pds_dirty: number }>();
      expect(row?.pds_dirty).toBe(0);
    });

    it('leaves the other rkey alone when a local row already owns it', async () => {
      // Two local rows for one feed (possible for legacy RSS rows, whose NULL
      // source_type the unique index doesn't constrain). The row that owns the
      // PDS record keeps it accurate, so the flagged duplicate is redundant, not
      // stale: settle it and write nothing.
      const session = createTestSession();

      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, created_at, pds_dirty)
           VALUES (?, ?, ?, ?, unixepoch(), 0)`
        ).bind(
          TEST_DID,
          `at://${TEST_DID}/${COLLECTION}/owner-rkey`,
          'https://example.com/feed.xml',
          'Feed'
        ),
        env.DB.prepare(
          `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, custom_title, created_at, pds_dirty)
           VALUES (?, ?, ?, ?, ?, unixepoch(), 1)`
        ).bind(
          TEST_DID,
          `at://${TEST_DID}/${COLLECTION}/dupe-rkey`,
          'https://example.com/feed.xml',
          'Feed',
          'Renamed On The Duplicate'
        ),
      ]);

      let applyWritesCalled = false;
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('listRecords')) {
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({
              records: [
                createPdsSubscriptionRecord('owner-rkey', 'https://example.com/feed.xml', 'Feed'),
              ],
            }),
          };
        }
        if (url.includes('applyWrites')) {
          applyWritesCalled = true;
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({ commit: { cid: 'c', rev: 'r' }, results: [] }),
          };
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      await syncSubscriptions(session, env);

      expect(applyWritesCalled).toBe(false);
      const row = await env.DB.prepare(
        'SELECT pds_dirty FROM subscriptions_cache WHERE user_did = ? AND record_uri LIKE ?'
      )
        .bind(TEST_DID, '%/dupe-rkey')
        .first<{ pds_dirty: number }>();
      expect(row?.pds_dirty).toBe(0);
    });

    it('does not create a duplicate when the feed is on the PDS under another rkey', async () => {
      // Bulk import keeps a local row for a feed the PDS already holds under an
      // rkey some other device created. That row can be left flagged if its push
      // never ran — repairing it as a `create` would write a second record for
      // the same feed.
      const session = createTestSession();

      await env.DB.prepare(
        `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, created_at, pds_dirty)
         VALUES (?, ?, ?, ?, unixepoch(), 1)`
      )
        .bind(
          TEST_DID,
          `at://${TEST_DID}/${COLLECTION}/local-rkey`,
          'https://example.com/feed.xml',
          'Feed'
        )
        .run();

      let applyWritesCalled = false;
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('listRecords')) {
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({
              records: [
                createPdsSubscriptionRecord('other-rkey', 'https://example.com/feed.xml', 'Feed'),
              ],
            }),
          };
        }
        if (url.includes('applyWrites')) {
          applyWritesCalled = true;
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({ commit: { cid: 'c', rev: 'r' }, results: [] }),
          };
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      await syncSubscriptions(session, env);

      expect(applyWritesCalled).toBe(false);
      const row = await env.DB.prepare(
        'SELECT pds_dirty FROM subscriptions_cache WHERE user_did = ? AND record_uri LIKE ?'
      )
        .bind(TEST_DID, '%/local-rkey')
        .first<{ pds_dirty: number }>();
      expect(row?.pds_dirty).toBe(0);
    });

    it('does not leave a duplicate local row when the firehose mirrors a repair back', async () => {
      // The repair above writes to an rkey no local row owns, so the commit it
      // produces comes back through the firehose as a record_uri D1 has never
      // seen: the mirror's UPDATE misses and it falls through to its INSERT.
      // That insert leans on the (user_did, source_type, feed_url) unique index
      // to swallow a duplicate feed — but legacy RSS rows carry a NULL
      // source_type, and SQLite treats NULLs in a unique index as distinct, so
      // nothing stops it. The user ends up with the same feed twice.
      const session = createTestSession();

      await env.DB.prepare(
        `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, custom_title, created_at, pds_dirty)
         VALUES (?, ?, ?, ?, ?, unixepoch(), 1)`
      )
        .bind(
          TEST_DID,
          `at://${TEST_DID}/${COLLECTION}/local-rkey`,
          'https://example.com/feed.xml',
          'Feed',
          'My Renamed Feed'
        )
        .run();

      let repaired: { rkey: string; value: Record<string, unknown> } | null = null;
      globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('listRecords')) {
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({
              records: [
                createPdsSubscriptionRecord('other-rkey', 'https://example.com/feed.xml', 'Feed'),
              ],
            }),
          };
        }
        if (url.includes('applyWrites')) {
          const body = JSON.parse(String(init?.body)) as {
            writes: Array<{ rkey: string; value: Record<string, unknown> }>;
          };
          repaired = { rkey: body.writes[0].rkey, value: body.writes[0].value };
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({
              commit: { cid: 'c', rev: 'r' },
              results: [{ uri: `at://${TEST_DID}/${COLLECTION}/other-rkey`, cid: 'bafyrepaired' }],
            }),
          };
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      await syncSubscriptions(session, env);
      expect(repaired).not.toBeNull();
      expect(repaired!.rkey).toBe('other-rkey');

      // Jetstream delivers the commit the repair just made.
      await upsertSubscriptionFromFirehose(env.DB, TEST_DID, 'other-rkey', repaired!.value);

      const all = await env.DB.prepare(
        'SELECT record_uri, custom_title FROM subscriptions_cache WHERE user_did = ? AND feed_url = ?'
      )
        .bind(TEST_DID, 'https://example.com/feed.xml')
        .all<{ record_uri: string; custom_title: string | null }>();

      expect(all.results).toHaveLength(1);
      expect(all.results[0].record_uri).toContain('local-rkey');
      expect(all.results[0].custom_title).toBe('My Renamed Feed');
    });

    it('still mirrors a genuinely new feed the user does not have', async () => {
      // The duplicate guard must not swallow ordinary new records: this is the
      // path that materializes a subscription made on another device.
      await upsertSubscriptionFromFirehose(env.DB, TEST_DID, 'brandnewrkey', {
        feedUrl: 'https://example.com/brand-new.xml',
        title: 'Brand New',
        createdAt: new Date().toISOString(),
      });

      const row = await env.DB.prepare(
        'SELECT record_uri FROM subscriptions_cache WHERE user_did = ? AND feed_url = ?'
      )
        .bind(TEST_DID, 'https://example.com/brand-new.xml')
        .first<{ record_uri: string }>();
      expect(row?.record_uri).toContain('brandnewrkey');
    });

    it('treats an atproto source sharing a feedUrl as a different subscription', async () => {
      // subscriptionKey() keys atproto sources on sourceType+subjectDid+feedUrl
      // and everything else on feedUrl alone, so these two are not the same
      // subscription and the guard must not collapse them.
      await env.DB.prepare(
        `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, created_at)
         VALUES (?, ?, ?, ?, unixepoch())`
      )
        .bind(
          TEST_DID,
          `at://${TEST_DID}/${COLLECTION}/rss-rkey`,
          'https://shared.example/x',
          'RSS'
        )
        .run();

      await upsertSubscriptionFromFirehose(env.DB, TEST_DID, 'atproto-rkey', {
        feedUrl: 'https://shared.example/x',
        title: 'Docs',
        sourceType: 'atproto.documents',
        subjectDid: 'did:plc:author',
        createdAt: new Date().toISOString(),
      });

      const all = await env.DB.prepare(
        'SELECT record_uri FROM subscriptions_cache WHERE user_did = ? AND feed_url = ? ORDER BY record_uri'
      )
        .bind(TEST_DID, 'https://shared.example/x')
        .all<{ record_uri: string }>();
      expect(all.results).toHaveLength(2);
    });

    it('never deletes a PDS record that has no local row', async () => {
      // A record on the PDS but not in D1 is normal: over the plan's mirror cap,
      // past the listing page limit, or simply not mirrored to this device. The
      // sync must never resolve that by deleting from the user's own repo.
      const session = createTestSession();

      globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('listRecords')) {
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({
              records: [
                createPdsSubscriptionRecord('orphan', 'https://example.com/orphan.xml', 'Orphan'),
              ],
            }),
          };
        }
        if (url.includes('applyWrites')) {
          const body = JSON.parse(String(init?.body)) as {
            writes: Array<{ $type: string }>;
          };
          expect(body.writes.every((w) => !w.$type.endsWith('#delete'))).toBe(true);
          return {
            ok: true,
            headers: new Headers(),
            json: async () => ({ commit: { cid: 'c', rev: 'r' }, results: [] }),
          };
        }
        if (url.includes('deleteRecord')) {
          throw new Error('sync must never delete from the PDS');
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      const result = await syncSubscriptions(session, env);
      expect(result.success).toBe(true);
    });
  });
});
