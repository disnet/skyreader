import type { MetricValue } from '$lib/types';

// Field vitals: how responsive Skyreader is on readers' real devices. The backend
// keeps only daily histograms (`client_vitals`, backend/src/routes/vitals.ts), so
// everything here is a percentile read back from bucket counts. A bucket's
// stored bound is its upper edge, so a percentile is "at most this" — honest to
// the resolution the buckets have, and never a made-up interpolation.

export type VitalMetric = 'inp' | 'cls' | 'blocking';

const METRICS: VitalMetric[] = ['inp', 'cls', 'blocking'];

/** The overflow bucket's bound (anything past the scale). */
const OVERFLOW = 1e9;

/**
 * Good / poor lines. INP and CLS are the web-vitals thresholds; blocking uses
 * Lighthouse's Total Blocking Time lines, which measure the same thing.
 */
const THRESHOLDS: Record<VitalMetric, { good: number; poor: number }> = {
  inp: { good: 200, poor: 500 },
  cls: { good: 0.1, poor: 0.25 },
  blocking: { good: 200, poor: 600 },
};

const LABELS: Record<VitalMetric, string> = {
  inp: 'Interaction delay (INP)',
  cls: 'Layout shift (CLS)',
  blocking: 'Main-thread blocking',
};

export interface BucketRow {
  metric: string;
  route: string;
  bucket_le: number;
  count: number;
}

export interface Bucket {
  le: number;
  count: number;
}

/** The bucket bound at which `p` of the samples are at or under; null with no samples. */
export function percentileFromBuckets(buckets: Bucket[], p: number): number | null {
  const sorted = [...buckets].sort((a, b) => a.le - b.le);
  const total = sorted.reduce((sum, b) => sum + b.count, 0);
  if (total === 0) return null;
  let seen = 0;
  for (const bucket of sorted) {
    seen += bucket.count;
    if (seen >= p * total) return bucket.le;
  }
  return sorted[sorted.length - 1].le;
}

export function formatVital(metric: VitalMetric, value: number | null): string {
  if (value === null) return '—';
  if (value >= OVERFLOW) return metric === 'cls' ? '> 1' : '> 5 s';
  return metric === 'cls' ? `≤ ${value}` : `≤ ${value} ms`;
}

function statusOf(metric: VitalMetric, value: number | null): MetricValue['status'] {
  if (value === null) return undefined;
  const { good, poor } = THRESHOLDS[metric];
  return value <= good ? 'healthy' : value <= poor ? 'warning' : 'error';
}

function bucketsFor(rows: BucketRow[], metric: VitalMetric, route?: string): Bucket[] {
  return rows
    .filter((r) => r.metric === metric && (route === undefined || r.route === route))
    .map((r) => ({ le: r.bucket_le, count: r.count }));
}

function samples(buckets: Bucket[]): number {
  return buckets.reduce((sum, b) => sum + b.count, 0);
}

export interface RouteVitals {
  route: string;
  views: number;
  inp: string;
  cls: string;
  blocking: string;
}

export interface VitalsPanel {
  available: boolean;
  /** One tile per metric: this week's p75, with last week's beside it. */
  metrics: MetricValue[];
  /** p75 per route, busiest first. */
  routes: RouteVitals[];
}

/** Pure: the panel from this week's and last week's bucket rows. */
export function vitalsPanelFrom(thisWeek: BucketRow[], lastWeek: BucketRow[]): VitalsPanel {
  const metrics = METRICS.map((metric): MetricValue => {
    const now = bucketsFor(thisWeek, metric);
    const p75 = percentileFromBuckets(now, 0.75);
    const prior = percentileFromBuckets(bucketsFor(lastWeek, metric), 0.75);
    return {
      label: `${LABELS[metric]} · p75`,
      value: formatVital(metric, p75),
      unit: `${samples(now)} views · last week ${formatVital(metric, prior)}`,
      status: statusOf(metric, p75),
    };
  });

  const routeNames = [...new Set(thisWeek.map((r) => r.route))];
  const routes = routeNames
    .map((route) => {
      const cls = bucketsFor(thisWeek, 'cls', route);
      return {
        route,
        // Every report carries CLS, so its count is the route's view count.
        views: samples(cls),
        inp: formatVital('inp', percentileFromBuckets(bucketsFor(thisWeek, 'inp', route), 0.75)),
        cls: formatVital('cls', percentileFromBuckets(cls, 0.75)),
        blocking: formatVital(
          'blocking',
          percentileFromBuckets(bucketsFor(thisWeek, 'blocking', route), 0.75)
        ),
      };
    })
    .sort((a, b) => b.views - a.views);

  return { available: true, metrics, routes };
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function bucketRows(db: D1Database, from: string, to: string): Promise<BucketRow[]> {
  const result = await db
    .prepare(
      `SELECT metric, route, bucket_le, SUM(count) AS count
         FROM client_vitals
        WHERE day >= ? AND day < ?
        GROUP BY metric, route, bucket_le`
    )
    .bind(from, to)
    .all<BucketRow>();
  return result.results;
}

export async function loadVitals(db: D1Database, now = Date.now()): Promise<VitalsPanel> {
  const DAY = 24 * 60 * 60 * 1000;
  // Today is partial, so both weeks end at the start of a day: tomorrow for this
  // week (it includes today), today for last week.
  const tomorrow = day(now + DAY);
  try {
    const [thisWeek, lastWeek] = await Promise.all([
      bucketRows(db, day(now - 6 * DAY), tomorrow),
      bucketRows(db, day(now - 13 * DAY), day(now - 6 * DAY)),
    ]);
    return vitalsPanelFrom(thisWeek, lastWeek);
  } catch {
    // No table yet: migration 0092 hasn't been applied to this database.
    return { available: false, metrics: [], routes: [] };
  }
}
