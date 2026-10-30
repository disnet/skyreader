import { SELF, env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { passesRequestGate } from '../src/services/rate-limit';
import { resolveSessionFromRequest, updateUserActivity } from '../src/services/oauth';
import { sha256Hex } from '../src/utils/sha256';
import type { Env } from '../src/types';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// The D1 limiter can't shield D1: a refused request has already cost a session
// read and a counter write. These pin what keeps a client loop off D1 instead.

const withGate = (limit: (opts: { key: string }) => Promise<{ success: boolean }>) =>
  ({ ...env, REQUEST_GATE: { limit: vi.fn(limit) } }) as unknown as Env;

const withCookie = (sessionId: string) =>
  new Request('http://localhost/api/saved', { headers: { Cookie: `session_id=${sessionId}` } });

describe('passesRequestGate', () => {
  it('lets a request with no credential through without counting it', async () => {
    const gated = withGate(async () => ({ success: false }));
    expect(await passesRequestGate(gated, new Request('http://localhost/api/saved'))).toBe(true);
    expect(gated.REQUEST_GATE.limit).not.toHaveBeenCalled();
  });

  it('counts a session by a hash of its credential, never the credential itself', async () => {
    const gated = withGate(async () => ({ success: true }));
    expect(await passesRequestGate(gated, withCookie('secret-session'))).toBe(true);
    const key = await sha256Hex(new TextEncoder().encode('secret-session'));
    expect(gated.REQUEST_GATE.limit).toHaveBeenCalledWith({ key });
  });

  it('counts a bearer token the same way as the cookie', async () => {
    const gated = withGate(async () => ({ success: true }));
    await passesRequestGate(
      gated,
      new Request('http://localhost/api/saved', {
        headers: { Authorization: 'Bearer secret-session' },
      })
    );
    const key = await sha256Hex(new TextEncoder().encode('secret-session'));
    expect(gated.REQUEST_GATE.limit).toHaveBeenCalledWith({ key });
  });

  it('refuses once the binding says the session is over its ceiling', async () => {
    const gated = withGate(async () => ({ success: false }));
    expect(await passesRequestGate(gated, withCookie('looping'))).toBe(false);
  });

  it('lets the request through when the binding errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const gated = withGate(async () => {
      throw new Error('binding down');
    });
    expect(await passesRequestGate(gated, withCookie('any'))).toBe(true);
  });

  it('refuses a looping client before the session lookup', async () => {
    const gated = withGate(async () => ({ success: false }));
    const prepare = vi.spyOn(env.DB, 'prepare');
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new IncomingRequest('http://localhost/api/saved', {
        headers: { Cookie: 'session_id=looping', Origin: env.FRONTEND_URL },
      }),
      gated,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('10');
    // Cross-origin, so the client can read how long to wait.
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('Retry-After');
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();
  });

  it('is wired to the binding the worker deploys with', async () => {
    const cookie = `session_id=gate-wired-${crypto.randomUUID()}`;
    const res = await SELF.fetch('http://localhost/api/saved', { headers: { Cookie: cookie } });
    // An unknown session is a 401 from the auth gate, past the request gate.
    expect(res.status).toBe(401);
  });
});

describe('resolveSessionFromRequest', () => {
  it('does not remember a lookup that failed', async () => {
    const request = withCookie(`memo-fail-${crypto.randomUUID()}`);
    const prepare = vi.spyOn(env.DB, 'prepare').mockImplementationOnce(() => {
      throw new Error('D1 DB is overloaded');
    });
    await expect(resolveSessionFromRequest(request, env)).rejects.toThrow('overloaded');
    prepare.mockRestore();
    await expect(resolveSessionFromRequest(request, env)).resolves.toMatchObject({
      session: null,
      reason: 'permanent',
    });
  });

  it('looks the session up once per request, however many times it is asked', async () => {
    const prepare = vi.spyOn(env.DB, 'prepare');
    const request = withCookie(`memo-${crypto.randomUUID()}`);
    const first = await resolveSessionFromRequest(request, env);
    const second = await resolveSessionFromRequest(request, env);
    expect(second).toEqual(first);
    const lookups = prepare.mock.calls.filter(([sql]) => sql.includes('FROM sessions'));
    expect(lookups).toHaveLength(1);
    prepare.mockRestore();
  });
});

describe('updateUserActivity', () => {
  async function seedUser(did: string, lastActiveAgo: number | null) {
    await env.DB.prepare(
      `INSERT INTO users (did, handle, pds_url, created_at, last_active_at)
       VALUES (?, ?, 'https://pds.test', unixepoch(), ?)`
    )
      .bind(
        did,
        `${did}.test`,
        lastActiveAgo === null ? null : Math.floor(Date.now() / 1000) - lastActiveAgo
      )
      .run();
  }
  const lastActive = async (did: string) =>
    (
      await env.DB.prepare('SELECT last_active_at FROM users WHERE did = ?')
        .bind(did)
        .first<{ last_active_at: number | null }>()
    )?.last_active_at;

  it('stamps a reader who has not been seen for a while', async () => {
    const did = `did:plc:activity-${crypto.randomUUID()}`;
    await seedUser(did, 3600);
    await updateUserActivity(env, did);
    expect(await lastActive(did)).toBeGreaterThan(Math.floor(Date.now() / 1000) - 5);
  });

  it('stamps a reader who has never been seen', async () => {
    const did = `did:plc:activity-${crypto.randomUUID()}`;
    await seedUser(did, null);
    await updateUserActivity(env, did);
    expect(await lastActive(did)).not.toBeNull();
  });

  it('skips the write when this isolate stamped the reader recently', async () => {
    const did = `did:plc:activity-${crypto.randomUUID()}`;
    await seedUser(did, 3600);
    await updateUserActivity(env, did);
    await env.DB.prepare('UPDATE users SET last_active_at = 0 WHERE did = ?').bind(did).run();
    await updateUserActivity(env, did);
    expect(await lastActive(did)).toBe(0);
  });

  it('leaves a recent stamp from another isolate alone', async () => {
    const did = `did:plc:activity-${crypto.randomUUID()}`;
    await seedUser(did, 60);
    const before = await lastActive(did);
    await updateUserActivity(env, did);
    expect(await lastActive(did)).toBe(before);
  });
});
