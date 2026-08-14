import type { MetricValue } from '$lib/types';
import { getOpsStatus, getSnapshots, type OpsStatus, type SnapshotRow } from '$lib/queries/ops';

// The "is Skyreader healthy right now" tiles. Everything here comes from rows the
// every-minute cron writes, so a value that stops moving is itself the signal:
// staleness is treated as an error rather than rendered as a confident number.

/** The cron runs every minute; two missed runs is a problem, ten is an outage. */
const CRON_WARN_MS = 3 * 60 * 1000;
const CRON_ERROR_MS = 10 * 60 * 1000;

/** Mirrors the backend's alert threshold (FIREHOSE_LAG_ALERT_MS) and the 5-min SLO. */
const LAG_WARN_MS = 5 * 60 * 1000;
const LAG_ERROR_MS = 15 * 60 * 1000;

/** Mirrors POLLER_STALE_MS in the backend's deep health check. */
const POLL_STALE_MS = 5 * 60 * 1000;

/**
 * How old the `poller_status` *row* may be before its numbers stop being facts.
 * The cron rewrites it every minute, so this catches the case the tile values
 * can't see themselves: the cron is alive but its DO `/status` fetch keeps
 * failing, leaving yesterday's lag sitting in D1 looking green. Same 5 minutes
 * as POLL_STALE_MS — one missed minute is a blip, five is a broken collector.
 */
const POLLER_ROW_STALE_MS = 5 * 60 * 1000;

/** Proxy stats refresh every 5 minutes; past this the numbers are history. */
const PROXY_STALE_MS = 15 * 60 * 1000;

/** The plan's starter SLO: ≥95% of cached feeds within TTL. */
const FRESH_WARN_PCT = 95;
const FRESH_ERROR_PCT = 80;

export function formatAge(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

const unknown = (label: string, note = 'No data'): MetricValue => ({
  label,
  value: note,
  status: 'error',
});

/** The one thing these tiles must never do: show a number nobody refreshed. */
const stale = (label: string, ageMs: number): MetricValue =>
  unknown(label, `Stale (${formatAge(ageMs)})`);

function cronMetric(status: OpsStatus, now: number): MetricValue {
  const cron = status.cron;
  if (!cron) return unknown('Cron Last Run', 'Never');

  const age = now - cron.value.at;
  const stale = age > CRON_ERROR_MS;
  return {
    label: 'Cron Last Run',
    value: `${formatAge(age)} ago`,
    // A run that finished with failures is as interesting as one that never
    // happened — it's the same condition the dead-man's switch withholds on.
    status: stale || !cron.value.healthy ? 'error' : age > CRON_WARN_MS ? 'warning' : 'healthy',
  };
}

const POLLER_LABELS = ['Firehose Lag', 'Last Poll', 'Poll Errors (last cycle)'] as const;

function pollerMetrics(status: OpsStatus, now: number): MetricValue[] {
  const poller = status.poller;
  if (!poller) return POLLER_LABELS.map((label) => unknown(label));

  // Age of the row, not of the values inside it. `Last Poll` carries its own
  // timestamp and would eventually go red on its own, but `Firehose Lag` and
  // `Poll Errors` are frozen snapshots: if the collector stopped, they keep
  // reading green forever. Grade all three on the row instead.
  const rowAge = now - poller.updatedAt;
  if (rowAge > POLLER_ROW_STALE_MS) return POLLER_LABELS.map((label) => stale(label, rowAge));

  const { lagMs, lastPollAt, errors } = poller.value;
  const lag: MetricValue =
    lagMs === null
      ? { label: 'Firehose Lag', value: '—', status: 'warning' }
      : {
          label: 'Firehose Lag',
          value: formatAge(lagMs),
          status: lagMs >= LAG_ERROR_MS ? 'error' : lagMs >= LAG_WARN_MS ? 'warning' : 'healthy',
        };

  const pollAge = lastPollAt === null ? null : now - lastPollAt;
  const lastPoll: MetricValue =
    pollAge === null
      ? { label: 'Last Poll', value: 'Never', status: 'warning' }
      : {
          label: 'Last Poll',
          value: `${formatAge(pollAge)} ago`,
          status: pollAge > POLL_STALE_MS ? 'error' : 'healthy',
        };

  return [
    lag,
    lastPoll,
    {
      label: POLLER_LABELS[2],
      value: errors,
      status: errors > 0 ? 'warning' : 'healthy',
    },
  ];
}

function proxyMetrics(status: OpsStatus, now: number): MetricValue[] {
  const proxy = status.proxy;
  if (!proxy) return [unknown('Proxy Cache Fresh'), unknown('Proxy Feeds in Error')];

  // Nobody refreshed these, so don't dress them up as current.
  const rowAge = now - proxy.updatedAt;
  if (rowAge > PROXY_STALE_MS) {
    return [stale('Proxy Cache Fresh', rowAge), stale('Proxy Feeds in Error', rowAge)];
  }

  const { freshPct, total, feedsInError, feedsPermanentlyFailed } = proxy.value;
  return [
    freshPct === null
      ? { label: 'Proxy Cache Fresh', value: 'Empty cache', status: 'warning' }
      : {
          label: 'Proxy Cache Fresh',
          value: freshPct,
          unit: `% of ${total}`,
          status:
            freshPct < FRESH_ERROR_PCT
              ? 'error'
              : freshPct < FRESH_WARN_PCT
                ? 'warning'
                : 'healthy',
        },
    {
      label: 'Proxy Feeds in Error',
      value: feedsInError,
      unit: feedsPermanentlyFailed > 0 ? `${feedsPermanentlyFailed} permanent` : undefined,
      status: feedsPermanentlyFailed > 0 ? 'error' : feedsInError > 0 ? 'warning' : 'healthy',
    },
  ];
}

export function opsMetricsFrom(status: OpsStatus, now = Date.now()): MetricValue[] {
  return [cronMetric(status, now), ...pollerMetrics(status, now), ...proxyMetrics(status, now)];
}

export interface TrendSeries {
  key: string;
  label: string;
  unit?: string;
  /** Hourly points, oldest first. Null means "not recorded", not zero. */
  points: (number | null)[];
}

const seriesDefinitions: { key: keyof SnapshotRow; label: string; unit?: string }[] = [
  { key: 'users', label: 'Users' },
  { key: 'active_sessions', label: 'Active Sessions' },
  { key: 'feeds', label: 'Feeds' },
  { key: 'feeds_with_errors', label: 'Feeds with Errors' },
  { key: 'subscriptions', label: 'Subscriptions' },
  { key: 'saved_articles', label: 'Saved Articles' },
  { key: 'feed_items', label: 'Feed Items' },
  { key: 'firehose_lag_ms', label: 'Firehose Lag', unit: 'ms' },
  { key: 'proxy_fresh_pct', label: 'Proxy Cache Fresh', unit: '%' },
];

const HOUR_MS = 60 * 60 * 1000;

/** 30 days of hourly points is what the query asks for; refuse to allocate past a
 *  sane ceiling if a stray `captured_at` ever lands in the future. */
const MAX_BUCKETS = 24 * 45;

/**
 * One point per hour between the oldest and newest snapshot — including the hours
 * that have no row at all.
 *
 * Mapping rows straight to points would draw an hour the cron missed as no point
 * rather than as a gap, so a two-day outage would render as an unbroken line
 * between the snapshots on either side of it. The whole reason these charts are
 * worth having is that a flat line means "nothing changed" and not "nobody
 * looked"; only a timeline with holes in it can tell those apart.
 */
export function trendsFrom(
  rows: SnapshotRow[],
  now = Date.now()
): {
  from: number | null;
  to: number | null;
  series: TrendSeries[];
} {
  const from = rows[0]?.captured_at ?? null;
  const to = rows[rows.length - 1]?.captured_at ?? null;

  const empty = seriesDefinitions.map(({ key, label, unit }) => ({
    key,
    label,
    unit,
    points: [] as (number | null)[],
  }));
  if (from === null || to === null) return { from, to, series: empty };

  // captured_at is already bucketed to the top of the hour by the cron that
  // writes it, so this index is exact rather than approximate.
  const bucketOf = (capturedAt: number) => Math.round((capturedAt - from) / HOUR_MS);
  // End at the current hour, not the newest row. Otherwise collection stopping
  // is invisible until it resumes: an old value still sits at the chart edge.
  const count = Math.min(Math.max(bucketOf(now), bucketOf(to)) + 1, MAX_BUCKETS);
  const byBucket = new Map(rows.map((row) => [bucketOf(row.captured_at), row]));

  return {
    from,
    to,
    series: seriesDefinitions.map(({ key, label, unit }) => ({
      key,
      label,
      unit,
      points: Array.from({ length: count }, (_, bucket) => {
        const row = byBucket.get(bucket);
        return row ? ((row[key] as number | null) ?? null) : null;
      }),
    })),
  };
}

export interface OpsData {
  /** False when migration 0067 hasn't reached this database yet. */
  available: boolean;
  metrics: MetricValue[];
  trends: ReturnType<typeof trendsFrom>;
}

export async function loadOps(db: D1Database): Promise<OpsData> {
  try {
    const [status, snapshots] = await Promise.all([getOpsStatus(db), getSnapshots(db)]);
    return { available: true, metrics: opsMetricsFrom(status), trends: trendsFrom(snapshots) };
  } catch {
    // Almost always "no such table": the admin deploys independently of the
    // backend's migrations. Say so on the page rather than showing zeroes.
    return { available: false, metrics: [], trends: { from: null, to: null, series: [] } };
  }
}
