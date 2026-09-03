import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  decideLagAlert,
  readSystemStatus,
  writeSystemStatus,
  recordPollerStatus,
  recordProxyStats,
  recordCronRun,
  writeMetricsSnapshot,
  runRecordingStep,
  decideFrozenAlert,
  FIREHOSE_LAG_ALERT_MS,
  FIREHOSE_LAG_REALERT_MS,
  DOCUMENT_FROZEN_MIN_AUTHORS,
  DOCUMENT_FROZEN_REALERT_MS,
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
  lag: { subscriptionsMs: lagMs },
  lastStats: {
    subscriptions: { processed: 3, errors: 1 },
    duration: 4200,
    lastPollAt: 1_700_000_000_000,
  },
  isRunning: true,
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM system_status').run();
  await env.DB.prepare('DELETE FROM metrics_snapshots').run();
  await env.DB.prepare('DELETE FROM feeds').run();
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

// The threshold this replaced was `frozen > 0`, which made one stuck author out
// of ~300 re-announce itself every half hour for two days. An alert nobody can
// act on is an alert people learn to scroll past, which is the failure mode the
// pruning ritual in the runbook exists to prevent.
describe('document cache frozen alerting', () => {
  const now = 10_000_000;
  /** Frozen twice running, which is the precondition for any alert at all. */
  const settled = (frozen: number, active: number, at: number | null = null) =>
    decideFrozenAlert({ frozen, active }, { frozen, active }, at, now);

  it('stays quiet for a straggler or two in a healthy population', () => {
    // Each of these is a real, bounded gap in one author's list, and the
    // per-request floor re-list heals it on the next poll.
    expect(settled(1, 296).alert).toBe(false);
    expect(settled(2, 296).alert).toBe(false);
  });

  it('alerts once re-listing looks broken rather than unlucky', () => {
    expect(settled(DOCUMENT_FROZEN_MIN_AUTHORS, 296).alert).toBe(true);
  });

  it('alerts below the floor when the frozen share is large', () => {
    // A quiet environment: two of four authors frozen is systemic even though
    // an absolute count of two says nothing on its own.
    expect(settled(2, 4).alert).toBe(true);
    expect(settled(1, 100).alert).toBe(false);
  });

  it('needs two samples to agree before it fires', () => {
    // A sample taken while a legitimate re-list is in flight can read high.
    expect(
      decideFrozenAlert({ frozen: 50, active: 296 }, { frozen: 0, active: 296 }, null, now).alert
    ).toBe(false);
    expect(
      decideFrozenAlert({ frozen: 50, active: 296 }, { frozen: 50, active: 296 }, null, now).alert
    ).toBe(true);
  });

  it('measures the previous sample against the threshold, not against zero', () => {
    // The steady state this floor tolerates is a straggler or two, so a
    // previous sample of 1 is the normal case, not evidence of agreement.
    expect(
      decideFrozenAlert({ frozen: 50, active: 296 }, { frozen: 1, active: 296 }, null, now).alert
    ).toBe(false);
    // Two consecutive samples over the ratio agree even in a tiny population,
    // where the previous count is far below the absolute floor.
    expect(
      decideFrozenAlert({ frozen: 2, active: 4 }, { frozen: 2, active: 4 }, null, now).alert
    ).toBe(true);
  });

  it('reminds daily, not every five minutes, while the condition holds', () => {
    const first = settled(10, 296);
    expect(first.alert).toBe(true);
    expect(first.frozenAlertAt).toBe(now);

    const held = { frozen: 10, active: 296 };
    const fiveMinutes = decideFrozenAlert(held, held, first.frozenAlertAt, now + 5 * 60_000);
    expect(fiveMinutes.alert).toBe(false);
    expect(fiveMinutes.frozenAlertAt).toBe(now);

    // What the old 30-minute cadence would have done, and no longer does.
    const halfHour = decideFrozenAlert(held, held, first.frozenAlertAt, now + 30 * 60_000);
    expect(halfHour.alert).toBe(false);

    const nextDay = decideFrozenAlert(
      held,
      held,
      first.frozenAlertAt,
      now + DOCUMENT_FROZEN_REALERT_MS
    );
    expect(nextDay.alert).toBe(true);
  });

  it('clears the stamp on recovery so a fresh outbreak alerts immediately', () => {
    const recovered = decideFrozenAlert(
      { frozen: 0, active: 296 },
      { frozen: 10, active: 296 },
      now,
      now + 60_000
    );
    expect(recovered).toEqual({ alert: false, frozenAlertAt: null });

    expect(
      decideFrozenAlert(
        { frozen: 10, active: 296 },
        { frozen: 10, active: 296 },
        recovered.frozenAlertAt,
        now + 120_000
      ).alert
    ).toBe(true);
  });

  it('keeps the stamp while the count dips under the threshold', () => {
    // Otherwise a condition oscillating around the line re-announces itself
    // every time it crosses back over.
    const dipped = decideFrozenAlert(
      { frozen: 1, active: 296 },
      { frozen: 1, active: 296 },
      now,
      now + 60_000
    );
    expect(dipped.alert).toBe(false);
    expect(dipped.frozenAlertAt).toBe(now);

    expect(
      decideFrozenAlert(
        { frozen: 10, active: 296 },
        { frozen: 10, active: 296 },
        dipped.frozenAlertAt,
        now + 120_000
      ).alert
    ).toBe(false);
  });
});

describe('recordPollerStatus', () => {
  it('stores lag, last-cycle counts and alarm state', async () => {
    const value = await recordPollerStatus(envWithPollerStatus(pollerStatusBody(30_000)), 5000);

    expect(value.lagMs).toBe(30_000);
    expect(value.processed).toBe(3);
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

  it('keeps a single frozen author off the wire', async () => {
    // The shape that produced 93 events: one stuck author out of ~300, sampled
    // every five minutes. It is recorded, and the admin tile shows it; it is
    // not an alert.
    const proxyEnv = { ...env, FEED_PROXY_URL: 'https://proxy.example' } as Env;
    const body = () =>
      new Response(JSON.stringify({ total: 1, fresh: 1, documents: { active: 296, frozen: 1 } }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => body());
    const reported = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await recordProxyStats(proxyEnv, 1_000);
    const value = await recordProxyStats(proxyEnv, 1_000 + 5 * 60_000);

    expect(value.documentAuthorsFrozen).toBe(1);
    expect(value.documentFrozenAlertAt).toBeNull();
    expect(
      reported.mock.calls.some(
        ([entry]) => (entry as { event?: string })?.event === 'document_cache_frozen'
      )
    ).toBe(false);
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
      { freshPct: 88.5, feedsInError: 7 } as ProxyStatsValue,
      now - 60_000
    );

    await writeMetricsSnapshot(env as Env, now);

    const row = await env.DB.prepare(
      'SELECT firehose_lag_ms, proxy_fresh_pct, feeds_with_errors FROM metrics_snapshots'
    ).first<{ firehose_lag_ms: number; proxy_fresh_pct: number; feeds_with_errors: number }>();
    expect(row?.firehose_lag_ms).toBe(42_000);
    expect(row?.proxy_fresh_pct).toBe(88.5);
    // Per-feed errors come from the crawler now — `feeds` has no error column.
    expect(row?.feeds_with_errors).toBe(7);
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

    const row = await env.DB.prepare(
      'SELECT firehose_lag_ms, feeds_with_errors FROM metrics_snapshots'
    ).first<{ firehose_lag_ms: number | null; feeds_with_errors: number | null }>();
    expect(row?.firehose_lag_ms).toBeNull();
    // No proxy row at all: unknown, not "zero feeds are erroring".
    expect(row?.feeds_with_errors).toBeNull();
  });

  it('counts the feeds the crawler ingests into, not the dropped feed_metadata', async () => {
    const now = 300 * HOUR_MS;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO feeds (feed_url, title, last_ingest_at) VALUES ('https://a.example/f', 'A', 1)"
      ),
      env.DB.prepare(
        "INSERT INTO feeds (feed_url, title, last_ingest_at) VALUES ('https://b.example/f', 'B', 2)"
      ),
    ]);

    await writeMetricsSnapshot(env as Env, now);

    const row = await env.DB.prepare('SELECT feeds FROM metrics_snapshots').first<{
      feeds: number;
    }>();
    expect(row?.feeds).toBe(2);
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
