import { env, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { handleDeepHealth } from '../src/routes/health';

const SECRET = 'correct-horse-battery-staple';

interface HealthBody {
  status: string;
  version: string;
  timestamp: number;
  checks?: Record<string, { ok: boolean; error?: string }>;
}

describe('health endpoints', () => {
  describe('GET /api/health', () => {
    it('is reachable without a session and reports status + version', async () => {
      const response = await SELF.fetch('http://localhost/api/health');
      expect(response.status).toBe(200);

      const body = (await response.json()) as HealthBody;
      expect(body.status).toBe('ok');
      // No GIT_COMMIT_SHA in tests, so the fallback stamp.
      expect(body.version).toBe('dev');
      expect(typeof body.timestamp).toBe('number');
    });

    it('is not cacheable', async () => {
      const response = await SELF.fetch('http://localhost/api/health');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    });

    it('ignores a bogus Authorization header rather than 401ing', async () => {
      const response = await SELF.fetch('http://localhost/api/health', {
        headers: { Authorization: 'Bearer nonsense' },
      });
      expect(response.status).toBe(200);
    });
  });

  describe('GET /api/health/deep', () => {
    it('fails closed when HEALTH_CHECK_SECRET is unset', async () => {
      expect(env.HEALTH_CHECK_SECRET).toBeUndefined();

      const response = await SELF.fetch('http://localhost/api/health/deep');
      expect(response.status).toBe(503);
      expect(((await response.json()) as HealthBody).status).toBe('unconfigured');
    });

    // The secret is a wrangler secret, not a test binding, so these drive the
    // handler directly with an env that has one.
    const configuredEnv = { ...env, HEALTH_CHECK_SECRET: SECRET } as unknown as Parameters<
      typeof handleDeepHealth
    >[1];

    it('rejects a wrong secret with 401', async () => {
      const response = await handleDeepHealth(
        new Request('http://localhost/api/health/deep', {
          headers: { 'X-Health-Secret': 'wrong' },
        }),
        configuredEnv
      );
      expect(response.status).toBe(401);
    });

    it('rejects a missing secret with 401', async () => {
      const response = await handleDeepHealth(
        new Request('http://localhost/api/health/deep'),
        configuredEnv
      );
      expect(response.status).toBe(401);
    });

    it('runs the dependency checks with the right secret', async () => {
      const response = await handleDeepHealth(
        new Request('http://localhost/api/health/deep', {
          headers: { 'X-Health-Secret': SECRET },
        }),
        configuredEnv
      );

      // The feed proxy isn't reachable from the test worker, so the aggregate
      // verdict may well be degraded — what matters is that each dependency
      // reports independently instead of the whole endpoint throwing.
      const body = (await response.json()) as HealthBody;
      expect([200, 503]).toContain(response.status);
      expect(body.checks).toBeDefined();
      expect(body.checks!.database.ok).toBe(true);
      expect(body.checks!.poller).toBeDefined();
      expect(body.checks!.feedProxy).toBeDefined();
      const allOk = body.checks!.database.ok && body.checks!.poller.ok && body.checks!.feedProxy.ok;
      expect(body.status).toBe(allOk ? 'ok' : 'degraded');
      expect(response.status).toBe(allOk ? 200 : 503);
    });
  });
});
