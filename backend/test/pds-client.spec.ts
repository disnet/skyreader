import { env } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PDSClient, createPDSClient } from '../src/services/pds-client';
import type { Session } from '../src/types';

// Test DPoP key pair (ES256)
const TEST_DPOP_KEY = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
  d: 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI',
};

function createTestSession(overrides?: Partial<Session>): Session {
  return {
    did: 'did:plc:test123',
    handle: 'test.bsky.social',
    pdsUrl: 'https://test.pds.example',
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    dpopPrivateKey: JSON.stringify(TEST_DPOP_KEY),
    expiresAt: Date.now() + 3600000,
    ...overrides,
  };
}

// Helper to create PDS record responses
function createPdsRecord<T>(uri: string, value: T) {
  return {
    uri,
    cid: 'bafyrei' + uri.split('/').pop(),
    value,
  };
}

describe('PDSClient', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('listRecords', () => {
    it('fetches records with pagination params', async () => {
      const session = createTestSession();
      const client = createPDSClient(session);

      const mockRecords = [
        createPdsRecord('at://did:plc:test123/app.test.collection/rkey1', {
          foo: 'bar',
        }),
        createPdsRecord('at://did:plc:test123/app.test.collection/rkey2', {
          foo: 'baz',
        }),
      ];

      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        headers: new Headers(),
        json: async () => ({ records: mockRecords, cursor: 'next-cursor' }),
      });

      const result = await client.listRecords('app.test.collection', undefined, 50);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.records).toHaveLength(2);
        expect(result.data.cursor).toBe('next-cursor');
      }

      expect(globalThis.fetch).toHaveBeenCalledOnce();
      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      const url = fetchCall[0] as string;
      expect(url).toContain('com.atproto.repo.listRecords');
      expect(url).toContain('repo=did%3Aplc%3Atest123');
      expect(url).toContain('collection=app.test.collection');
      expect(url).toContain('limit=50');
    });

    it('includes cursor in request when provided', async () => {
      const session = createTestSession();
      const client = createPDSClient(session);

      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        headers: new Headers(),
        json: async () => ({ records: [] }),
      });

      await client.listRecords('app.test.collection', 'my-cursor');

      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      const url = fetchCall[0] as string;
      expect(url).toContain('cursor=my-cursor');
    });
  });

  describe('listAllRecords', () => {
    it('handles pagination by fetching multiple pages', async () => {
      const session = createTestSession();
      const client = createPDSClient(session);

      // Page 1
      const page1Records = [
        createPdsRecord('at://did:plc:test123/app.test.collection/rkey1', {
          n: 1,
        }),
        createPdsRecord('at://did:plc:test123/app.test.collection/rkey2', {
          n: 2,
        }),
      ];

      // Page 2
      const page2Records = [
        createPdsRecord('at://did:plc:test123/app.test.collection/rkey3', {
          n: 3,
        }),
      ];

      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers(),
          json: async () => ({ records: page1Records, cursor: 'page2' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers(),
          json: async () => ({ records: page2Records }), // No cursor = last page
        });

      const result = await client.listAllRecords('app.test.collection');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(3);
        expect(result.data[0].value).toEqual({ n: 1 });
        expect(result.data[2].value).toEqual({ n: 3 });
        // Exhausted the collection (last page had no cursor) → not truncated.
        expect(result.truncated).toBeFalsy();
      }

      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('respects maxPages limit', async () => {
      const session = createTestSession();
      const client = createPDSClient(session);

      // Keep returning pages with cursors
      globalThis.fetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          headers: new Headers(),
          json: async () => ({
            records: [createPdsRecord('at://did:plc:test123/coll/rkey', { n: 1 })],
            cursor: 'next',
          }),
        });
      });

      const result = await client.listAllRecords('app.test.collection', {
        maxPages: 3,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(3); // 1 record per page x 3 pages
        // Stopped on the page cap while a cursor was still pending → truncated.
        expect(result.truncated).toBe(true);
      }

      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    });

    it('respects maxRecords limit', async () => {
      const session = createTestSession();
      const client = createPDSClient(session);

      // Return many records per page
      globalThis.fetch = vi.fn().mockImplementation(() => {
        const records = Array.from({ length: 100 }, (_, i) =>
          createPdsRecord(`at://did:plc:test123/coll/rkey${i}`, { n: i })
        );
        return Promise.resolve({
          ok: true,
          headers: new Headers(),
          json: async () => ({ records, cursor: 'next' }),
        });
      });

      const result = await client.listAllRecords('app.test.collection', {
        maxRecords: 250,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // Should have fetched 3 pages (100 + 100 + 100 = 300, but stops at 250+ check)
        expect(result.data.length).toBeLessThanOrEqual(300);
        expect(result.data.length).toBeGreaterThanOrEqual(250);
        // Stopped on the record cap with a cursor still pending → truncated.
        expect(result.truncated).toBe(true);
      }
    });

    it('stops on empty cursor', async () => {
      const session = createTestSession();
      const client = createPDSClient(session);

      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        headers: new Headers(),
        json: async () => ({
          records: [createPdsRecord('at://did:plc:test123/coll/rkey', { n: 1 })],
          cursor: '', // Empty cursor
        }),
      });

      const result = await client.listAllRecords('app.test.collection');

      expect(result.success).toBe(true);
      if (result.success) {
        // Empty cursor means the collection is exhausted → not truncated.
        expect(result.truncated).toBeFalsy();
      }
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    });

    it('stops on empty records array', async () => {
      const session = createTestSession();
      const client = createPDSClient(session);

      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        headers: new Headers(),
        json: async () => ({
          records: [],
          cursor: 'next-cursor', // Cursor present but no records
        }),
      });

      const result = await client.listAllRecords('app.test.collection');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(0);
        // An empty page ends the listing cleanly → not truncated.
        expect(result.truncated).toBeFalsy();
      }
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    });
  });

  describe('putRecord', () => {
    it('creates or updates records', async () => {
      const session = createTestSession();
      const client = createPDSClient(session);

      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        headers: new Headers(),
        json: async () => ({
          uri: 'at://did:plc:test123/app.test.collection/rkey1',
          cid: 'bafyreitest',
        }),
      });

      const result = await client.putRecord('app.test.collection', 'rkey1', {
        foo: 'bar',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.uri).toContain('rkey1');
        expect(result.data.cid).toBe('bafyreitest');
      }

      expect(globalThis.fetch).toHaveBeenCalledOnce();
      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      const url = fetchCall[0] as string;
      const options = fetchCall[1] as RequestInit;

      expect(url).toContain('com.atproto.repo.putRecord');
      expect(options.method).toBe('POST');
      expect(options.headers).toHaveProperty('Content-Type', 'application/json');

      const body = JSON.parse(options.body as string);
      expect(body.repo).toBe('did:plc:test123');
      expect(body.collection).toBe('app.test.collection');
      expect(body.rkey).toBe('rkey1');
      expect(body.record).toEqual({ foo: 'bar' });
    });
  });

  describe('deleteRecord', () => {
    it('deletes records', async () => {
      const session = createTestSession();
      const client = createPDSClient(session);

      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        headers: new Headers(),
        json: async () => ({}),
      });

      const result = await client.deleteRecord('app.test.collection', 'rkey1');

      expect(result.success).toBe(true);

      expect(globalThis.fetch).toHaveBeenCalledOnce();
      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      const url = fetchCall[0] as string;
      const options = fetchCall[1] as RequestInit;

      expect(url).toContain('com.atproto.repo.deleteRecord');
      expect(options.method).toBe('POST');

      const body = JSON.parse(options.body as string);
      expect(body.repo).toBe('did:plc:test123');
      expect(body.collection).toBe('app.test.collection');
      expect(body.rkey).toBe('rkey1');
    });
  });

  describe('DPoP nonce handling', () => {
    it('retries with nonce on use_dpop_nonce error', async () => {
      const session = createTestSession();
      const client = createPDSClient(session);

      // First request fails with use_dpop_nonce
      // Second request succeeds
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          headers: new Headers({ 'DPoP-Nonce': 'new-nonce-value' }),
          text: async () => JSON.stringify({ error: 'use_dpop_nonce' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers(),
          json: async () => ({ records: [] }),
        });

      const result = await client.listRecords('app.test.collection');

      expect(result.success).toBe(true);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('stores nonce for future requests', async () => {
      const session = createTestSession();
      const client = createPDSClient(session);

      // First request returns a nonce in response headers
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'DPoP-Nonce': 'persistent-nonce' }),
        json: async () => ({ records: [] }),
      });

      // Make two requests
      await client.listRecords('app.test.collection');
      await client.listRecords('app.test.collection');

      // Both should succeed, and the second should use the stored nonce
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('error handling', () => {
    it('returns retryable true for 5xx errors', async () => {
      const session = createTestSession();
      const client = createPDSClient(session);

      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: new Headers(),
        text: async () => 'Service Unavailable',
      });

      const result = await client.listRecords('app.test.collection');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.retryable).toBe(true);
      }
    });

    it('returns retryable true for 429 rate limit', async () => {
      const session = createTestSession();
      const client = createPDSClient(session);

      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers(),
        text: async () => JSON.stringify({ error: 'rate_limit_exceeded' }),
      });

      const result = await client.listRecords('app.test.collection');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.retryable).toBe(true);
      }
    });

    it('returns retryable false for 4xx errors', async () => {
      const session = createTestSession();
      const client = createPDSClient(session);

      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 400,
        headers: new Headers(),
        text: async () => JSON.stringify({ error: 'invalid_request', message: 'Bad request' }),
      });

      const result = await client.listRecords('app.test.collection');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.retryable).toBe(false);
        expect(result.error).toBe('Bad request');
      }
    });

    it('returns retryable true for network errors', async () => {
      const session = createTestSession();
      const client = createPDSClient(session);

      globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('Network failure'));

      const result = await client.listRecords('app.test.collection');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.retryable).toBe(true);
        expect(result.error).toBe('Network failure');
      }
    });

    it('extracts error message from PDS error response', async () => {
      const session = createTestSession();
      const client = createPDSClient(session);

      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 400,
        headers: new Headers(),
        text: async () =>
          JSON.stringify({
            error: 'InvalidRecord',
            message: 'Record does not match schema',
          }),
      });

      const result = await client.putRecord('app.test.collection', 'rkey', {
        invalid: true,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Record does not match schema');
      }
    });
  });

  describe('createPDSClient factory', () => {
    it('creates a PDSClient instance', () => {
      const session = createTestSession();
      const client = createPDSClient(session);
      expect(client).toBeInstanceOf(PDSClient);
    });
  });

  // Regression coverage for the PDS-migration bug: a session whose pds_url no
  // longer matches the DID document must recover automatically (re-resolve the
  // host from the DID doc, persist it, and retry) with no manual sync toggle.
  describe('stale endpoint recovery (PDS migration)', () => {
    const RECOVERY_DID = 'did:plc:migrationuser';
    const OLD_PDS = 'https://old.pds.example';
    const NEW_PDS = 'https://new.pds.example';
    const SESSION_ID = 'recovery-session-1';

    function plcDoc(did: string, pds: string) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          id: did,
          service: [
            { id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: pds },
          ],
        }),
        text: async () => '',
      };
    }

    function authRejected() {
      return {
        ok: false,
        status: 401,
        headers: new Headers(),
        text: async () => JSON.stringify({ error: 'invalid_token', message: 'Token invalid' }),
      };
    }

    function emptyRecords() {
      return {
        ok: true,
        headers: new Headers(),
        json: async () => ({ records: [] }),
      };
    }

    async function seedSession(pdsUrl: string) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO users (did, handle, pds_url, created_at)
         VALUES (?, ?, ?, unixepoch())`
      )
        .bind(RECOVERY_DID, 'migration.bsky.social', pdsUrl)
        .run();
      await env.DB.prepare(
        `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          SESSION_ID,
          RECOVERY_DID,
          'migration.bsky.social',
          pdsUrl,
          'tok',
          'refresh',
          JSON.stringify(TEST_DPOP_KEY),
          Date.now() + 3600000
        )
        .run();
    }

    beforeEach(async () => {
      await env.DB.prepare('DELETE FROM sessions WHERE session_id = ?').bind(SESSION_ID).run();
      await env.DB.prepare('DELETE FROM did_pds_cache WHERE did = ?').bind(RECOVERY_DID).run();
      await env.DB.prepare('DELETE FROM users WHERE did = ?').bind(RECOVERY_DID).run();
    });

    function recoverySession(): Session {
      return createTestSession({ did: RECOVERY_DID, pdsUrl: OLD_PDS });
    }

    it('re-resolves, persists, and retries when the host moved and tokens still work', async () => {
      await seedSession(OLD_PDS);

      const calls: string[] = [];
      globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const u = url.toString();
        calls.push(u);
        if (u.startsWith(`${OLD_PDS}/xrpc/`)) return authRejected();
        if (u.startsWith('https://plc.directory/')) return plcDoc(RECOVERY_DID, NEW_PDS);
        if (u.startsWith(`${NEW_PDS}/xrpc/`)) return emptyRecords();
        throw new Error(`Unexpected fetch: ${u}`);
      });

      const client = createPDSClient(recoverySession(), { env, sessionId: SESSION_ID });
      const result = await client.listRecords('app.skyreader.feed.subscription');

      expect(result.success).toBe(true);

      // Old host hit, DID re-resolved, new host hit — in that order.
      expect(calls.some((c) => c.startsWith(`${OLD_PDS}/xrpc/`))).toBe(true);
      expect(calls.some((c) => c.startsWith('https://plc.directory/'))).toBe(true);
      expect(calls.some((c) => c.startsWith(`${NEW_PDS}/xrpc/`))).toBe(true);

      // New host persisted to the session row.
      const row = await env.DB.prepare('SELECT pds_url FROM sessions WHERE session_id = ?')
        .bind(SESSION_ID)
        .first<{ pds_url: string }>();
      expect(row?.pds_url).toBe(NEW_PDS);

      // And to the DID cache.
      const cache = await env.DB.prepare('SELECT pds_url FROM did_pds_cache WHERE did = ?')
        .bind(RECOVERY_DID)
        .first<{ pds_url: string }>();
      expect(cache?.pds_url).toBe(NEW_PDS);
    });

    it('signals needsReauth (and does not loop) when the new host still rejects tokens', async () => {
      await seedSession(OLD_PDS);

      let newHostCalls = 0;
      globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const u = url.toString();
        if (u.startsWith(`${OLD_PDS}/xrpc/`)) return authRejected();
        if (u.startsWith('https://plc.directory/')) return plcDoc(RECOVERY_DID, NEW_PDS);
        if (u.startsWith(`${NEW_PDS}/xrpc/`)) {
          newHostCalls++;
          return authRejected();
        }
        throw new Error(`Unexpected fetch: ${u}`);
      });

      const client = createPDSClient(recoverySession(), { env, sessionId: SESSION_ID });
      const result = await client.listRecords('app.skyreader.feed.subscription');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.needsReauth).toBe(true);
      }
      // Exactly one retry against the new host — no re-resolve loop.
      expect(newHostCalls).toBe(1);
    });

    it('does not re-resolve on a transient 5xx (host is fine)', async () => {
      await seedSession(OLD_PDS);

      const calls: string[] = [];
      globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const u = url.toString();
        calls.push(u);
        if (u.startsWith(`${OLD_PDS}/xrpc/`)) {
          return { ok: false, status: 503, headers: new Headers(), text: async () => 'down' };
        }
        throw new Error(`Unexpected fetch: ${u}`);
      });

      const client = createPDSClient(recoverySession(), { env, sessionId: SESSION_ID });
      const result = await client.listRecords('app.skyreader.feed.subscription');

      expect(result.success).toBe(false);
      if (!result.success) expect(result.retryable).toBe(true);
      // No DID re-resolution attempted.
      expect(calls.some((c) => c.startsWith('https://plc.directory/'))).toBe(false);
      const row = await env.DB.prepare('SELECT pds_url FROM sessions WHERE session_id = ?')
        .bind(SESSION_ID)
        .first<{ pds_url: string }>();
      expect(row?.pds_url).toBe(OLD_PDS);
    });

    it('does not re-resolve on a not-found (RecordNotFound)', async () => {
      await seedSession(OLD_PDS);

      const calls: string[] = [];
      globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const u = url.toString();
        calls.push(u);
        if (u.startsWith(`${OLD_PDS}/xrpc/`)) {
          return {
            ok: false,
            status: 400,
            headers: new Headers(),
            text: async () => JSON.stringify({ error: 'RecordNotFound' }),
          };
        }
        throw new Error(`Unexpected fetch: ${u}`);
      });

      const client = createPDSClient(recoverySession(), { env, sessionId: SESSION_ID });
      const result = await client.getRecord('app.skyreader.feed.subscription', 'rkey');

      expect(result.success).toBe(false);
      expect(calls.some((c) => c.startsWith('https://plc.directory/'))).toBe(false);
    });

    it('does not retry when the re-resolved host is unchanged', async () => {
      await seedSession(OLD_PDS);

      let oldHostCalls = 0;
      globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const u = url.toString();
        if (u.startsWith(`${OLD_PDS}/xrpc/`)) {
          oldHostCalls++;
          return authRejected();
        }
        // DID doc still points at the OLD host (not actually a migration).
        if (u.startsWith('https://plc.directory/')) return plcDoc(RECOVERY_DID, OLD_PDS);
        throw new Error(`Unexpected fetch: ${u}`);
      });

      const client = createPDSClient(recoverySession(), { env, sessionId: SESSION_ID });
      const result = await client.listRecords('app.skyreader.feed.subscription');

      expect(result.success).toBe(false);
      if (!result.success) expect(result.needsReauth).toBeFalsy();
      // Only the original attempt — no pointless retry against the same host.
      expect(oldHostCalls).toBe(1);
    });

    it('leaves failures untouched when no recovery context is supplied', async () => {
      const calls: string[] = [];
      globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const u = url.toString();
        calls.push(u);
        if (u.startsWith(`${OLD_PDS}/xrpc/`)) return authRejected();
        throw new Error(`Unexpected fetch: ${u}`);
      });

      const client = createPDSClient(recoverySession()); // no recovery context
      const result = await client.listRecords('app.skyreader.feed.subscription');

      expect(result.success).toBe(false);
      expect(calls.some((c) => c.startsWith('https://plc.directory/'))).toBe(false);
    });
  });
});
