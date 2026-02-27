import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, afterEach, vi } from 'vitest';
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
