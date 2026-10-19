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
      lastPollAt: NOW - 45 * 1000,
      lastPollDurationMs: 4200,
      processed: 12,
      errors: 0,
      alarmScheduled: true,
      documentsLagMs: 30_000,
      documentsProcessed: 3,
      documentsErrors: 0,
      documentsCapStreak: 0,
      documentsAuthors: 42,
      documentsIngestPaused: false,
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
      crawlCycleSeconds: 480,
      crawlTargetCycleSeconds: 3600,
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
    expect(tile(metrics, 'Crawl Cycle').status).toBe('error');
    expect(String(tile(metrics, 'Crawl Cycle').value)).toContain('Stale');
  });

  it('grades the crawl cycle against the target the proxy accepts', () => {
    const cycle = (seconds: number | null | undefined, target: number | null = 3600) => {
      const s = status();
      s.proxy!.value.crawlCycleSeconds = seconds;
      s.proxy!.value.crawlTargetCycleSeconds = target;
      return tile(opsMetricsFrom(s, NOW), 'Crawl Cycle');
    };
    // The deliberate ~8-minute cycle is the healthy steady state, whatever share
    // of the cache sits inside its 5-minute TTL.
    expect(cycle(480).status).toBe('healthy');
    expect(cycle(480).value).toBe('8m');
    expect(cycle(90 * 60).status).toBe('warning');
    expect(cycle(3 * 3600).status).toBe('error');
    // No target reported: the proxy's own default (1h).
    expect(cycle(90 * 60, null).status).toBe('warning');
    // Idle or all broken; the errors tile says which.
    expect(cycle(0).status).toBe('warning');
    // A row written before the backend recorded the cycle.
    expect(cycle(undefined).value).toBe('Not reported');
  });

  it('grades feed errors on the failing share, not on parked feeds', () => {
    const errors = (inError: number, parked: number, total = 1876) => {
      const s = status();
      s.proxy!.value.total = total;
      s.proxy!.value.feedsInError = inError;
      s.proxy!.value.feedsPermanentlyFailed = parked;
      return tile(opsMetricsFrom(s, NOW), 'Proxy Feeds in Error');
    };
    // Production on 2026-10-19: 226 erroring, 155 of them gone or blocked.
    expect(errors(226, 155).status).toBe('healthy');
    expect(errors(226, 155).unit).toBe('155 parked');
    // The same count with nothing parked is a crawler-wide problem brewing.
    expect(errors(226, 0).status).toBe('warning');
    expect(errors(900, 155).status).toBe('error');
    // A crawler-wide 403 parks every feed on the first hit: still red.
    expect(errors(1876, 1876).status).toBe('error');
  });

  it('grades the document stream separately from subscriptions', () => {
    const s = status();
    s.poller!.value.documentsLagMs = 20 * MINUTE;
    const metrics = opsMetricsFrom(s, NOW);
    expect(tile(metrics, 'Document Stream Lag').status).toBe('error');
    // One stream stuck while the other is fine is exactly what a shared number
    // would hide.
    expect(tile(metrics, 'Firehose Lag').status).toBe('healthy');
  });

  it('escalates as capped cycles pile up, and says so when ingest is paused', () => {
    const streak = (n: number) => {
      const s = status();
      s.poller!.value.documentsCapStreak = n;
      return tile(opsMetricsFrom(s, NOW), 'Document Ingest');
    };
    // A burst draining across a couple of cycles is the design working.
    expect(streak(0).value).toBe('Draining');
    expect(streak(1).status).toBe('healthy');
    expect(streak(4).status).toBe('warning');
    expect(streak(12).status).toBe('error');

    const paused = status();
    paused.poller!.value.documentsIngestPaused = true;
    const metrics = opsMetricsFrom(paused, NOW);
    expect(tile(metrics, 'Document Ingest').value).toBe('Disabled');
    // A paused stream's lag climbs by construction; don't render it as a stall.
    expect(tile(metrics, 'Document Stream Lag').value).toBe('Paused');
  });

  it('says "no data" for a backend that predates the document stream', () => {
    const s = status();
    delete s.poller!.value.documentsLagMs;
    expect(tile(opsMetricsFrom(s, NOW), 'Document Stream Lag').value).toBe('No data');
  });

  it('grades frozen document authors by whether re-listing looks broken', () => {
    // The tile is graded the way the backend's alert is graded: a straggler is
    // visible without being an emergency, so the red keeps meaning something.
    const sync = (frozen: number, active: number) => {
      const s = status();
      s.proxy!.value.documentAuthorsFrozen = frozen;
      s.proxy!.value.documentAuthorsActive = active;
      return tile(opsMetricsFrom(s, NOW), 'Document Sync').status;
    };
    expect(sync(0, 296)).toBe('healthy');
    expect(sync(1, 296)).toBe('warning');
    expect(sync(3, 296)).toBe('error');
    // Small population: two of four is systemic even at a low absolute count.
    expect(sync(2, 4)).toBe('error');
  });

  it("ignores the proxy's document firehose once nobody reads through it", () => {
    const sync = (active: number) => {
      const s = status();
      s.proxy!.value.documentAuthorsActive = active;
      s.proxy!.value.documentFirehoseHealthy = false;
      return tile(opsMetricsFrom(s, NOW), 'Document Sync').status;
    };
    // Documents are served from D1, so the proxy has no authors and idles.
    expect(sync(0)).toBe('healthy');
    expect(sync(12)).toBe('warning');
  });

  it('renders a full set of tiles before the cron has ever run', () => {
    const metrics = opsMetricsFrom({ cron: null, poller: null, proxy: null }, NOW);
    expect(metrics).toHaveLength(9);
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

  it('does not open a bucket for an hour that has not happened yet', () => {
    // Healthy collector, 45 minutes into the newest hour: the timeline ends at
    // the hour we're in, not the next one, so there is no trailing gap.
    expect(lagOf([row(NOW), row(NOW + HOUR)], NOW + HOUR + 45 * MINUTE)).toEqual([1000, 1000]);
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
