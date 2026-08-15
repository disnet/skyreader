import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  decideLagAlert,
  worstLagMs,
  readSystemStatus,
  writeSystemStatus,
  recordPollerStatus,
  recordProxyStats,
  recordCronRun,
  writeMetricsSnapshot,
  runRecordingStep,
  FIREHOSE_LAG_ALERT_MS,
  FIREHOSE_LAG_REALERT_MS,
  SNAPSHOT_RETENTION_MS,
  type PollerStatusValue,
  type ProxyStatsValue,
  type CronLastRunValue,
} from '../src/observability/ops-metrics';
import type { Env } from '../src/types';

// Phase 2 of the observability plan: the cron stops discarding what it learns.

const HOUR_MS = 60 * 60 * 1000;

/** A JetstreamPoller namespace whose /status answers with a fixed body. */
function envWithPollerStatus(status: Record<string, unknown>): Env {
  return {
    ...env,
    JETSTREAM_POLLER: {
      idFromName: () => 'stub-id',
      get: () => ({
        fetch: async () =>
          new Response(JSON.stringify(status), { headers: { 'Content-Type': 'application/json' } }),
      }),
    },
  } as unknown as Env;
}

const pollerStatusBody = (lagMs: number | null) => ({
  lag: { subscriptionsMs: lagMs, documentsMs: lagMs === null ? null : Math.max(0, lagMs - 1000) },
  lastStats: {
    subscriptions: { processed: 3, errors: 1 },
    documents: { processed: 2, errors: 0 },
    duration: 4200,
    lastPollAt: 1_700_000_000_000,
  },
  isRunning: true,
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM system_status').run();
  await env.DB.prepare('DELETE FROM metrics_snapshots').run();
});

afterEach(() => vi.restoreAllMocks());

describe('system_status storage', () => {
  it('upserts rather than duplicating a key', async () => {
    await writeSystemStatus(env as Env, 'cron_last_run', { at: 1 }, 1000);
    await writeSystemStatus(env as Env, 'cron_last_run', { at: 2 }, 2000);

    const row = await readSystemStatus<{ at: number }>(env as Env, 'cron_last_run');
    expect(row).toEqual({ value: { at: 2 }, updatedAt: 2000 });

    const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM system_status').first<{
      c: number;
    }>();
    expect(count?.c).toBe(1);
  });

  it('treats an unparseable row as absent instead of throwing mid-cron', async () => {
    await env.DB.prepare('INSERT INTO system_status (key, value, updated_at) VALUES (?, ?, ?)')
      .bind('poller_status', 'not json', 1000)
      .run();

    expect(await readSystemStatus(env as Env, 'poller_status')).toBeNull();
  });
});

describe('firehose lag alerting', () => {
  it('takes the worse of the two stream lags, ignoring a stream with no cursor', () => {
    expect(worstLagMs(1000, 5000)).toBe(5000);
    expect(worstLagMs(null, 5000)).toBe(5000);
    expect(worstLagMs(1000, null)).toBe(1000);
    expect(worstLagMs(null, null)).toBeNull();
  });

  it('does not alert on unknown lag — a poller with no cursor yet is not late', () => {
    expect(decideLagAlert(null, null, 1000)).toEqual({
      alert: false,
      recovered: false,
      lagAlertAt: null,
    });
  });

  it('alerts once, then reminds only at the re-alert interval', () => {
    const high = FIREHOSE_LAG_ALERT_MS + 1;
    const now = 10_000_000;

    const first = decideLagAlert(high, null, now);
    expect(first.alert).toBe(true);
    expect(first.lagAlertAt).toBe(now);

    // A minute later the condition persists — no second event.
    const nextMinute = decideLagAlert(high, first.lagAlertAt, now + 60_000);
    expect(nextMinute.alert).toBe(false);
    expect(nextMinute.lagAlertAt).toBe(now);

    const afterInterval = decideLagAlert(high, first.lagAlertAt, now + FIREHOSE_LAG_REALERT_MS);
    expect(afterInterval.alert).toBe(true);
    expect(afterInterval.lagAlertAt).toBe(now + FIREHOSE_LAG_REALERT_MS);
  });

  it('clears the dedupe stamp on recovery so the next spike alerts immediately', () => {
    const recovered = decideLagAlert(1000, 5_000_000, 6_000_000);
    expect(recovered).toEqual({ alert: false, recovered: true, lagAlertAt: null });

    const nextSpike = decideLagAlert(FIREHOSE_LAG_ALERT_MS + 1, recovered.lagAlertAt, 6_000_001);
    expect(nextSpike.alert).toBe(true);
  });
});

describe('recordPollerStatus', () => {
  it('stores lag, last-cycle counts and alarm state', async () => {
    const value = await recordPollerStatus(envWithPollerStatus(pollerStatusBody(30_000)), 5000);

    expect(value.lagMs).toBe(30_000);
    expect(value.subscriptionsLagMs).toBe(30_000);
    expect(value.documentsLagMs).toBe(29_000);
    expect(value.processed).toBe(5);
    expect(value.errors).toBe(1);
    expect(value.alarmScheduled).toBe(true);
    expect(value.lagAlertAt).toBeNull();

    const row = await readSystemStatus<PollerStatusValue>(env as Env, 'poller_status');
    expect(row?.value.lagMs).toBe(30_000);
    expect(row?.updatedAt).toBe(5000);
  });

  it('logs and reports once when lag crosses the threshold, and stays quiet the next minute', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const late = envWithPollerStatus(pollerStatusBody(FIREHOSE_LAG_ALERT_MS + 60_000));
    const now = 1_000_000_000;

    await recordPollerStatus(late, now);
    await recordPollerStatus(late, now + 60_000);

    const alerts = errors.mock.calls
      .map(([entry]) => entry as { event?: string })
      .filter((entry) => entry?.event === 'firehose_lag_high');
    expect(alerts).toHaveLength(1);

    const row = await readSystemStatus<PollerStatusValue>(env as Env, 'poller_status');
    expect(row?.value.lagAlertAt).toBe(now);
  });

  it('throws when the poller cannot be reached, so the caller records the failure', async () => {
    const broken = {
      ...env,
      JETSTREAM_POLLER: {
        idFromName: () => 'stub-id',
        get: () => ({ fetch: async () => new Response('nope', { status: 500 }) }),
      },
    } as unknown as Env;

    await expect(recordPollerStatus(broken)).rejects.toThrow(/500/);
  });
});

describe('recordProxyStats', () => {
  it('stores cache freshness and error counts from the proxy', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          total: 200,
          fresh: 150,
          stale: 40,
          inFlight: 2,
          cacheTtlSeconds: 900,
          errors: { total: 7, inBackoff: 3, permanent: 1 },
        })
      )
    );

    const value = await recordProxyStats(
      { ...env, FEED_PROXY_URL: 'https://proxy.example', FEED_PROXY_SECRET: 'sekrit' } as Env,
      9000
    );

    expect(value.freshPct).toBe(75);
    expect(value.feedsInError).toBe(7);
    expect(value.feedsPermanentlyFailed).toBe(1);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://proxy.example/stats');
    expect((init.headers as Record<string, string>)['X-Proxy-Secret']).toBe('sekrit');

    const row = await readSystemStatus<ProxyStatsValue>(env as Env, 'proxy_stats');
    expect(row?.value.total).toBe(200);
  });

  it('reports an unknown fresh percentage for an empty cache rather than 0%', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ total: 0, fresh: 0, stale: 0 }))
    );

    const value = await recordProxyStats({
      ...env,
      FEED_PROXY_URL: 'https://proxy.example',
    } as Env);
    expect(value.freshPct).toBeNull();
  });
});

describe('writeMetricsSnapshot', () => {
  it('buckets to the hour so a second run replaces the point instead of duplicating it', async () => {
    const now = 3 * HOUR_MS + 12 * 60 * 1000;

    await writeMetricsSnapshot(env as Env, now);
    await writeMetricsSnapshot(env as Env, now + 20 * 60 * 1000);

    const rows = await env.DB.prepare('SELECT captured_at FROM metrics_snapshots').all<{
      captured_at: number;
    }>();
    expect(rows.results).toEqual([{ captured_at: 3 * HOUR_MS }]);
  });

  it('carries the health numbers across when they are fresh', async () => {
    const now = 100 * HOUR_MS;
    await writeSystemStatus(
      env as Env,
      'poller_status',
      { lagMs: 42_000 } as PollerStatusValue,
      now - 60_000
    );
    await writeSystemStatus(
      env as Env,
      'proxy_stats',
      { freshPct: 88.5 } as ProxyStatsValue,
      now - 60_000
    );

    await writeMetricsSnapshot(env as Env, now);

    const row = await env.DB.prepare(
      'SELECT firehose_lag_ms, proxy_fresh_pct FROM metrics_snapshots'
    ).first<{ firehose_lag_ms: number; proxy_fresh_pct: number }>();
    expect(row?.firehose_lag_ms).toBe(42_000);
    expect(row?.proxy_fresh_pct).toBe(88.5);
  });

  it('records null rather than a stale value nobody refreshed', async () => {
    const now = 200 * HOUR_MS;
    await writeSystemStatus(
      env as Env,
      'poller_status',
      { lagMs: 42_000 } as PollerStatusValue,
      now - 60 * 60 * 1000
    );

    await writeMetricsSnapshot(env as Env, now);

    const row = await env.DB.prepare('SELECT firehose_lag_ms FROM metrics_snapshots').first<{
      firehose_lag_ms: number | null;
    }>();
    expect(row?.firehose_lag_ms).toBeNull();
  });

  it('prunes points past the retention window', async () => {
    const now = 5000 * HOUR_MS;
    const old = now - SNAPSHOT_RETENTION_MS - HOUR_MS;
    await env.DB.prepare(
      `INSERT INTO metrics_snapshots (captured_at, users, feeds, feed_items, subscriptions,
        saved_articles, feeds_with_errors, active_sessions) VALUES (?, 0, 0, 0, 0, 0, 0, 0)`
    )
      .bind(old)
      .run();

    await writeMetricsSnapshot(env as Env, now);

    const rows = await env.DB.prepare('SELECT captured_at FROM metrics_snapshots').all<{
      captured_at: number;
    }>();
    expect(rows.results.map((r) => r.captured_at)).toEqual([now]);
  });
});

describe('recordCronRun', () => {
  it('stores the run so the admin can show liveness without a monitor', async () => {
    await recordCronRun(env as Env, { cron: '* * * * *', healthy: true, durationMs: 120 }, 7000);

    const row = await readSystemStatus<CronLastRunValue>(env as Env, 'cron_last_run');
    expect(row?.value).toEqual({
      at: 7000,
      cron: '* * * * *',
      healthy: true,
      durationMs: 120,
      version: 'dev',
    });
  });
});

describe('runRecordingStep', () => {
  it('swallows a failure — losing a data point must not withhold the heartbeat', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      runRecordingStep('poller-status', async () => {
        throw new Error('D1 blip');
      })
    ).resolves.toBeUndefined();

    const logged = errors.mock.calls
      .map(([entry]) => entry as { event?: string; step?: string })
      .find((entry) => entry?.event === 'ops_metrics_failed');
    expect(logged?.step).toBe('poller-status');
  });
});
