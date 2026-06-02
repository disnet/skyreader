import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { api, SessionRefreshError } from './api';

// Regression coverage for the "logged out on deploy" fix. The backend now returns a
// retryable 503 for a live session whose token couldn't be refreshed yet, and a 401
// only for a genuine logout. The client must retry the former and only tear down auth
// on the latter.

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const SESSION_REFRESH_503 = () =>
  json(503, { error: 'session_refresh_pending', retryable: true }, { 'Retry-After': '2' });

let fetchMock: ReturnType<typeof vi.fn>;
let onUnauthorized: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  // The client fails fast when offline; keep it "online" for these tests.
  vi.stubGlobal('navigator', { onLine: true });
  onUnauthorized = vi.fn();
  api.setOnUnauthorized(onUnauthorized as () => void);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('api transient 503 (session_refresh_pending)', () => {
  it('transparently retries and resolves once the refresh lands — no logout', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(SESSION_REFRESH_503())
      .mockResolvedValueOnce(SESSION_REFRESH_503())
      .mockResolvedValueOnce(json(200, { did: 'did:plc:abc', handle: 'a.bsky.social' }));

    const promise = api.getMe();
    await vi.runAllTimersAsync();
    const user = await promise;

    expect(user).toMatchObject({ did: 'did:plc:abc' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('throws SessionRefreshError (keeping the user logged in) after exhausting retries', async () => {
    vi.useFakeTimers();
    // Always 503 — initial attempt + 4 retries = 5 calls, then give up. Use a fresh
    // Response per call (a Response body can only be read once).
    fetchMock.mockImplementation(async () => SESSION_REFRESH_503());

    const promise = api.getMe();
    const assertion = expect(promise).rejects.toBeInstanceOf(SessionRefreshError);
    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('does not retry a non-retryable 503 (treats it as a normal error)', async () => {
    fetchMock.mockResolvedValueOnce(json(503, { error: 'service unavailable' }));

    await expect(api.getMe()).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe('api genuine 401', () => {
  it('/auth/me 401 logs out immediately', async () => {
    fetchMock.mockResolvedValueOnce(json(401, { error: 'Unauthorized' }));

    await expect(api.getMe()).rejects.toThrow('Session expired');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('confirms a non-/auth/me 401 before logging out', async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, { error: 'Unauthorized' }))
      .mockResolvedValueOnce(json(401, { error: 'Unauthorized' }));

    await expect(api.getSettings()).rejects.toThrow('Session expired');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/auth/me',
      expect.objectContaining({ credentials: 'include' })
    );
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('does not log out when a non-/auth/me 401 is followed by a valid session probe', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(json(401, { error: 'Unauthorized' }))
      .mockResolvedValueOnce(json(200, { did: 'did:plc:abc', handle: 'a.bsky.social' }))
      .mockResolvedValueOnce(json(200, { pdsSyncEnabled: true, lastPdsSyncSubscriptions: null }));

    const promise = api.getSettings();
    await vi.runAllTimersAsync();
    const settings = await promise;

    expect(settings).toMatchObject({ pdsSyncEnabled: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('dedupes concurrent session probes after a burst of 401s', async () => {
    vi.useFakeTimers();

    let resolveProbe!: (response: Response) => void;
    const probeResponse = new Promise<Response>((resolve) => {
      resolveProbe = resolve;
    });
    let settingsCalls = 0;
    let integrationStatusCalls = 0;
    let probeCalls = 0;

    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/auth/me') {
        probeCalls += 1;
        return probeResponse;
      }

      if (url === '/api/settings') {
        settingsCalls += 1;
        return settingsCalls === 1
          ? json(401, { error: 'Unauthorized' })
          : json(200, { pdsSyncEnabled: true, lastPdsSyncSubscriptions: null });
      }

      if (url === '/api/integrations/status') {
        integrationStatusCalls += 1;
        return integrationStatusCalls === 1
          ? json(401, { error: 'Unauthorized' })
          : json(200, {
              semble: { connected: false },
              margin: { connected: false },
            });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const settingsPromise = api.getSettings();
    const integrationStatusPromise = api.getIntegrationStatus();

    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
    expect(probeCalls).toBe(1);

    resolveProbe(json(200, { did: 'did:plc:abc', handle: 'a.bsky.social' }));
    await vi.runAllTimersAsync();

    await expect(settingsPromise).resolves.toMatchObject({
      pdsSyncEnabled: true,
    });
    await expect(integrationStatusPromise).resolves.toMatchObject({
      semble: { connected: false },
    });
    expect(probeCalls).toBe(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe('extract() shares the same auth handling', () => {
  it('logs out on confirmed 401 (previously this raw-fetch path bypassed retry/logout logic)', async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, { error: 'Unauthorized' }))
      .mockResolvedValueOnce(json(401, { error: 'Unauthorized' }));

    await expect(api.extract('https://example.com/post')).rejects.toThrow('Session expired');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('retries a transient 503 instead of failing', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(SESSION_REFRESH_503())
      .mockResolvedValueOnce(json(200, { title: 'Hello', content: '<p>hi</p>' }));

    const promise = api.extract('https://example.com/post');
    await vi.runAllTimersAsync();
    const article = await promise;

    expect(article).toMatchObject({ title: 'Hello' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
