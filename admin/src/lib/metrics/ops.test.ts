import { describe, it, expect } from 'vitest';
import { opsMetricsFrom, trendsFrom, formatAge } from './ops';
import type { OpsStatus, SnapshotRow } from '$lib/queries/ops';

// The ops tiles are read during an incident, so the failure that matters is a
// confident-looking number that is actually old. These pin the staleness rules.

const NOW = 1_700_000_000_000;
const MINUTE = 60 * 1000;

const status = (overrides: Partial<OpsStatus> = {}): OpsStatus => ({
  cron: {
    updatedAt: NOW - 30 * 1000,
    value: {
      at: NOW - 30 * 1000,
      cron: '* * * * *',
      healthy: true,
      durationMs: 90,
      version: 'abc',
    },
  },
  poller: {
    updatedAt: NOW - 30 * 1000,
    value: {
      lagMs: 20_000,
      subscriptionsLagMs: 20_000,
      documentsLagMs: 15_000,
      lastPollAt: NOW - 45 * 1000,
      lastPollDurationMs: 4200,
      processed: 12,
      errors: 0,
      alarmScheduled: true,
    },
  },
  proxy: {
    updatedAt: NOW - 2 * MINUTE,
    value: {
      total: 400,
      fresh: 390,
      stale: 8,
      freshPct: 97.5,
      inFlight: 1,
      feedsInError: 0,
      feedsInBackoff: 0,
      feedsPermanentlyFailed: 0,
      cacheTtlSeconds: 900,
    },
  },
  ...overrides,
});

const tile = (metrics: ReturnType<typeof opsMetricsFrom>, label: string) =>
  metrics.find((m) => m.label === label)!;

describe('ops tiles', () => {
  it('reads healthy across the board on a live system', () => {
    const metrics = opsMetricsFrom(status(), NOW);
    expect(metrics.every((m) => m.status === 'healthy')).toBe(true);
    expect(tile(metrics, 'Cron Last Run').value).toBe('30s ago');
  });

  it('flags a cron that ran recently but failed', () => {
    const s = status();
    s.cron!.value.healthy = false;
    expect(tile(opsMetricsFrom(s, NOW), 'Cron Last Run').status).toBe('error');
  });

  it('escalates the cron tile as the gap grows', () => {
    const stale = (ageMs: number) => {
      const s = status();
      s.cron!.value.at = NOW - ageMs;
      return tile(opsMetricsFrom(s, NOW), 'Cron Last Run').status;
    };
    expect(stale(2 * MINUTE)).toBe('healthy');
    expect(stale(5 * MINUTE)).toBe('warning');
    expect(stale(30 * MINUTE)).toBe('error');
  });

  it('turns red at the same lag the backend alerts on', () => {
    const lag = (lagMs: number | null) => {
      const s = status();
      s.poller!.value.lagMs = lagMs;
      return tile(opsMetricsFrom(s, NOW), 'Firehose Lag');
    };
    expect(lag(60_000).status).toBe('healthy');
    expect(lag(6 * MINUTE).status).toBe('warning');
    expect(lag(20 * MINUTE).status).toBe('error');
    // No cursor yet is unknown, not zero.
    expect(lag(null).value).toBe('—');
  });

  it('says "stale" instead of showing poller numbers nobody refreshed', () => {
    // The cron is alive but its DO /status fetch has been failing for an hour, so
    // the row still holds an hour-old lag of 20s. The tiles must not read green.
    const s = status();
    s.poller!.updatedAt = NOW - 60 * MINUTE;
    const metrics = opsMetricsFrom(s, NOW);
    for (const label of ['Firehose Lag', 'Last Poll', 'Poll Errors (last cycle)']) {
      expect(tile(metrics, label).status).toBe('error');
      expect(String(tile(metrics, label).value)).toContain('Stale');
    }
  });

  it('tolerates a single missed poller write', () => {
    const s = status();
    s.poller!.updatedAt = NOW - 2 * MINUTE;
    expect(tile(opsMetricsFrom(s, NOW), 'Firehose Lag').status).toBe('healthy');
  });

  it('says "stale" instead of showing proxy numbers nobody refreshed', () => {
    const s = status();
    s.proxy!.updatedAt = NOW - 40 * MINUTE;
    const metrics = opsMetricsFrom(s, NOW);
    expect(tile(metrics, 'Proxy Cache Fresh').status).toBe('error');
    expect(String(tile(metrics, 'Proxy Cache Fresh').value)).toContain('Stale');
  });

  it('grades cache freshness against the 95% SLO', () => {
    const fresh = (pct: number | null) => {
      const s = status();
      s.proxy!.value.freshPct = pct;
      return tile(opsMetricsFrom(s, NOW), 'Proxy Cache Fresh').status;
    };
    expect(fresh(99)).toBe('healthy');
    expect(fresh(90)).toBe('warning');
    expect(fresh(50)).toBe('error');
    // An empty cache has no percentage to grade.
    expect(fresh(null)).toBe('warning');
  });

  it('renders a full set of tiles before the cron has ever run', () => {
    const metrics = opsMetricsFrom({ cron: null, poller: null, proxy: null }, NOW);
    expect(metrics).toHaveLength(6);
    expect(metrics.every((m) => m.status === 'error')).toBe(true);
  });
});

describe('trend series', () => {
  const row = (capturedAt: number, overrides: Partial<SnapshotRow> = {}): SnapshotRow => ({
    captured_at: capturedAt,
    users: 10,
    feeds: 20,
    feed_items: 30,
    subscriptions: 40,
    saved_articles: 50,
    feeds_with_errors: 1,
    active_sessions: 5,
    firehose_lag_ms: 1000,
    proxy_fresh_pct: 98,
    ...overrides,
  });

  const HOUR = 60 * MINUTE;
  const lagOf = (rows: SnapshotRow[], now = rows.at(-1)?.captured_at ?? NOW) =>
    trendsFrom(rows, now).series.find((s) => s.key === 'firehose_lag_ms')!.points;

  it('keeps a missing value as a gap rather than a zero', () => {
    expect(
      lagOf([
        row(NOW),
        row(NOW + HOUR, { firehose_lag_ms: null }),
        row(NOW + 2 * HOUR, { firehose_lag_ms: 2000 }),
      ])
    ).toEqual([1000, null, 2000]);
  });

  it('keeps an hour with no snapshot at all as a gap', () => {
    // The cron was down for two hours: three rows, but five hours of timeline.
    expect(lagOf([row(NOW), row(NOW + 3 * HOUR), row(NOW + 4 * HOUR)])).toEqual([
      1000,
      null,
      null,
      1000,
      1000,
    ]);
  });

  it('reports the real span of the history it holds', () => {
    const trends = trendsFrom([row(NOW), row(NOW + 5 * HOUR)], NOW + 5 * HOUR);
    expect(trends.from).toBe(NOW);
    expect(trends.to).toBe(NOW + 5 * HOUR);
    expect(trends.series[0].points).toHaveLength(6);
  });

  it('shows missing trailing snapshots as a gap through the current hour', () => {
    expect(lagOf([row(NOW), row(NOW + HOUR)], NOW + 4 * HOUR)).toEqual([
      1000,
      1000,
      null,
      null,
      null,
    ]);
  });

  it('is empty but well-formed with no history', () => {
    const trends = trendsFrom([]);
    expect(trends.from).toBeNull();
    expect(trends.series.every((s) => s.points.length === 0)).toBe(true);
  });
});

describe('formatAge', () => {
  it('picks a unit a human reads at a glance', () => {
    expect(formatAge(30_000)).toBe('30s');
    expect(formatAge(5 * MINUTE)).toBe('5m');
    expect(formatAge(3 * 60 * MINUTE)).toBe('3h');
    expect(formatAge(5 * 24 * 60 * MINUTE)).toBe('5d');
  });
});
