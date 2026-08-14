import { env, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { handleDeepHealth } from '../src/routes/health';

const SECRET = 'correct-horse-battery-staple';

interface HealthBody {
  status: string;
  version: string;
  timestamp: number;
  checks?: Record<string, { ok: boolean; error?: string; [key: string]: unknown }>;
}

// A stand-in for the JetstreamPoller namespace that answers /status with a fixed
// body — the only way to drive the "alarm is mid-flight" window deterministically.
function envWithPollerStatus(status: Record<string, unknown>) {
  const namespace = {
    idFromName: () => 'stub-id',
    get: () => ({
      fetch: async () =>
        new Response(JSON.stringify(status), { headers: { 'Content-Type': 'application/json' } }),
    }),
  };
  return {
    ...env,
    HEALTH_CHECK_SECRET: SECRET,
    JETSTREAM_POLLER: namespace,
  } as unknown as Parameters<typeof handleDeepHealth>[1];
}

async function pollerCheck(status: Record<string, unknown>) {
  const response = await handleDeepHealth(
    new Request('http://localhost/api/health/deep', { headers: { 'X-Health-Secret': SECRET } }),
    envWithPollerStatus(status)
  );
  return ((await response.json()) as HealthBody).checks!.poller;
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

    // The DO reports `isRunning: !!getAlarm()`, and getAlarm() is null for the
    // whole time the alarm handler is executing — several seconds of every
    // minute. Treating that as "poller down" would page during normal operation,
    // which is exactly the false alert that teaches an operator to ignore the one
    // signal that catches a dead firehose.
    describe('poller freshness', () => {
      it('stays healthy while the alarm is mid-cycle', async () => {
        const poller = await pollerCheck({
          isRunning: false,
          nextPoll: null,
          lastAlarmStart: Date.now() - 3000,
          lastStats: { lastPollAt: Date.now() - 60_000 },
        });

        expect(poller.ok).toBe(true);
        expect(poller.isRunning).toBe(true);
        // …while still reporting the underlying fact, so the distinction is
        // visible to a human reading the body.
        expect(poller.alarmScheduled).toBe(false);
      });

      it('reports unhealthy when no alarm is scheduled and none ran recently', async () => {
        const poller = await pollerCheck({
          isRunning: false,
          nextPoll: null,
          lastAlarmStart: Date.now() - 10 * 60_000,
          lastStats: { lastPollAt: Date.now() - 30_000 },
        });

        expect(poller.ok).toBe(false);
        expect(poller.isRunning).toBe(false);
      });

      it('reports unhealthy when the last completed poll is stale', async () => {
        const poller = await pollerCheck({
          isRunning: true,
          nextPoll: Date.now() + 30_000,
          lastAlarmStart: Date.now() - 30_000,
          lastStats: { lastPollAt: Date.now() - 10 * 60_000 },
        });

        expect(poller.ok).toBe(false);
        expect(poller.lastPollAgeMs).toBeGreaterThan(5 * 60_000);
      });

      it('treats a cold DO with no completed poll as healthy', async () => {
        const poller = await pollerCheck({ isRunning: true, nextPoll: Date.now() + 1000 });

        expect(poller.ok).toBe(true);
        expect(poller.lastPollAgeMs).toBeNull();
      });
    });
  });
});
