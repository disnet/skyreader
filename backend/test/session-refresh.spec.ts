import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// Regression coverage for the "logged out on deploy" bug. The auth gate must tell a
// genuinely-dead session (-> 401, log the user out) apart from a live session whose
// token just couldn't be refreshed this instant (-> 503 retryable, keep them in).

const TEST_DID = 'did:plc:sessionrefresh123';
const TEST_HANDLE = 'session-refresh.bsky.social';
const PDS_URL = 'https://test.pds.example';

async function setupUser() {
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, ?, ?, 'free', unixepoch())`
  )
    .bind(TEST_DID, TEST_HANDLE, PDS_URL)
    .run();
}

// Insert a session row with explicit refresh state so each scenario is deterministic.
async function insertSession(
  sessionId: string,
  opts: {
    expiresAt: number;
    refreshFailures?: number;
    refreshLockedUntil?: number | null;
  }
) {
  await env.DB.prepare(
    `INSERT INTO sessions
       (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key,
        expires_at, refresh_failures, refresh_locked_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      sessionId,
      TEST_DID,
      TEST_HANDLE,
      PDS_URL,
      'test-access-token',
      'test-refresh-token',
      JSON.stringify({ kty: 'EC' }),
      opts.expiresAt,
      opts.refreshFailures ?? 0,
      opts.refreshLockedUntil ?? null
    )
    .run();
}

function request(path: string, sessionId?: string, method = 'GET') {
  return new IncomingRequest(`http://localhost${path}`, {
    method,
    headers: {
      ...(sessionId ? { Cookie: `session_id=${sessionId}` } : {}),
      Origin: env.FRONTEND_URL,
    },
  });
}

async function call(path: string, sessionId?: string, method = 'GET') {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request(path, sessionId, method), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

beforeEach(async () => {
  await setupUser();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await env.DB.prepare('DELETE FROM sessions WHERE did = ?').bind(TEST_DID).run();
  await env.DB.prepare('DELETE FROM users WHERE did = ?').bind(TEST_DID).run();
});

describe('auth gate: live session', () => {
  it('returns 200 for a session whose token is comfortably valid', async () => {
    await insertSession('valid-session', { expiresAt: Date.now() + 3600_000 });
    const res = await call('/api/auth/me', 'valid-session');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { did: string };
    expect(body.did).toBe(TEST_DID);
  });
});

describe('auth gate: genuine logout (401)', () => {
  it('returns 401 when no credentials are presented', async () => {
    const res = await call('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns 401 when the session id matches no row', async () => {
    const res = await call('/api/auth/me', 'does-not-exist');
    expect(res.status).toBe(401);
  });

  it('returns 401 when the session has exhausted its refresh budget', async () => {
    // refresh_failures >= MAX_REFRESH_FAILURES (5) -> permanently dead, must re-auth.
    await insertSession('dead-session', {
      expiresAt: Date.now() + 3600_000,
      refreshFailures: 5,
    });
    const res = await call('/api/auth/me', 'dead-session');
    expect(res.status).toBe(401);
  });

  it('returns 401 (not 503) on a protected route for a permanently-dead session', async () => {
    await insertSession('dead-session-2', {
      expiresAt: Date.now() + 3600_000,
      refreshFailures: 5,
    });
    const res = await call('/api/settings', 'dead-session-2');
    expect(res.status).toBe(401);
  });
});

describe('auth gate: transient refresh failure (503, retryable)', () => {
  // Token is expired AND we're inside a refresh backoff window with retries left:
  // recoverable, so the client must retry rather than log out. This path returns
  // 'transient' without hitting the network (no refresh attempt is made).
  function transientOpts() {
    return {
      expiresAt: Date.now() - 1000, // already expired
      refreshFailures: 2, // below the cap of 5
      refreshLockedUntil: Date.now() + 60_000, // in backoff
    };
  }

  it('returns a retryable 503 instead of logging the user out', async () => {
    await insertSession('transient-session', transientOpts());
    const res = await call('/api/auth/me', 'transient-session');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; retryable: boolean };
    expect(body.retryable).toBe(true);
    expect(body.error).toBe('session_refresh_pending');
    expect(res.headers.get('Retry-After')).toBe('2');
  });

  it('also returns 503 on a protected (non-auth) route', async () => {
    await insertSession('transient-session-2', transientOpts());
    const res = await call('/api/settings', 'transient-session-2');
    expect(res.status).toBe(503);
  });

  it('does NOT block logout (public route) for a transient session', async () => {
    // A half-dead session must still be able to log out and clear its cookie.
    // Stub fetch so the best-effort token revocation doesn't make a real network call.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 }))
    );
    await insertSession('transient-logout', transientOpts());
    const res = await call('/api/auth/logout', 'transient-logout', 'POST');
    expect(res.status).not.toBe(503);
    expect(res.status).toBe(200);
    // Cookie is cleared regardless of refresh state.
    expect(res.headers.get('Set-Cookie')).toContain('session_id=');
  });
});
