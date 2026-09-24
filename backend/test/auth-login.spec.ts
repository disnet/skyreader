import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// Mock auth server metadata response
const MOCK_AUTH_META = {
  issuer: 'https://bsky.social',
  authorization_endpoint: 'https://bsky.social/oauth/authorize',
  token_endpoint: 'https://bsky.social/oauth/token',
  pushed_authorization_request_endpoint: 'https://bsky.social/oauth/par',
  revocation_endpoint: 'https://bsky.social/oauth/revoke',
};

// Mock resource server metadata
function mockResourceMeta() {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      authorization_servers: ['https://bsky.social'],
    }),
    text: async () => '',
  };
}

// Mock auth server metadata
function mockAuthServerMeta() {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => MOCK_AUTH_META,
    text: async () => '',
  };
}

// Mock DID document for handle resolution
function mockDidDocument(did: string) {
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
          serviceEndpoint: 'https://pds.example.com',
        },
      ],
    }),
    text: async () => '',
  };
}

// Mock handle resolution
function mockHandleResolve(did: string) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ did }),
    text: async () => '',
  };
}

// Mock successful PAR response
function mockParResponse() {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      request_uri: 'urn:ietf:params:oauth:request_uri:test-request-uri',
    }),
    text: async () => '',
  };
}

// Mock invalid_client_metadata error response
function mockClientMetadataError() {
  return {
    ok: false,
    status: 400,
    headers: new Headers(),
    json: async () => ({ error: 'invalid_client_metadata' }),
    text: async () =>
      JSON.stringify({
        error: 'invalid_client_metadata',
        error_description: 'Unable to obtain client metadata',
      }),
  };
}

const TEST_DID = 'did:plc:testuser123';
const TEST_HANDLE = 'test.bsky.social';

describe('auth login PAR retry', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function setupFetchMock(parHandler: (callCount: number) => Response | object) {
    let parCallCount = 0;

    globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
      const urlStr = url.toString();

      // Handle resolution via public API
      if (urlStr.includes('com.atproto.identity.resolveHandle')) {
        return mockHandleResolve(TEST_DID);
      }

      // DID document resolution
      if (urlStr.includes('plc.directory') || urlStr.includes('did:plc:')) {
        return mockDidDocument(TEST_DID);
      }

      // Auth server metadata discovery
      if (urlStr.includes('.well-known/oauth-protected-resource')) {
        return mockResourceMeta();
      }
      if (urlStr.includes('.well-known/oauth-authorization-server')) {
        return mockAuthServerMeta();
      }

      // PAR endpoint
      if (urlStr.includes('/oauth/par')) {
        parCallCount++;
        return parHandler(parCallCount);
      }

      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    return () => parCallCount;
  }

  it('retries PAR on invalid_client_metadata and succeeds', async () => {
    const getParCallCount = setupFetchMock((callCount) => {
      if (callCount === 1) {
        return mockClientMetadataError();
      }
      return mockParResponse();
    });

    const request = new IncomingRequest(`http://localhost/api/auth/login?handle=${TEST_HANDLE}`, {
      headers: { Origin: env.FRONTEND_URL },
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { authUrl: string };
    expect(body.authUrl).toContain('oauth/authorize');
    expect(body.authUrl).toContain('request_uri');

    // PAR should have been called twice (initial + retry)
    expect(getParCallCount()).toBe(2);
  });

  it('fails after PAR retry if still invalid_client_metadata', async () => {
    const getParCallCount = setupFetchMock(() => {
      return mockClientMetadataError();
    });

    const request = new IncomingRequest(`http://localhost/api/auth/login?handle=${TEST_HANDLE}`, {
      headers: { Origin: env.FRONTEND_URL },
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('PAR request failed');

    // PAR should have been called twice (initial + retry)
    expect(getParCallCount()).toBe(2);
  });

  it('does not retry PAR on non-client-metadata errors', async () => {
    const getParCallCount = setupFetchMock(() => {
      return {
        ok: false,
        status: 400,
        headers: new Headers(),
        json: async () => ({ error: 'invalid_request' }),
        text: async () => JSON.stringify({ error: 'invalid_request' }),
      };
    });

    const request = new IncomingRequest(`http://localhost/api/auth/login?handle=${TEST_HANDLE}`, {
      headers: { Origin: env.FRONTEND_URL },
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('PAR request failed');

    // PAR should only be called once (no retry)
    expect(getParCallCount()).toBe(1);
  });
});

describe('progressive scope requests', () => {
  const originalFetch = globalThis.fetch;
  const SESSION = 'progressive-scope-session';
  let parBodies: URLSearchParams[] = [];
  // Scopes the mock PDS refuses as invalid_scope, like a set it can't resolve.
  let unresolvable: string[] = [];

  beforeEach(async () => {
    parBodies = [];
    unresolvable = [];
    await env.DB.prepare('DELETE FROM sessions WHERE did = ?').bind(TEST_DID).run();
    await env.DB.prepare('DELETE FROM users WHERE did = ?').bind(TEST_DID).run();
    await env.DB.prepare('DELETE FROM oauth_state').run();
    globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes('com.atproto.identity.resolveHandle')) return mockHandleResolve(TEST_DID);
      if (urlStr.includes('plc.directory') || urlStr.includes('did:plc:')) {
        return mockDidDocument(TEST_DID);
      }
      if (urlStr.includes('.well-known/oauth-protected-resource')) return mockResourceMeta();
      if (urlStr.includes('.well-known/oauth-authorization-server')) return mockAuthServerMeta();
      if (urlStr.includes('/oauth/par')) {
        const body = new URLSearchParams(init?.body as string);
        parBodies.push(body);
        const scope = body.get('scope')?.split(' ') ?? [];
        const refused = scope.find((s) => unresolvable.includes(s));
        if (refused) {
          const error = JSON.stringify({
            error: 'invalid_scope',
            error_description: `Could not resolve Lexicon for NSID (${refused.slice('include:'.length)})`,
          });
          return { ok: false, status: 400, headers: new Headers(), text: async () => error };
        }
        return mockParResponse();
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function call(path: string, init: RequestInit = {}, workerEnv: typeof env = env) {
    const request = new IncomingRequest(`http://localhost${path}`, {
      ...init,
      headers: { Origin: env.FRONTEND_URL, ...(init.headers ?? {}) },
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, workerEnv, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }

  const requestedScope = () => parBodies.at(-1)?.get('scope')?.split(' ') ?? [];

  async function seedUser(oauthFeatures: string | null) {
    await env.DB.prepare(
      `INSERT INTO users (did, handle, pds_url, created_at, oauth_features) VALUES (?, ?, 'https://pds.example.com', unixepoch(), ?)`
    )
      .bind(TEST_DID, TEST_HANDLE, oauthFeatures)
      .run();
  }

  it('signs in with only the base scopes by default', async () => {
    const response = await call(`/api/auth/login?handle=${TEST_HANDLE}`);
    expect(response.status).toBe(200);
    const scope = requestedScope();
    expect(scope).toContain('atproto');
    expect(scope).toContain('repo:app.skyreader.feed.subscription');
    expect(scope).not.toContain('repo:network.cosmik.card');
    expect(scope).not.toContain('repo:site.standard.document');
  });

  it('adds the features the caller asks for', async () => {
    await call(`/api/auth/login?handle=${TEST_HANDLE}&features=semble,linkblog`);
    expect(requestedScope()).toEqual(
      expect.arrayContaining(['repo:network.cosmik.card', 'repo:site.standard.document'])
    );
  });

  it('rejects an unknown feature', async () => {
    const response = await call(`/api/auth/login?handle=${TEST_HANDLE}&features=everything`);
    expect(response.status).toBe(400);
  });

  it('asks again for the features the account granted last time', async () => {
    await seedUser('margin');
    await call(`/api/auth/login?handle=${TEST_HANDLE}`);
    expect(requestedScope()).toContain('repo:at.margin.note');
    expect(requestedScope()).not.toContain('repo:network.cosmik.card');
  });

  it('upgrades a live session without dropping what it already holds', async () => {
    await seedUser(null);
    await env.DB.prepare(
      `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
       VALUES (?, ?, ?, 'https://pds.example.com', 'tok', 'rtok', ?, ?, ?)`
    )
      .bind(
        SESSION,
        TEST_DID,
        TEST_HANDLE,
        JSON.stringify({ kty: 'EC' }),
        Date.now() + 3_600_000,
        'atproto repo:app.skyreader.feed.subscription repo:app.skyreader.social.follow repo:at.margin.note repo:at.margin.collection repo:at.margin.collectionItem'
      )
      .run();

    const response = await call('/api/auth/upgrade', {
      method: 'POST',
      headers: { Cookie: `session_id=${SESSION}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ features: ['semble'], returnUrl: '/settings' }),
    });
    expect(response.status).toBe(200);
    const scope = requestedScope();
    expect(scope).toEqual(
      expect.arrayContaining(['repo:network.cosmik.card', 'repo:at.margin.note'])
    );
    expect(parBodies.at(-1)?.get('login_hint')).toBe(TEST_DID);

    const state = await env.DB.prepare(
      'SELECT replace_session_id, return_url FROM oauth_state'
    ).first<{ replace_session_id: string; return_url: string }>();
    expect(state).toEqual({ replace_session_id: SESSION, return_url: '/settings' });
  });

  it("falls back to granular scopes when the PDS can't resolve a permission set", async () => {
    const setsOn = { ...env, OAUTH_PERMISSION_SETS: 'true' };
    unresolvable = ['include:app.userinput.authBasic'];
    await seedUser('feedback');

    const response = await call(`/api/auth/login?handle=${TEST_HANDLE}`, {}, setsOn);
    expect(response.status).toBe(200);
    expect(parBodies).toHaveLength(2);
    expect(parBodies[0].get('scope')?.split(' ')).toContain('include:app.userinput.authBasic');
    const scope = requestedScope();
    expect(scope.some((s) => s.startsWith('include:'))).toBe(false);
    expect(scope).toEqual(
      expect.arrayContaining([
        'repo:app.skyreader.feed.subscription',
        'repo:app.userinput.discussion',
      ])
    );

    // The callback falls back to the stored scope, so it must be what was asked for.
    const state = await env.DB.prepare('SELECT scope FROM oauth_state').first<{ scope: string }>();
    expect(state?.scope).toBe(parBodies[1].get('scope'));
  });

  it('does not retry an invalid_scope when nothing was asked for through a set', async () => {
    unresolvable = ['repo:app.skyreader.feed.subscription'];
    const response = await call(`/api/auth/login?handle=${TEST_HANDLE}`);
    expect(response.status).toBe(500);
    expect(parBodies).toHaveLength(1);
  });

  it('requires a session to upgrade', async () => {
    const response = await call('/api/auth/upgrade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ features: ['semble'] }),
    });
    expect(response.status).toBe(401);
  });
});
