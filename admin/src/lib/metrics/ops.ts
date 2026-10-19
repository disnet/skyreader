import type { MetricValue } from '$lib/types';
import {
  getOpsStatus,
  getSnapshots,
  type OpsStatus,
  type ProxyStatsValue,
  type SnapshotRow,
} from '$lib/queries/ops';

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

/**
 * The proxy's own default for the crawl cycle it accepts (DEFAULT_WARM_TARGET_CYCLE_MS),
 * for a row that carries the cycle but not the target.
 */
const DEFAULT_TARGET_CYCLE_SECONDS = 60 * 60;

/**
 * Feeds failing on the short backoff, as a share of the cache. Parked feeds (gone,
 * blocked, or failing for a day) are left out: each is one feed's own problem,
 * shown to its readers, and a few hundred of them is a normal resting state. A
 * crawler-wide fault — DNS, egress, a bad deploy — fails every feed it touches at
 * once, and that is the shape this catches.
 */
const ERROR_WARN_RATIO = 0.1;
const ERROR_ERROR_RATIO = 0.25;
/**
 * Half the cache erroring is red even if it's all parked. A crawler-wide 403
 * (a bad signing key, a WAF on our egress) parks every feed on the first hit,
 * and a long outage pushes transient errors to the daily cap too.
 */
const ERROR_ERROR_RAW_RATIO = 0.5;

/**
 * Frozen document authors worth calling an error rather than a straggler. Keep
 * in step with `DOCUMENT_FROZEN_MIN_AUTHORS` / `DOCUMENT_FROZEN_RATIO` in the
 * backend's ops-metrics, which own the alerting side of the same threshold: a
 * tile that reads red on a count the alert deliberately ignores just teaches
 * people the red means nothing.
 */
const FROZEN_ERROR_AUTHORS = 3;
const FROZEN_ERROR_RATIO = 0.25;

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

const POLLER_LABELS = [
  'Firehose Lag',
  'Last Poll',
  'Poll Errors (last cycle)',
  'Document Stream Lag',
  'Document Ingest',
] as const;

/**
 * Consecutive capped document cycles before the tile goes red. Mirrors the
 * backend's `DOCUMENT_CAP_SATURATION_ALERT_STREAK`: one or two capped cycles is a
 * burst draining exactly as designed, ten in a row is a flood that wants the
 * `documents_ingest_enabled` switch.
 */
const CAP_STREAK_ERROR = 10;
const CAP_STREAK_WARN = 3;

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

  const {
    documentsLagMs,
    documentsCapStreak = 0,
    documentsAuthors = 0,
    documentsIngestPaused = false,
  } = poller.value;

  // The two streams fail independently — one stuck while the other is healthy is
  // exactly what a single "firehose lag" number hides — so documents get their own
  // tile, graded on the same thresholds.
  const documentsLag: MetricValue =
    documentsLagMs === undefined
      ? unknown(POLLER_LABELS[3])
      : documentsIngestPaused
        ? { label: POLLER_LABELS[3], value: 'Paused', status: 'warning' }
        : documentsLagMs === null
          ? { label: POLLER_LABELS[3], value: '—', status: 'warning' }
          : {
              label: POLLER_LABELS[3],
              value: formatAge(documentsLagMs),
              status:
                documentsLagMs >= LAG_ERROR_MS
                  ? 'error'
                  : documentsLagMs >= LAG_WARN_MS
                    ? 'warning'
                    : 'healthy',
            };

  // Cap saturation: how many cycles in a row the drain stopped early. This is the
  // number an operator reads before deciding a burst has become a flood.
  const documentIngest: MetricValue = documentsIngestPaused
    ? { label: POLLER_LABELS[4], value: 'Disabled', status: 'error' }
    : {
        label: POLLER_LABELS[4],
        value: documentsCapStreak === 0 ? 'Draining' : `${documentsCapStreak} capped cycles`,
        unit: `${documentsAuthors} authors`,
        status:
          documentsCapStreak >= CAP_STREAK_ERROR
            ? 'error'
            : documentsCapStreak >= CAP_STREAK_WARN
              ? 'warning'
              : 'healthy',
      };

  return [
    lag,
    lastPoll,
    {
      label: POLLER_LABELS[2],
      value: errors,
      status: errors > 0 ? 'warning' : 'healthy',
    },
    documentsLag,
    documentIngest,
  ];
}

/**
 * Frozen authors, graded the way the alert grades them. A straggler or two is a
 * warning — real, visible, and self-healing on the next poll — and only a count
 * that says re-listing itself has stopped is an error.
 */
function documentSyncMetric(proxy: ProxyStatsValue): MetricValue {
  const frozen = proxy.documentAuthorsFrozen ?? 0;
  const active = proxy.documentAuthorsActive ?? 0;
  const systemic =
    frozen >= FROZEN_ERROR_AUTHORS || (active > 0 && frozen / active >= FROZEN_ERROR_RATIO);
  // With no active authors nobody reads documents through the proxy (they're
  // served from D1), so its firehose idling disconnected is expected, not news.
  const firehoseDown = active > 0 && proxy.documentFirehoseHealthy === false;

  return {
    label: 'Document Sync',
    value: frozen,
    unit: `${active} active · ${proxy.documentAuthorsInBackoff ?? 0} retrying`,
    status: systemic ? 'error' : frozen > 0 || firehoseDown ? 'warning' : 'healthy',
  };
}

const PROXY_LABELS = ['Crawl Cycle', 'Proxy Feeds in Error', 'Document Sync'] as const;

/**
 * How long one pass over the healthy crawl set takes: the delay between a feed
 * publishing and its readers seeing it. This replaced "% of the cache inside its
 * 5-minute TTL", which the deliberately ~8-minute cycle (fly.toml, WARM_BATCH_CAP)
 * can never satisfy and which counted broken and abandoned rows as stale.
 *
 * Amber past the proxy's accepted cycle, red past twice it — the age at which
 * the crawler starts reporting a feed `crawl_stale`.
 */
function crawlCycleMetric(proxy: ProxyStatsValue): MetricValue {
  const cycle = proxy.crawlCycleSeconds;
  if (cycle === undefined || cycle === null) {
    return { label: PROXY_LABELS[0], value: 'Not reported', status: 'warning' };
  }
  // Every in-set feed broken (or nothing in the set): nothing is being crawled.
  if (cycle === 0) return { label: PROXY_LABELS[0], value: 'No healthy feeds', status: 'error' };

  const target = proxy.crawlTargetCycleSeconds || DEFAULT_TARGET_CYCLE_SECONDS;
  return {
    label: PROXY_LABELS[0],
    value: formatAge(cycle * 1000),
    unit: `target ${formatAge(target * 1000)}`,
    status: cycle > 2 * target ? 'error' : cycle > target ? 'warning' : 'healthy',
  };
}

function feedErrorsMetric(proxy: ProxyStatsValue): MetricValue {
  const { total, feedsInError, feedsPermanentlyFailed } = proxy;
  const failing = Math.max(feedsInError - feedsPermanentlyFailed, 0);
  const ratio = total > 0 ? failing / total : 0;
  const rawRatio = total > 0 ? feedsInError / total : 0;
  return {
    label: PROXY_LABELS[1],
    value: feedsInError,
    unit: feedsPermanentlyFailed > 0 ? `${feedsPermanentlyFailed} parked` : undefined,
    status:
      ratio >= ERROR_ERROR_RATIO || rawRatio >= ERROR_ERROR_RAW_RATIO
        ? 'error'
        : ratio >= ERROR_WARN_RATIO
          ? 'warning'
          : 'healthy',
  };
}

function proxyMetrics(status: OpsStatus, now: number): MetricValue[] {
  const proxy = status.proxy;
  if (!proxy) return PROXY_LABELS.map((label) => unknown(label));

  // Nobody refreshed these, so don't dress them up as current.
  const rowAge = now - proxy.updatedAt;
  if (rowAge > PROXY_STALE_MS) return PROXY_LABELS.map((label) => stale(label, rowAge));

  return [
    crawlCycleMetric(proxy.value),
    feedErrorsMetric(proxy.value),
    documentSyncMetric(proxy.value),
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
  // Same number as the live tile above, hour by hour: per-feed fetch errors are
  // the crawler's to know, so this series is empty for any hour whose proxy
  // stats were missing or stale.
  { key: 'feeds_with_errors', label: 'Proxy Feeds in Error' },
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
  //
  // `now` is a wall clock instant rather than a bucketed timestamp, so it floors
  // to the hour it falls in. Rounding it would open a bucket for an hour that
  // hasn't happened yet from :30 onward — a trailing gap on a healthy collector,
  // which is the opposite of what the gap is supposed to mean.
  const nowBucket = Math.floor((now - from) / HOUR_MS);
  const count = Math.min(Math.max(nowBucket, bucketOf(to)) + 1, MAX_BUCKETS);
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
