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
  it('logs out immediately (no probe, no retry)', async () => {
    fetchMock.mockResolvedValueOnce(json(401, { error: 'Unauthorized' }));

    await expect(api.getMe()).rejects.toThrow('Session expired');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});

describe('extract() shares the same auth handling', () => {
  it('logs out on 401 (previously this raw-fetch path bypassed retry/logout logic)', async () => {
    fetchMock.mockResolvedValueOnce(json(401, { error: 'Unauthorized' }));

    await expect(api.extract('https://example.com/post')).rejects.toThrow('Session expired');
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
