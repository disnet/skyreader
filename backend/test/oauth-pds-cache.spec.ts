import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getPdsFromDid, invalidatePdsCache } from '../src/services/oauth';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const PLC_DID = 'did:plc:testuser123';
const WEB_DID = 'did:web:example.com';
const TEST_HANDLE = 'test.bsky.social';
const FIRST_PDS = 'https://pds-a.example.com';
const SECOND_PDS = 'https://pds-b.example.com';

function plcDocResponse(did: string, pds: string) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      id: did,
      service: [
        {
          id: '#atproto_pds',
          type: 'AtprotoPersonalDataServer',
          serviceEndpoint: pds,
        },
      ],
    }),
    text: async () => '',
  };
}

function describeRepoResponse(did: string, pds: string) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      did,
      handle: 'test.bsky.social',
      didDoc: {
        id: did,
        service: [
          {
            id: '#atproto_pds',
            type: 'AtprotoPersonalDataServer',
            serviceEndpoint: pds,
          },
        ],
      },
      collections: [],
      handleIsCorrect: true,
    }),
    text: async () => '',
  };
}

function notFoundResponse() {
  return {
    ok: false,
    status: 404,
    statusText: 'Not Found',
    headers: new Headers(),
    json: async () => ({}),
    text: async () => 'not found',
  };
}

function rateLimitResponse() {
  return {
    ok: false,
    status: 429,
    statusText: 'Too Many Requests',
    headers: new Headers(),
    json: async () => ({}),
    text: async () => 'rate limited',
  };
}

describe('getPdsFromDid / invalidatePdsCache', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM did_pds_cache').run();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('fetches from plc.directory on cache miss and writes cache', async () => {
    const fetchSpy = vi.fn().mockImplementation(async (url: string | URL) => {
      const u = url.toString();
      if (u.startsWith('https://plc.directory/')) return plcDocResponse(PLC_DID, FIRST_PDS);
      throw new Error(`Unexpected fetch: ${u}`);
    });
    globalThis.fetch = fetchSpy;

    const result = await getPdsFromDid(PLC_DID, env);

    expect(result).toEqual({ pdsUrl: FIRST_PDS, fromCache: false });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const row = await env.DB.prepare('SELECT pds_url FROM did_pds_cache WHERE did = ?')
      .bind(PLC_DID)
      .first<{ pds_url: string }>();
    expect(row?.pds_url).toBe(FIRST_PDS);
  });

  it('returns cached value without network on fresh hit', async () => {
    await env.DB.prepare(
      'INSERT INTO did_pds_cache (did, pds_url, updated_at) VALUES (?, ?, ?)'
    )
      .bind(PLC_DID, FIRST_PDS, Date.now())
      .run();

    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;

    const result = await getPdsFromDid(PLC_DID, env);

    expect(result).toEqual({ pdsUrl: FIRST_PDS, fromCache: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refreshes when cache is older than TTL (24h)', async () => {
    const staleAt = Date.now() - 25 * 60 * 60 * 1000; // 25h ago
    await env.DB.prepare(
      'INSERT INTO did_pds_cache (did, pds_url, updated_at) VALUES (?, ?, ?)'
    )
      .bind(PLC_DID, FIRST_PDS, staleAt)
      .run();

    const fetchSpy = vi.fn().mockImplementation(async (url: string | URL) => {
      if (url.toString().startsWith('https://plc.directory/'))
        return plcDocResponse(PLC_DID, SECOND_PDS);
      throw new Error(`Unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchSpy;

    const result = await getPdsFromDid(PLC_DID, env);

    expect(result).toEqual({ pdsUrl: SECOND_PDS, fromCache: false });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const row = await env.DB.prepare('SELECT pds_url, updated_at FROM did_pds_cache WHERE did = ?')
      .bind(PLC_DID)
      .first<{ pds_url: string; updated_at: number }>();
    expect(row?.pds_url).toBe(SECOND_PDS);
    expect(row!.updated_at).toBeGreaterThan(staleAt);
  });

  it('falls back to bsky.app AppView when plc.directory fails', async () => {
    const fetchSpy = vi.fn().mockImplementation(async (url: string | URL) => {
      const u = url.toString();
      if (u.startsWith('https://plc.directory/')) return rateLimitResponse();
      if (u.startsWith('https://api.bsky.app/xrpc/com.atproto.repo.describeRepo'))
        return describeRepoResponse(PLC_DID, FIRST_PDS);
      throw new Error(`Unexpected fetch: ${u}`);
    });
    globalThis.fetch = fetchSpy;

    const result = await getPdsFromDid(PLC_DID, env);

    expect(result).toEqual({ pdsUrl: FIRST_PDS, fromCache: false });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const row = await env.DB.prepare('SELECT pds_url FROM did_pds_cache WHERE did = ?')
      .bind(PLC_DID)
      .first<{ pds_url: string }>();
    expect(row?.pds_url).toBe(FIRST_PDS);
  });

  it('falls back to stale cache when both plc.directory and bsky.app fail', async () => {
    const staleAt = Date.now() - 25 * 60 * 60 * 1000;
    await env.DB.prepare(
      'INSERT INTO did_pds_cache (did, pds_url, updated_at) VALUES (?, ?, ?)'
    )
      .bind(PLC_DID, FIRST_PDS, staleAt)
      .run();

    globalThis.fetch = vi.fn().mockImplementation(async () => rateLimitResponse());

    const result = await getPdsFromDid(PLC_DID, env);

    expect(result).toEqual({ pdsUrl: FIRST_PDS, fromCache: true });
  });

  it('throws when network fails and there is no cache', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => notFoundResponse());

    await expect(getPdsFromDid(PLC_DID, env)).rejects.toThrow(/Could not resolve DID/);
  });

  it('resolves did:web without the bsky.app fallback', async () => {
    const fetchSpy = vi.fn().mockImplementation(async (url: string | URL) => {
      const u = url.toString();
      if (u === 'https://example.com/.well-known/did.json')
        return plcDocResponse(WEB_DID, FIRST_PDS);
      throw new Error(`Unexpected fetch: ${u}`);
    });
    globalThis.fetch = fetchSpy;

    const result = await getPdsFromDid(WEB_DID, env);

    expect(result).toEqual({ pdsUrl: FIRST_PDS, fromCache: false });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('throws on unsupported DID method', async () => {
    await expect(getPdsFromDid('did:nonsense:abc', env)).rejects.toThrow(/Unsupported DID method/);
  });

  it('invalidatePdsCache removes the entry', async () => {
    await env.DB.prepare(
      'INSERT INTO did_pds_cache (did, pds_url, updated_at) VALUES (?, ?, ?)'
    )
      .bind(PLC_DID, FIRST_PDS, Date.now())
      .run();

    await invalidatePdsCache(PLC_DID, env);

    const row = await env.DB.prepare('SELECT pds_url FROM did_pds_cache WHERE did = ?')
      .bind(PLC_DID)
      .first();
    expect(row).toBeNull();
  });
});

describe('auth login: cache-bust on stale PDS', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM did_pds_cache').run();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('evicts cache and re-resolves when fetchAuthServerMetadata fails on cached PDS', async () => {
    // Seed cache pointing at the OLD (now-stale) PDS.
    await env.DB.prepare(
      'INSERT INTO did_pds_cache (did, pds_url, updated_at) VALUES (?, ?, ?)'
    )
      .bind(PLC_DID, FIRST_PDS, Date.now())
      .run();

    const calls: string[] = [];
    globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
      const u = url.toString();
      calls.push(u);

      if (u.includes('com.atproto.identity.resolveHandle')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ did: PLC_DID }),
          text: async () => '',
        };
      }

      // Auth metadata against the stale PDS → 404. Against the fresh PDS → ok.
      if (u === `${FIRST_PDS}/.well-known/oauth-protected-resource`) return notFoundResponse();
      if (u === `${SECOND_PDS}/.well-known/oauth-protected-resource`) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ authorization_servers: ['https://auth.example.com'] }),
          text: async () => '',
        };
      }
      if (u === 'https://auth.example.com/.well-known/oauth-authorization-server') {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/oauth/authorize',
            token_endpoint: 'https://auth.example.com/oauth/token',
            pushed_authorization_request_endpoint: 'https://auth.example.com/oauth/par',
          }),
          text: async () => '',
        };
      }

      // After eviction, fresh DID lookup returns the NEW PDS.
      if (u.startsWith('https://plc.directory/')) return plcDocResponse(PLC_DID, SECOND_PDS);

      // PAR success → enough to complete the login handler.
      if (u === 'https://auth.example.com/oauth/par') {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ request_uri: 'urn:ietf:params:oauth:request_uri:ok' }),
          text: async () => '',
        };
      }

      throw new Error(`Unexpected fetch: ${u}`);
    });

    const request = new IncomingRequest(`http://localhost/api/auth/login?handle=${TEST_HANDLE}`, {
      headers: { Origin: env.FRONTEND_URL },
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { authUrl: string };
    expect(body.authUrl).toContain('auth.example.com/oauth/authorize');

    // We hit the stale PDS first, then plc.directory for re-resolution, then the new PDS.
    expect(calls).toContain(`${FIRST_PDS}/.well-known/oauth-protected-resource`);
    expect(calls).toContain(`${SECOND_PDS}/.well-known/oauth-protected-resource`);
    expect(calls.some((c) => c.startsWith('https://plc.directory/'))).toBe(true);

    // Cache should now point at the new PDS.
    const row = await env.DB.prepare('SELECT pds_url FROM did_pds_cache WHERE did = ?')
      .bind(PLC_DID)
      .first<{ pds_url: string }>();
    expect(row?.pds_url).toBe(SECOND_PDS);
  });
});
